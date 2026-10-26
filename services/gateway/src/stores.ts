import { HttpError, type User } from './auth.js';
import { config } from './config.js';
import { query } from './db.js';
import { decrypt, encrypt, newToken } from './security.js';
import { allowInternalHost } from './ssrf.js';
import type { ServerRow, UpstreamManager } from './upstreams.js';

type State = 'creating' | 'ready' | 'failed' | 'deleting';

interface ProvisionedStore {
  name: string;
  namespace: string;
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
  catalog: string;
}

const NAME = /^[a-z][a-z0-9]{1,14}$/;
/** Store types offered in the dashboard; each is a key of store.catalogs in the chart. */
export const CATALOGS = ['custom', 'apparel', 'bakery', 'books'] as const;
export type Catalog = (typeof CATALOGS)[number];

/**
 * Extra stores: one namespace, one Helm release and one MCP server per store.
 * The provisioner creates the Kubernetes side; once a store is ready, this
 * registers its MCP server like any other upstream, so status, policy and
 * audit apply per store. Any user may own up to maxStoresPerUser stores;
 * owners and admins may retry or delete them.
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

  async list(user: User) {
    this.require();
    const [provisioned, rows, users] = await Promise.all([
      this.call<ProvisionedStore[]>('GET', '/stores'),
      query<StoreRow>('SELECT * FROM stores'),
      query<{ id: number; email: string }>('SELECT id, email FROM users'),
    ]);
    const servers = new Map(this.upstreams.describe().map((s) => [s.id, s]));
    const byName = new Map(provisioned.map((p) => [p.name, p]));
    // A store we recorded but the cluster has no trace of (the provisioner
    // restarted before creating anything) shows as failed, so it can be retried.
    for (const row of rows) {
      if (!byName.has(row.name)) {
        byName.set(row.name, { name: row.name, namespace: '', state: 'failed', message: 'not found in the cluster; retry or delete', url: '', admin_url: '', mcp_url: '' });
      }
    }
    const rowsByName = new Map(rows.map((r) => [r.name, r]));
    const stores = [...byName.values()].sort((x, y) => x.name.localeCompare(y.name)).map((p) => {
      const row = rowsByName.get(p.name);
      const server = row?.server_id ? servers.get(row.server_id) : undefined;
      return {
        ...p,
        created_at: row?.created_at ?? null,
        created_by: users.find((u) => u.id === row?.created_by)?.email ?? null,
        can_manage: Boolean(row) && (user.role === 'admin' || row?.created_by === user.id),
        server: server ? { id: server.id, slug: server.slug, status: server.status, tools: server.tools.length } : null,
      };
    });
    const mine = rows.filter((r) => r.created_by === user.id).length;
    return { stores: [...this.builtin(), ...stores], limits: { per_user: config.maxStoresPerUser, mine } };
  }

  /** The store that ships with the platform: listed first, never deletable here. */
  builtin() {
    if (!config.builtinStoreUrl) return [];
    const u = this.upstreams.bySlug('urumi');
    return [
      {
        name: 'urumi',
        namespace: '',
        state: 'ready' as State,
        message: 'built-in store',
        url: config.builtinStoreUrl,
        admin_url: `${config.builtinStoreUrl}/wp-admin/`,
        mcp_url: '',
        created_at: null,
        created_by: null,
        can_manage: false,
        server: u ? { id: u.row.id, slug: u.row.slug, status: u.status, tools: u.tools.length } : null,
      },
    ];
  }

  /**
   * Public storefront URL per store server slug, the built-in store included.
   * Only the customer-facing address: never the internal MCP URL.
   */
  async storefronts(): Promise<Map<string, string>> {
    const urls = new Map<string, string>();
    if (config.builtinStoreUrl) urls.set('urumi', config.builtinStoreUrl);
    if (!this.enabled) return urls;
    try {
      for (const p of await this.call<ProvisionedStore[]>('GET', '/stores')) {
        if (p.state === 'ready' && p.url) urls.set(p.name, p.url.replace(/\/$/, ''));
      }
    } catch (err) {
      // The chat still works without the links.
      console.error('storefront list', err);
    }
    return urls;
  }

  /** Creates a store, or retries one of yours that failed. Safe to repeat. */
  async create(name: string, user: User, catalog: Catalog = 'custom'): Promise<ProvisionedStore> {
    this.require();
    if (!NAME.test(name)) throw new HttpError(400, 'name: 2-15 lowercase letters or digits, starting with a letter');

    const [existing] = await query<StoreRow>('SELECT * FROM stores WHERE name = $1', [name]);
    if (existing) {
      if (user.role !== 'admin' && existing.created_by !== user.id) throw new HttpError(409, `store '${name}' already exists`);
      // A retry keeps the type the store was created with.
      return this.call<ProvisionedStore>('POST', '/stores', {
        name,
        token: decrypt(existing.token_enc),
        admin_email: user.email,
        catalog: existing.catalog,
      });
    }

    if (this.upstreams.bySlug(name)) throw new HttpError(409, `a server with slug '${name}' already exists`);
    const [{ count }] = await query<{ count: number }>('SELECT count(*)::int AS count FROM stores WHERE created_by = $1', [user.id]);
    if (count >= config.maxStoresPerUser) {
      throw new HttpError(409, `you already have ${count} store(s); the limit is ${config.maxStoresPerUser} per user`);
    }

    const token = newToken();
    const inserted = await query(
      `INSERT INTO stores (name, token_enc, created_by, catalog) VALUES ($1, $2, $3, $4) ON CONFLICT (name) DO NOTHING RETURNING name`,
      [name, encrypt(token), user.id, catalog],
    );
    if (!inserted.length) throw new HttpError(409, `store '${name}' already exists`);
    try {
      return await this.call<ProvisionedStore>('POST', '/stores', { name, token, admin_email: user.email, catalog });
    } catch (err) {
      await query('DELETE FROM stores WHERE name = $1', [name]);
      throw err;
    }
  }

  async remove(name: string, user: User): Promise<void> {
    this.require();
    const [row] = await query<StoreRow>('SELECT * FROM stores WHERE name = $1', [name]);
    if (row && user.role !== 'admin' && row.created_by !== user.id) throw new HttpError(403, 'only the owner or an admin can delete this store');
    if (!row && user.role !== 'admin') throw new HttpError(404, 'no such store');
    try {
      await this.call('DELETE', `/stores/${encodeURIComponent(name)}`);
    } catch (err) {
      // Nothing left in the cluster: just forget it.
      if (!(err instanceof HttpError && err.status === 404 && row)) throw err;
    }
    // Its tools vanish now; the namespace is torn down in the background.
    await query('DELETE FROM stores WHERE name = $1', [name]);
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
