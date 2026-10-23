import { execFile } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

/**
 * Creates and deletes stores. Each store is its own Helm release of our
 * platform chart (store + its woo-mcp server only) in a dedicated namespace.
 * This is the only component with Kubernetes write access, and only there;
 * the gateway asks it over HTTP with a shared token.
 */

const run = promisify(execFile);

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var ${name}`);
  return value;
}

const config = {
  port: Number(process.env.PORT ?? 3000),
  token: required('PROVISIONER_TOKEN'),
  namespace: required('STORES_NAMESPACE'),
  domain: required('DOMAIN'),
  tls: process.env.TLS === 'true',
  maxStores: Number(process.env.MAX_STORES ?? 3),
  chart: process.env.CHART_PATH ?? '/charts/platform',
  // Shared settings for every store (images, sizes, domain, gateway location).
  valuesFile: process.env.VALUES_FILE ?? '/config/store-values.yaml',
  installTimeout: process.env.INSTALL_TIMEOUT ?? '15m',
};

const PREFIX = 'store-';
// Short DNS-safe names: they become a hostname, a Helm release and a tool prefix.
const NAME = /^[a-z][a-z0-9]{1,14}$/;
const RESERVED = new Set(['woo', 'utils', 'deepwiki', 'gateway', 'store', 'www', 'admin', 'api', 'mcp', 'platform']);

type State = 'creating' | 'ready' | 'failed' | 'deleting';

interface StoreInfo {
  name: string;
  state: State;
  message: string;
  url: string;
  admin_url: string;
  mcp_url: string;
}

// In-flight and failed operations; Helm itself is the record of what exists.
const jobs = new Map<string, { state: State; message: string }>();

// Helm operations run one at a time, so two installs never race for the node.
let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task);
  queue = next.catch(() => undefined);
  return next;
}

async function exec(cmd: string, args: string[], timeoutMs = 20 * 60_000): Promise<string> {
  try {
    const { stdout } = await run(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new Error((e.stderr || e.message).trim().split('\n').slice(-3).join(' '));
  }
}

function describe(name: string, state: State, message = ''): StoreInfo {
  const scheme = config.tls ? 'https' : 'http';
  return {
    name,
    state,
    message,
    url: `${scheme}://${name}.${config.domain}`,
    admin_url: `${scheme}://${name}.${config.domain}/wp-admin`,
    mcp_url: `http://${PREFIX}${name}-woo-mcp.${config.namespace}:3000/mcp`,
  };
}

async function releases(): Promise<Map<string, string>> {
  const out = await exec('helm', ['list', '-n', config.namespace, '--all', '-o', 'json', '--filter', `^${PREFIX}`], 30_000);
  const list = JSON.parse(out || '[]') as { name: string; status: string }[];
  return new Map(list.map((r) => [r.name.slice(PREFIX.length), r.status]));
}

function stateFromHelm(status: string): State {
  if (status === 'deployed') return 'ready';
  if (status === 'failed') return 'failed';
  if (status === 'uninstalling') return 'deleting';
  return 'creating'; // pending-install, pending-upgrade
}

async function listStores(): Promise<StoreInfo[]> {
  const helm = await releases();
  const names = new Set([...helm.keys(), ...jobs.keys()]);
  return [...names].sort().map((name) => {
    const job = jobs.get(name);
    if (job) return describe(name, job.state, job.message);
    return describe(name, stateFromHelm(helm.get(name)!));
  });
}

async function install(name: string, perStore: Record<string, unknown>): Promise<void> {
  // Per-store values (including the MCP token) go in a temp file, not argv,
  // so they never show up in a process listing.
  const dir = await mkdtemp(path.join(tmpdir(), `store-${name}-`));
  const file = path.join(dir, 'values.json');
  try {
    await writeFile(file, JSON.stringify(perStore), { mode: 0o600 });
    jobs.set(name, { state: 'creating', message: 'installing WordPress, the database and the store MCP server' });
    await exec('helm', [
      'install', `${PREFIX}${name}`, config.chart,
      '-n', config.namespace,
      '-f', config.valuesFile,
      '-f', file,
      '--wait', '--timeout', config.installTimeout,
    ]);
    jobs.delete(name);
    console.log(`store '${name}' ready`);
  } catch (err) {
    jobs.set(name, { state: 'failed', message: (err as Error).message });
    console.error(`store '${name}' failed:`, (err as Error).message);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function uninstall(name: string): Promise<void> {
  const release = `${PREFIX}${name}`;
  const label = `app.kubernetes.io/instance=${release}`;
  jobs.set(name, { state: 'deleting', message: 'removing the store and its data' });
  try {
    // A failed setup Job is a Helm hook, which uninstall leaves behind; it
    // would keep the content volume in use, so remove it first.
    await exec('kubectl', ['-n', config.namespace, 'delete', 'job', '-l', label, '--ignore-not-found', '--wait=true'], 120_000);
    await exec('helm', ['uninstall', release, '-n', config.namespace, '--wait', '--timeout', '5m', '--ignore-not-found']);
    // The database volume comes from a StatefulSet template, which Helm does not delete.
    await exec('kubectl', ['-n', config.namespace, 'delete', 'pvc', `data-${release}-store-mariadb-0`, '--ignore-not-found'], 120_000);
    jobs.delete(name);
    console.log(`store '${name}' deleted`);
  } catch (err) {
    jobs.set(name, { state: 'failed', message: `delete failed: ${(err as Error).message}` });
  }
}

// ---- HTTP API (called by the gateway only; NetworkPolicy + token)

const expected = createHash('sha256').update(config.token).digest();
function requireToken(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? '';
  const given = createHash('sha256').update(header.startsWith('Bearer ') ? header.slice(7) : '').digest();
  if (!timingSafeEqual(given, expected)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

const createBody = z.object({
  name: z.string().regex(NAME, 'name: 2-15 lowercase letters or digits, starting with a letter'),
  // Bearer token the store's MCP server will require; generated by the gateway.
  token: z.string().min(32).max(256),
  title: z.string().min(1).max(80).optional(),
  admin_email: z.string().email().optional(),
});

const app = express();
app.use(express.json({ limit: '64kb' }));

app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

app.use('/stores', requireToken);

app.get('/stores', async (_req, res) => {
  res.json(await listStores());
});

app.get('/stores/:name', async (req, res) => {
  const store = (await listStores()).find((s) => s.name === req.params.name);
  if (!store) {
    res.status(404).json({ error: 'no such store' });
    return;
  }
  res.json(store);
});

app.post('/stores', async (req, res) => {
  const parsed = createBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join('; ') });
    return;
  }
  const { name, token, title, admin_email } = parsed.data;
  if (RESERVED.has(name)) {
    res.status(400).json({ error: `'${name}' is reserved` });
    return;
  }
  const existing = await listStores();
  if (existing.some((s) => s.name === name)) {
    res.status(409).json({ error: `store '${name}' already exists` });
    return;
  }
  if (existing.filter((s) => s.state !== 'deleting').length >= config.maxStores) {
    res.status(409).json({ error: `store limit reached (${config.maxStores}); delete one first` });
    return;
  }

  jobs.set(name, { state: 'creating', message: 'queued' });
  void enqueue(() =>
    install(name, {
      store: { host: name, site: { title: title ?? `${name[0].toUpperCase()}${name.slice(1)} Store` }, ...(admin_email ? { admin: { email: admin_email } } : {}) },
      'woo-mcp': { storeHost: name },
      secrets: { wooMcpToken: token },
    }),
  );
  res.status(202).json(describe(name, 'creating', 'queued'));
});

app.delete('/stores/:name', async (req, res) => {
  const name = req.params.name;
  if (!NAME.test(name)) {
    res.status(400).json({ error: 'invalid name' });
    return;
  }
  if (!(await listStores()).some((s) => s.name === name)) {
    res.status(404).json({ error: 'no such store' });
    return;
  }
  jobs.set(name, { state: 'deleting', message: 'queued' });
  void enqueue(() => uninstall(name));
  res.status(202).json(describe(name, 'deleting', 'queued'));
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: err instanceof Error ? err.message : 'internal error' });
});

const server = app.listen(config.port, () => console.log(`provisioner listening on :${config.port}, namespace ${config.namespace}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
