import { HttpError, type User } from './auth.js';
import { config } from './config.js';
import { query } from './db.js';
import { decrypt, encrypt, newToken } from './security.js';
import { allowInternalHost } from './ssrf.js';
import type { ServerRow, UpstreamManager } from './upstreams.js';

type State = 'creating' | 'ready' | 'failed' | 'deleting';

interface ProvisionedStore {
  name: string;
  state: State;
  message: string;
  url: string;
  admin_url: string;
  mcp_url: string;
}

interface StoreRow {
  name: string;
  token_enc: string;
  server_id: number | null;
  created_by: number | null;
  created_at: string;
}

const NAME = /^[a-z][a-z0-9]{1,14}$/;

/**
 * Extra stores: one Helm release and one MCP server per store. The provisioner
 * creates the Kubernetes side; once a store is ready, this registers its MCP
 * server like any other upstream, so status, policy and audit apply per store.
 */
export class StoreService {
  private timer?: NodeJS.Timeout;

  constructor(private readonly upstreams: UpstreamManager) {}

  get enabled(): boolean {
    return Boolean(config.provisionerUrl && config.provisionerToken);
  }

  /** Allow already-registered store hosts, then keep checking pending stores. */
  async start(): Promise<void> {
    if (!this.enabled) return;
    const rows = await query<{ url: string }>('SELECT s.url FROM stores st JOIN servers s ON s.id = st.server_id');
    for (const r of rows) allowInternalHost(new URL(r.url).hostname);
    this.timer = setInterval(() => void this.reconcile().catch((err) => console.error('store reconcile', err)), 10_000);
    this.timer.unref();
  }

  async list() {
    this.require();
    const [provisioned, rows, users] = await Promise.all([
      this.call<ProvisionedStore[]>('GET', '/stores'),
      query<StoreRow>('SELECT * FROM stores'),
      query<{ id: number; email: string }>('SELECT id, email FROM users'),
    ]);
    const servers = new Map(this.upstreams.describe().map((s) => [s.id, s]));
    const byName = new Map(rows.map((r) => [r.name, r]));
    return provisioned.map((p) => {
      const row = byName.get(p.name);
      const server = row?.server_id ? servers.get(row.server_id) : undefined;
      return {
        ...p,
        created_at: row?.created_at ?? null,
        created_by: users.find((u) => u.id === row?.created_by)?.email ?? null,
        server: server ? { id: server.id, slug: server.slug, status: server.status, tools: server.tools.length } : null,
      };
    });
  }

  async create(name: string, user: User): Promise<ProvisionedStore> {
    this.require();
    if (!NAME.test(name)) throw new HttpError(400, 'name: 2-15 lowercase letters or digits, starting with a letter');
    if (this.upstreams.bySlug(name)) throw new HttpError(409, `a server with slug '${name}' already exists`);

    const token = newToken();
    const inserted = await query(
      `INSERT INTO stores (name, token_enc, created_by) VALUES ($1, $2, $3) ON CONFLICT (name) DO NOTHING RETURNING name`,
      [name, encrypt(token), user.id],
    );
    if (!inserted.length) throw new HttpError(409, `store '${name}' already exists`);
    try {
      return await this.call<ProvisionedStore>('POST', '/stores', { name, token, admin_email: user.email });
    } catch (err) {
      await query('DELETE FROM stores WHERE name = $1', [name]);
      throw err;
    }
  }

  async remove(name: string): Promise<void> {
    this.require();
    await this.call('DELETE', `/stores/${encodeURIComponent(name)}`);
    // Its tools vanish now; the Kubernetes side is torn down in the background.
    const [row] = await query<StoreRow>('DELETE FROM stores WHERE name = $1 RETURNING *', [name]);
    if (row?.server_id) {
      await query('DELETE FROM servers WHERE id = $1', [row.server_id]);
      await this.upstreams.remove(row.server_id);
    }
  }

  /** Registers the MCP server of every store that has become ready. */
  private async reconcile(): Promise<void> {
    const pending = await query<StoreRow>('SELECT * FROM stores WHERE server_id IS NULL');
    if (!pending.length) return;
    const provisioned = new Map((await this.call<ProvisionedStore[]>('GET', '/stores')).map((p) => [p.name, p]));
    for (const row of pending) {
      const p = provisioned.get(row.name);
      if (p?.state !== 'ready') continue;
      allowInternalHost(new URL(p.mcp_url).hostname);
      const [server] = await query<ServerRow>(
        `INSERT INTO servers (name, slug, url, auth_type, credential_enc) VALUES ($1, $2, $3, 'bearer', $4)
         ON CONFLICT (slug) DO NOTHING RETURNING *`,
        [`Store: ${row.name}`, row.name, p.mcp_url, encrypt(decrypt(row.token_enc))],
      );
      if (!server) continue;
      await query('UPDATE stores SET server_id = $2 WHERE name = $1', [row.name, server.id]);
      await this.upstreams.upsert(server);
      console.log(`registered store '${row.name}' as upstream`);
    }
  }

  private require(): void {
    if (!this.enabled) throw new HttpError(503, 'store provisioning is not configured');
  }

  private async call<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${config.provisionerUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${config.provisionerToken}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    }).catch((err) => {
      throw new HttpError(502, `provisioner unreachable: ${err instanceof Error ? err.message : String(err)}`);
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new HttpError(res.status === 404 ? 404 : res.status >= 500 ? 502 : res.status, data.error ?? `provisioner returned ${res.status}`);
    return data as T;
  }
}
