import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { query } from './db.js';
import type { User } from './auth.js';
import { decrypt } from './security.js';
import { guardedFetch } from './ssrf.js';

export type Status = 'connected' | 'unreachable' | 'disabled';

export interface ServerRow {
  id: number;
  name: string;
  slug: string;
  url: string;
  auth_type: 'none' | 'bearer' | 'header';
  auth_header: string | null;
  credential_enc: string | null;
  enabled: boolean;
  // Members may only use tools the upstream marks read-only (readOnlyHint).
  members_read_only: boolean;
  // Admin labels that replace the upstream's readOnlyHint for a tool, for
  // upstreams that leave it out (or get it wrong).
  tool_access: Record<string, ToolAccess>;
}

export type ToolAccess = 'read' | 'write';

interface Upstream {
  row: ServerRow;
  // The user who created the store behind this server, if it is a store.
  ownerId: number | null;
  client?: Client;
  // Last good tool list. Only exposed while the server is connected.
  tools: Tool[];
  status: Status;
  error?: string;
  checkedAt?: Date;
  checking?: Promise<void>;
}

/** Error the gateway itself produced (as opposed to an upstream tool error). */
export class GatewayError extends Error {}

/** Exposed name of an upstream tool: "<slug>__<tool>". */
export const SEPARATOR = '__';

type Caller = Pick<User, 'id' | 'role'>;

/**
 * Whether a tool only reads: the admin's label if there is one, else the
 * upstream's readOnlyHint. A tool with neither (or one the gateway has not
 * seen in a tools/list) counts as a write.
 */
function isReadOnly(u: Upstream, name: string, tool: Tool | undefined): boolean {
  const label = u.row.tool_access?.[name];
  return label ? label === 'read' : tool?.annotations?.readOnlyHint === true;
}

/**
 * Whether a user may use a tool. Admins may use everything, and a store's
 * owner everything on their own store. On a members-read-only server, other
 * members only get read-only tools.
 */
function allowed(u: Upstream, name: string, tool: Tool | undefined, user: Caller): boolean {
  return user.role === 'admin' || u.ownerId === user.id || !u.row.members_read_only || isReadOnly(u, name, tool);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new GatewayError(`${what} timed out after ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * One MCP client per registered upstream server. Each upstream has its own
 * connection, timeout and status, and a background health check refreshes its
 * cached tool list, so a slow or dead server never blocks the others.
 */
export class UpstreamManager {
  private readonly upstreams = new Map<number, Upstream>();
  private timer?: NodeJS.Timeout;

  constructor(private readonly opts: { callTimeoutMs: number; healthTimeoutMs: number; healthIntervalMs: number }) {}

  async loadAll(): Promise<void> {
    const rows = await query<ServerRow>('SELECT * FROM servers ORDER BY id');
    await Promise.all(rows.map((row) => this.upsert(row)));
  }

  start(): void {
    this.timer = setInterval(() => {
      for (const u of this.upstreams.values()) void this.check(u);
    }, this.opts.healthIntervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await Promise.all([...this.upstreams.values()].map((u) => this.disconnect(u)));
  }

  /** Add or replace an upstream after its row changed, and check it right away. */
  async upsert(row: ServerRow): Promise<void> {
    const old = this.upstreams.get(row.id);
    if (old) await this.disconnect(old);
    const [store] = await query<{ created_by: number | null }>('SELECT created_by FROM stores WHERE server_id = $1', [row.id]);
    const u: Upstream = { row, ownerId: store?.created_by ?? null, tools: [], status: row.enabled ? 'unreachable' : 'disabled' };
    this.upstreams.set(row.id, u);
    await this.check(u);
  }

  /** Applies a row change that needs no reconnect (tool labels). */
  update(row: ServerRow): void {
    const u = this.upstreams.get(row.id);
    if (u) u.row = row;
  }

  async remove(id: number): Promise<void> {
    const u = this.upstreams.get(id);
    this.upstreams.delete(id);
    if (u) await this.disconnect(u);
  }

  async refresh(id: number): Promise<void> {
    const u = this.upstreams.get(id);
    if (u) await this.check(u);
  }

  bySlug(slug: string): Upstream | undefined {
    for (const u of this.upstreams.values()) if (u.row.slug === slug) return u;
    return undefined;
  }

  /** Every tool of every enabled + connected server that the user may use, namespaced by slug. */
  listTools(user: Caller): Tool[] {
    const tools: Tool[] = [];
    for (const u of this.upstreams.values()) {
      if (u.status !== 'connected') continue;
      for (const t of u.tools) {
        if (!allowed(u, t.name, t, user)) continue;
        tools.push({
          ...t,
          name: `${u.row.slug}${SEPARATOR}${t.name}`,
          description: `[${u.row.name}] ${t.description ?? ''}`.trim(),
          // Clients see the gateway's verdict, including an admin's label.
          annotations: { ...t.annotations, readOnlyHint: isReadOnly(u, t.name, t) },
        });
      }
    }
    return tools;
  }

  /** Public view for the dashboard. Never includes the credential. */
  describe() {
    return [...this.upstreams.values()].map((u) => ({
      id: u.row.id,
      name: u.row.name,
      slug: u.row.slug,
      url: u.row.url,
      auth_type: u.row.auth_type,
      auth_header: u.row.auth_header,
      has_credential: Boolean(u.row.credential_enc),
      enabled: u.row.enabled,
      members_read_only: u.row.members_read_only,
      status: u.status,
      error: u.error ?? null,
      checked_at: u.checkedAt ?? null,
      tools: u.tools.map((t) => ({
        name: t.name,
        description: t.description ?? '',
        read_only: isReadOnly(u, t.name, t),
        // Who decided: the upstream's readOnlyHint, or an admin's label.
        labeled_by: u.row.tool_access?.[t.name] ? ('admin' as const) : ('upstream' as const),
      })),
    }));
  }

  async callTool(slug: string, tool: string, args: Record<string, unknown>, user: Caller): Promise<CallToolResult> {
    const u = this.bySlug(slug);
    if (!u) throw new GatewayError(`unknown server '${slug}'`);
    if (!u.row.enabled) throw new GatewayError(`upstream '${slug}' is disabled`);
    if (u.status !== 'connected' || !u.client) {
      throw new GatewayError(`upstream '${slug}' is unreachable${u.error ? ` (${u.error})` : ''}`);
    }
    if (!allowed(u, tool, u.tools.find((t) => t.name === tool), user)) {
      const who = u.ownerId === null ? 'admins' : "admins and the store's owner";
      throw new GatewayError(`'${slug}${SEPARATOR}${tool}' changes data and is limited to ${who} on this server`);
    }
    try {
      return (await u.client.callTool({ name: tool, arguments: args }, undefined, {
        timeout: this.opts.callTimeoutMs,
      })) as CallToolResult;
    } catch (err) {
      // A JSON-RPC error from a live upstream (bad arguments, unknown tool) is
      // not a connectivity problem; anything else is.
      if (err instanceof McpError && err.code !== ErrorCode.RequestTimeout && err.code !== ErrorCode.ConnectionClosed) {
        throw new GatewayError(`upstream '${slug}' rejected the call: ${err.message}`);
      }
      // A slow answer fails this call only: the server is still up, and the
      // health check is what decides that a server is down.
      if (err instanceof McpError && err.code === ErrorCode.RequestTimeout) {
        throw new GatewayError(`upstream '${slug}' did not answer '${tool}' within ${this.opts.callTimeoutMs / 1000}s`);
      }
      const reason = `is unreachable (${message(err)})`;
      u.status = 'unreachable';
      u.error = reason;
      void this.disconnect(u);
      throw new GatewayError(`upstream '${slug}' ${reason}`);
    }
  }

  private check(u: Upstream): Promise<void> {
    u.checking ??= this.doCheck(u).finally(() => {
      u.checking = undefined;
      u.checkedAt = new Date();
    });
    return u.checking;
  }

  private async doCheck(u: Upstream): Promise<void> {
    if (!u.row.enabled) {
      await this.disconnect(u);
      u.status = 'disabled';
      u.error = undefined;
      return;
    }
    const hadClient = Boolean(u.client);
    try {
      u.tools = await this.fetchTools(u);
    } catch (err) {
      await this.disconnect(u);
      if (!hadClient) return this.markUnreachable(u, err);
      // The old connection may be stale (upstream restarted, session expired):
      // retry once on a fresh one.
      try {
        u.tools = await this.fetchTools(u);
      } catch (err2) {
        await this.disconnect(u);
        return this.markUnreachable(u, err2);
      }
    }
    u.status = 'connected';
    u.error = undefined;
  }

  private markUnreachable(u: Upstream, err: unknown): void {
    u.status = 'unreachable';
    u.error = message(err);
  }

  private async fetchTools(u: Upstream): Promise<Tool[]> {
    u.client ??= await this.connect(u);
    const client = u.client;
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await withTimeout(
        client.listTools(cursor ? { cursor } : undefined, { timeout: this.opts.healthTimeoutMs }),
        this.opts.healthTimeoutMs,
        `upstream '${u.row.slug}' tools/list`,
      );
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }

  private async connect(u: Upstream): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(new URL(u.row.url), {
      requestInit: { headers: this.authHeaders(u.row) },
      fetch: guardedFetch,
    });
    const client = new Client({ name: 'team-mcp-gateway', version: '0.1.0' });
    try {
      await withTimeout(client.connect(transport), this.opts.healthTimeoutMs, `upstream '${u.row.slug}' connect`);
    } catch (err) {
      await client.close().catch(() => undefined);
      throw err;
    }
    return client;
  }

  /** The upstream credential is added here, server side only. */
  private authHeaders(row: ServerRow): Record<string, string> {
    if (row.auth_type === 'none' || !row.credential_enc) return {};
    const credential = decrypt(row.credential_enc);
    if (row.auth_type === 'bearer') return { Authorization: `Bearer ${credential}` };
    return { [row.auth_header ?? 'Authorization']: credential };
  }

  private async disconnect(u: Upstream): Promise<void> {
    const client = u.client;
    u.client = undefined;
    if (client) await client.close().catch(() => undefined);
  }
}
