import { execFile } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

/**
 * Creates and deletes stores. Each store is its own namespace holding one Helm
 * release of our platform chart (store + its woo-mcp server only), with its
 * own ResourceQuota and LimitRange. This is the only component with Kubernetes
 * write access, and an admission policy limits it to namespaces it labelled;
 * the gateway asks it over HTTP with a shared token.
 *
 * The namespace is the record of a store: its labels say it is ours, its
 * annotations hold the owner, the creation time and the last failure, so the
 * state survives a provisioner restart.
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
  // Store "bakery" lives in namespace <prefix>bakery.
  namespacePrefix: required('NAMESPACE_PREFIX'),
  // Value of the label that marks a namespace as one of our stores.
  owner: required('OWNER_ID'),
  // ServiceAccount the store namespaces grant the tenant role to (this pod's).
  serviceAccount: required('SERVICE_ACCOUNT'),
  serviceAccountNamespace: required('SERVICE_ACCOUNT_NAMESPACE'),
  tenantRole: required('TENANT_CLUSTER_ROLE'),
  domain: required('DOMAIN'),
  tls: process.env.TLS === 'true',
  maxStores: Number(process.env.MAX_STORES ?? 3),
  parallel: Math.max(1, Number(process.env.PARALLEL_INSTALLS ?? 2)),
  installTimeoutSec: Number(process.env.INSTALL_TIMEOUT_SECONDS ?? 600),
  quota: JSON.parse(process.env.STORE_QUOTA ?? '{}') as Record<string, string>,
  limitRange: JSON.parse(process.env.STORE_LIMIT_RANGE ?? '{}') as Record<string, unknown>,
  chart: process.env.CHART_PATH ?? '/charts/platform',
  // Shared settings for every store (images, sizes, domain, gateway location).
  valuesFile: process.env.VALUES_FILE ?? '/config/store-values.yaml',
};

const RELEASE_PREFIX = 'store-';
const LABEL = 'urumi.io/stores-of';
const NAME_LABEL = 'urumi.io/store';
const A_OWNER = 'urumi.io/owner';
const A_CREATED = 'urumi.io/created-at';
const A_ERROR = 'urumi.io/error';
// Short DNS-safe names: they become a hostname, a namespace, a Helm release and a tool prefix.
const NAME = /^[a-z][a-z0-9]{1,14}$/;
const RESERVED = new Set(['woo', 'utils', 'deepwiki', 'gateway', 'store', 'www', 'admin', 'api', 'mcp', 'platform']);

type State = 'creating' | 'ready' | 'failed' | 'deleting';

interface StoreInfo {
  name: string;
  namespace: string;
  state: State;
  message: string;
  owner: string;
  created_at: string | null;
  url: string;
  admin_url: string;
  mcp_url: string;
}

// Operations running in this process. Anything else is read from the cluster.
const jobs = new Map<string, { state: State; message: string }>();

// At most config.parallel Helm installs at once, so several stores can be
// provisioned together without starving a small node.
let running = 0;
const waiting: (() => void)[] = [];
async function limited<T>(task: () => Promise<T>): Promise<T> {
  if (running >= config.parallel) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  try {
    return await task();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

async function exec(cmd: string, args: string[], timeoutMs = 60_000): Promise<string> {
  try {
    const { stdout } = await run(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message: string; killed?: boolean };
    if (e.killed) throw new Error(`${cmd} timed out after ${Math.round(timeoutMs / 1000)}s`);
    throw new Error((e.stderr || e.message).trim().split('\n').slice(-3).join(' '));
  }
}

/** kubectl apply of in-memory objects, through a private temp file. */
async function apply(objects: unknown[]): Promise<void> {
  await withTempFile({ apiVersion: 'v1', kind: 'List', items: objects }, (file) => exec('kubectl', ['apply', '-f', file]));
}

async function withTempFile<T>(content: unknown, fn: (file: string) => Promise<T>): Promise<T> {
  // Values (including the MCP token) go in a file, not argv, so they never
  // show up in a process listing.
  const dir = await mkdtemp(path.join(tmpdir(), 'prov-'));
  const file = path.join(dir, 'data.json');
  try {
    await writeFile(file, JSON.stringify(content), { mode: 0o600 });
    return await fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const nsOf = (name: string) => `${config.namespacePrefix}${name}`;

async function annotate(name: string, key: string, value: string | null): Promise<boolean> {
  try {
    await exec('kubectl', ['annotate', 'namespace', nsOf(name), '--overwrite', value === null ? `${key}-` : `${key}=${value}`]);
    return true;
  } catch (err) {
    console.error(`annotate ${name}:`, (err as Error).message);
    return false;
  }
}

function describe(name: string, state: State, message: string, owner = '', createdAt: string | null = null): StoreInfo {
  const scheme = config.tls ? 'https' : 'http';
  return {
    name,
    namespace: nsOf(name),
    state,
    message,
    owner,
    created_at: createdAt,
    url: `${scheme}://${name}.${config.domain}`,
    admin_url: `${scheme}://${name}.${config.domain}/wp-admin`,
    mcp_url: `http://${RELEASE_PREFIX}${name}-woo-mcp.${nsOf(name)}:3000/mcp`,
  };
}

interface Namespace {
  metadata: { labels?: Record<string, string>; annotations?: Record<string, string>; creationTimestamp: string };
  status?: { phase?: string };
}

async function helmStatus(name: string): Promise<string | null> {
  const out = await exec('helm', ['list', '-n', nsOf(name), '--all', '-o', 'json', '--filter', `^${RELEASE_PREFIX}${name}$`], 30_000);
  const list = JSON.parse(out || '[]') as { status: string }[];
  return list[0]?.status ?? null;
}

async function inspect(name: string, ns: Namespace): Promise<StoreInfo> {
  const a = ns.metadata.annotations ?? {};
  const info = (state: State, message: string) => describe(name, state, message, a[A_OWNER] ?? '', a[A_CREATED] ?? ns.metadata.creationTimestamp);
  const job = jobs.get(name);
  if (job) return info(job.state, job.message);
  if (ns.status?.phase === 'Terminating') return info('deleting', 'removing the namespace, its volumes and secrets');
  if (a[A_ERROR]) return info('failed', a[A_ERROR]);
  const status = await helmStatus(name).catch(() => null);
  if (status === 'deployed') return info('ready', '');
  if (status === 'failed') return info('failed', 'helm install failed');
  // Not deployed, nothing running here: the provisioner restarted mid-install
  // (Helm runs as our child process, so it died with us).
  if (status) return info('failed', `interrupted: the provisioner restarted during the install (${status}); retry or delete`);
  return info('failed', 'interrupted before the Helm install started; retry or delete');
}

async function listStores(): Promise<StoreInfo[]> {
  const out = await exec('kubectl', ['get', 'namespaces', '-l', `${LABEL}=${config.owner}`, '-o', 'json'], 30_000);
  const items = (JSON.parse(out) as { items: Namespace[] }).items;
  const found = await Promise.all(items.map((ns) => inspect(ns.metadata.labels![NAME_LABEL], ns)));
  // Requests accepted but whose namespace does not exist yet.
  const seen = new Set(found.map((s) => s.name));
  for (const [name, job] of jobs) if (!seen.has(name)) found.push(describe(name, job.state, job.message));
  return found.sort((x, y) => x.name.localeCompare(y.name));
}

/** The namespace, its quota and limits, and the tenant role for us inside it. */
async function prepareNamespace(name: string, owner: string): Promise<void> {
  const namespace = nsOf(name);
  const meta = (n: string) => ({ name: n, namespace, labels: { [LABEL]: config.owner, [NAME_LABEL]: name } });
  await apply([
    {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name: namespace,
        labels: { [LABEL]: config.owner, [NAME_LABEL]: name },
        annotations: { [A_OWNER]: owner, [A_CREATED]: new Date().toISOString() },
      },
    },
  ]);
  await apply([
    { apiVersion: 'v1', kind: 'ResourceQuota', metadata: meta('store-quota'), spec: { hard: config.quota } },
    { apiVersion: 'v1', kind: 'LimitRange', metadata: meta('store-limits'), spec: { limits: [{ type: 'Container', ...config.limitRange }] } },
    {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'RoleBinding',
      metadata: meta('provisioner'),
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: config.tenantRole },
      subjects: [{ kind: 'ServiceAccount', name: config.serviceAccount, namespace: config.serviceAccountNamespace }],
    },
  ]);
}

/** Removes a half-installed release and its data, keeping the namespace. */
async function resetNamespace(name: string): Promise<void> {
  const namespace = nsOf(name);
  // A failed setup Job is a Helm hook, which uninstall leaves behind; it
  // would keep the content volume in use, so remove it first.
  await exec('kubectl', ['-n', namespace, 'delete', 'jobs', '--all', '--ignore-not-found', '--wait=true'], 120_000);
  await exec('helm', ['uninstall', `${RELEASE_PREFIX}${name}`, '-n', namespace, '--wait', '--timeout', '5m', '--ignore-not-found'], 6 * 60_000);
  await exec('kubectl', ['-n', namespace, 'delete', 'pvc', '--all', '--ignore-not-found', '--wait=true'], 120_000);
}

async function install(name: string, owner: string, perStore: Record<string, unknown>, retry: boolean): Promise<void> {
  const step = (message: string) => jobs.set(name, { state: 'creating', message });
  try {
    if (retry) {
      step('cleaning up the failed attempt');
      await resetNamespace(name);
    }
    step('creating the namespace, quota and limits');
    await prepareNamespace(name, owner);
    await annotate(name, A_ERROR, null);
    step('installing WordPress, the database and the store MCP server');
    await withTempFile(perStore, (file) =>
      exec(
        'helm',
        [
          'upgrade', '--install', `${RELEASE_PREFIX}${name}`, config.chart,
          '-n', nsOf(name),
          '-f', config.valuesFile,
          '-f', file,
          '--wait', '--timeout', `${config.installTimeoutSec}s`,
        ],
        (config.installTimeoutSec + 60) * 1000,
      ),
    );
    jobs.delete(name);
    console.log(`store '${name}' ready`);
  } catch (err) {
    const message = `provisioning failed: ${(err as Error).message}`.slice(0, 500);
    console.error(`store '${name}':`, message);
    // Kept on the namespace, so the reason survives a restart.
    if (await annotate(name, A_ERROR, message)) jobs.delete(name);
    else jobs.set(name, { state: 'failed', message });
  }
}

async function uninstall(name: string): Promise<void> {
  jobs.set(name, { state: 'deleting', message: 'removing the namespace, its volumes and secrets' });
  try {
    // Everything of a store lives in its namespace: release, PVCs, Secrets, Ingress.
    await exec('kubectl', ['delete', 'namespace', nsOf(name), '--ignore-not-found', '--wait=true', '--timeout=5m'], 6 * 60_000);
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
  // Starter products: a key of store.catalogs in the chart. Unset = the chart default.
  catalog: z.string().regex(/^[a-z]{1,20}$/).optional(),
});

function storeValues(body: z.infer<typeof createBody>): Record<string, unknown> {
  const { name, token, title, admin_email, catalog } = body;
  return {
    store: {
      host: name,
      site: { title: title ?? `${name[0].toUpperCase()}${name.slice(1)} Store` },
      ...(admin_email ? { admin: { email: admin_email } } : {}),
      ...(catalog ? { catalog } : {}),
    },
    'woo-mcp': { storeHost: name },
    secrets: { wooMcpToken: token },
  };
}

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
  const { name } = parsed.data;
  if (RESERVED.has(name)) {
    res.status(400).json({ error: `'${name}' is reserved` });
    return;
  }
  const existing = await listStores();
  const same = existing.find((s) => s.name === name);
  // Safe to retry: a request for a store that is already on its way is a no-op.
  if (same && same.state !== 'failed') {
    res.status(same.state === 'deleting' ? 409 : 202).json(same.state === 'deleting' ? { error: `store '${name}' is being deleted` } : same);
    return;
  }
  if (!same && existing.filter((s) => s.state !== 'deleting').length >= config.maxStores) {
    res.status(409).json({ error: `store limit reached (${config.maxStores}); delete one first` });
    return;
  }

  const owner = parsed.data.admin_email ?? '';
  jobs.set(name, { state: 'creating', message: same ? 'retry queued' : 'queued' });
  void limited(() => install(name, owner, storeValues(parsed.data), Boolean(same)));
  res.status(202).json(describe(name, 'creating', 'queued', owner));
});

app.delete('/stores/:name', async (req, res) => {
  const name = req.params.name;
  if (!NAME.test(name)) {
    res.status(400).json({ error: 'invalid name' });
    return;
  }
  const store = (await listStores()).find((s) => s.name === name);
  if (!store) {
    res.status(404).json({ error: 'no such store' });
    return;
  }
  if (store.state === 'creating') {
    res.status(409).json({ error: `store '${name}' is still being created; delete it when it is ready or failed` });
    return;
  }
  void uninstall(name);
  res.status(202).json(describe(name, 'deleting', 'queued', store.owner, store.created_at));
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: err instanceof Error ? err.message : 'internal error' });
});

const server = app.listen(config.port, () => console.log(`provisioner listening on :${config.port}, namespaces ${config.namespacePrefix}*`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
