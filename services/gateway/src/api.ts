import { Router, type Request } from 'express';
import { z } from 'zod';
import { endSession, HttpError, requireAdmin, requireUser, sessionUser, startSession, type User } from './auth.js';
import { runChat } from './chat.js';
import { query } from './db.js';
import type { Gateway } from './router.js';
import { encrypt, hashPassword, newApiKey, verifyPassword } from './security.js';
import { assertPublicUrl, SsrfError } from './ssrf.js';
import { CATALOGS, type StoreService } from './stores.js';
import type { ServerRow } from './upstreams.js';

// Burns the same scrypt time for unknown emails, so login timing does not leak which emails exist.
const DUMMY_HASH = await hashPassword('dummy-password-for-timing');

function idParam(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'invalid id');
  return id;
}

const loginBody = z.object({ email: z.string().email(), password: z.string().min(1) });
const memberBody = z.object({
  email: z.string().email(),
  name: z.string().max(100).default(''),
  password: z.string().min(8),
  role: z.enum(['admin', 'member']).default('member'),
});
const keyBody = z.object({ name: z.string().min(1).max(100) });

// Slugs are lowercase letters, digits and single hyphens, so "__" can never
// appear inside one and tool routing stays unambiguous.
const slug = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'lowercase letters, digits and hyphens')
  .max(32);
const httpUrl = z
  .string()
  .url()
  .refine((u) => /^https?:$/.test(new URL(u).protocol), 'must be http or https');
const serverBase = {
  name: z.string().min(1).max(100),
  url: httpUrl,
  auth_type: z.enum(['none', 'bearer', 'header']),
  auth_header: z.string().max(100).nullish(),
  // Write-only. Omit on update to keep the stored credential.
  credential: z.string().max(4096).optional(),
  enabled: z.boolean(),
  members_read_only: z.boolean(),
};
const serverCreate = z.object({
  ...serverBase,
  slug,
  enabled: serverBase.enabled.default(true),
  members_read_only: serverBase.members_read_only.default(true),
});
const chatBody = z.object({
  messages: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(8000) }))
    .min(1)
    .max(40),
});

async function checkUrl(url: string): Promise<void> {
  try {
    await assertPublicUrl(url);
  } catch (err) {
    if (err instanceof SsrfError) throw new HttpError(400, err.message);
    throw err;
  }
}
const serverUpdate = z.object(serverBase).partial();

export function apiRouter(gw: Gateway, stores: StoreService): Router {
  const { upstreams } = gw;
  const api = Router();
  api.use(sessionUser);

  // CSRF guard: browsers cannot send a cross-site application/json request
  // without a CORS preflight, which this API never approves.
  api.use((req, _res, next) => {
    const json = (req.headers['content-type'] ?? '').startsWith('application/json');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !json) {
      throw new HttpError(415, 'expected application/json');
    }
    next();
  });

  // ---- auth
  api.post('/auth/login', async (req, res) => {
    const { email, password } = loginBody.parse(req.body);
    const [row] = await query<User & { password_hash: string }>(
      'SELECT id, email, name, role, password_hash FROM users WHERE lower(email) = lower($1)',
      [email],
    );
    const valid = await verifyPassword(password, row?.password_hash ?? DUMMY_HASH);
    if (!row || !valid) throw new HttpError(401, 'wrong email or password');
    await startSession(res, row.id);
    res.json({ id: row.id, email: row.email, name: row.name, role: row.role });
  });

  api.post('/auth/logout', async (req, res) => {
    await endSession(req, res);
    res.json({ ok: true });
  });

  api.get('/auth/me', requireUser, (req, res) => {
    res.json(req.user);
  });

  // ---- members (admin)
  api.get('/members', requireAdmin, async (_req, res) => {
    res.json(await query('SELECT id, email, name, role, created_at FROM users ORDER BY id'));
  });

  api.post('/members', requireAdmin, async (req, res) => {
    const body = memberBody.parse(req.body);
    const [row] = await query(
      `INSERT INTO users (email, name, password_hash, role) VALUES (lower($1), $2, $3, $4)
       ON CONFLICT (email) DO NOTHING RETURNING id, email, name, role, created_at`,
      [body.email, body.name, await hashPassword(body.password), body.role],
    );
    if (!row) throw new HttpError(409, 'a user with that email already exists');
    res.status(201).json(row);
  });

  api.delete('/members/:id', requireAdmin, async (req, res) => {
    const id = idParam(req);
    if (id === req.user!.id) throw new HttpError(400, 'you cannot remove yourself');
    const removed = await query('DELETE FROM users WHERE id = $1 RETURNING id', [id]);
    if (!removed.length) throw new HttpError(404, 'no such member');
    res.json({ ok: true });
  });

  // ---- API keys
  api.get('/keys', requireUser, async (req, res) => {
    const all = req.query.all === '1' && req.user!.role === 'admin';
    res.json(
      await query(
        `SELECT k.id, k.name, k.prefix, k.created_at, k.last_used_at, k.revoked_at, u.id AS user_id, u.email AS user_email
         FROM api_keys k JOIN users u ON u.id = k.user_id
         WHERE ($1 OR k.user_id = $2) ORDER BY k.id DESC`,
        [all, req.user!.id],
      ),
    );
  });

  api.post('/keys', requireUser, async (req, res) => {
    const { name } = keyBody.parse(req.body);
    const { key, prefix, hash } = newApiKey();
    const [row] = await query(
      `INSERT INTO api_keys (user_id, name, prefix, key_hash) VALUES ($1, $2, $3, $4)
       RETURNING id, name, prefix, created_at`,
      [req.user!.id, name, prefix, hash],
    );
    // The only time the full key ever leaves the server.
    res.status(201).json({ ...row, key });
  });

  api.delete('/keys/:id', requireUser, async (req, res) => {
    const isAdmin = req.user!.role === 'admin';
    const revoked = await query(
      `UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL AND ($2 OR user_id = $3) RETURNING id`,
      [idParam(req), isAdmin, req.user!.id],
    );
    if (!revoked.length) throw new HttpError(404, 'no such active key');
    res.json({ ok: true });
  });

  // ---- upstream servers (list for everyone, changes for admins)
  api.get('/servers', requireUser, (_req, res) => {
    res.json(upstreams.describe());
  });

  api.get('/tools', requireUser, (req, res) => {
    res.json(upstreams.listTools(req.user!).map((t) => ({ name: t.name, description: t.description })));
  });

  // Calls, errors and latency per server over the last 24 hours, from the audit log.
  api.get('/metrics', requireUser, async (_req, res) => {
    const rows = await query<{ server: string }>(
      `SELECT server_slug AS server, count(*)::int AS calls,
              count(*) FILTER (WHERE outcome <> 'ok')::int AS errors,
              round(avg(duration_ms))::int AS avg_ms,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)::int AS p95_ms
       FROM audit_log WHERE created_at > now() - interval '24 hours' AND server_slug IS NOT NULL
       GROUP BY server_slug`,
    );
    res.json({
      window: '24h',
      rate_limit_per_minute: gw.limiter.limit,
      rate_limited: gw.limiter.rejectedByServer(),
      servers: Object.fromEntries(rows.map((r) => [r.server, r])),
    });
  });

  // ---- chat agent
  api.post('/chat', requireUser, async (req, res) => {
    const { messages } = chatBody.parse(req.body);
    res.json(await runChat(gw, req.user!, messages, await stores.storefronts()));
  });

  api.post('/servers', requireAdmin, async (req, res) => {
    const body = serverCreate.parse(req.body);
    await checkUrl(body.url);
    const [row] = await query<ServerRow>(
      `INSERT INTO servers (name, slug, url, auth_type, auth_header, credential_enc, enabled, members_read_only)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (slug) DO NOTHING RETURNING *`,
      [
        body.name,
        body.slug,
        body.url,
        body.auth_type,
        body.auth_type === 'header' ? (body.auth_header ?? null) : null,
        body.auth_type !== 'none' && body.credential ? encrypt(body.credential) : null,
        body.enabled,
        body.members_read_only,
      ],
    );
    if (!row) throw new HttpError(409, `slug '${body.slug}' is already taken`);
    await upstreams.upsert(row);
    res.status(201).json(upstreams.describe().find((s) => s.id === row.id));
  });

  api.patch('/servers/:id', requireAdmin, async (req, res) => {
    const id = idParam(req);
    const body = serverUpdate.parse(req.body);
    const [current] = await query<ServerRow>('SELECT * FROM servers WHERE id = $1', [id]);
    if (!current) throw new HttpError(404, 'no such server');
    if (body.url) await checkUrl(body.url);

    const authType = body.auth_type ?? current.auth_type;
    let credentialEnc = current.credential_enc;
    if (authType === 'none') credentialEnc = null;
    else if (body.credential) credentialEnc = encrypt(body.credential);

    const [row] = await query<ServerRow>(
      `UPDATE servers SET name = $2, url = $3, auth_type = $4, auth_header = $5, credential_enc = $6, enabled = $7,
              members_read_only = $8
       WHERE id = $1 RETURNING *`,
      [
        id,
        body.name ?? current.name,
        body.url ?? current.url,
        authType,
        authType === 'header' ? (body.auth_header ?? current.auth_header) : null,
        credentialEnc,
        body.enabled ?? current.enabled,
        body.members_read_only ?? current.members_read_only,
      ],
    );
    await upstreams.upsert(row);
    res.json(upstreams.describe().find((s) => s.id === id));
  });

  // Label one tool read or write when the upstream's readOnlyHint is missing or
  // wrong; null goes back to the upstream's own label.
  api.put('/servers/:id/tools/:tool', requireAdmin, async (req, res) => {
    const id = idParam(req);
    const tool = String(req.params.tool);
    const { access } = z.object({ access: z.enum(['read', 'write']).nullable() }).parse(req.body);
    const [row] = await query<ServerRow>(
      access
        ? `UPDATE servers SET tool_access = tool_access || jsonb_build_object($2::text, $3::text) WHERE id = $1 RETURNING *`
        : `UPDATE servers SET tool_access = tool_access - $2::text WHERE id = $1 RETURNING *`,
      access ? [id, tool, access] : [id, tool],
    );
    if (!row) throw new HttpError(404, 'no such server');
    upstreams.update(row);
    res.json(upstreams.describe().find((s) => s.id === id));
  });

  api.delete('/servers/:id', requireAdmin, async (req, res) => {
    const id = idParam(req);
    const removed = await query('DELETE FROM servers WHERE id = $1 RETURNING id', [id]);
    if (!removed.length) throw new HttpError(404, 'no such server');
    await upstreams.remove(id);
    res.json({ ok: true });
  });

  api.post('/servers/:id/refresh', requireAdmin, async (req, res) => {
    const id = idParam(req);
    await upstreams.refresh(id);
    res.json(upstreams.describe().find((s) => s.id === id) ?? null);
  });

  // ---- extra stores: one namespace + Helm release + MCP server each.
  // Any user may own a few; owners and admins manage them.
  api.get('/stores', requireUser, async (req, res) => {
    if (!stores.enabled) {
      res.json({ enabled: false, stores: stores.builtin() });
      return;
    }
    res.json({ enabled: true, ...(await stores.list(req.user!)) });
  });

  api.post('/stores', requireUser, async (req, res) => {
    const { name, catalog } = z.object({ name: z.string(), catalog: z.enum(CATALOGS).optional() }).parse(req.body);
    res.status(202).json(await stores.create(name.trim().toLowerCase(), req.user!, catalog));
  });

  api.delete('/stores/:name', requireUser, async (req, res) => {
    await stores.remove(String(req.params.name), req.user!);
    res.json({ ok: true });
  });

  // ---- audit log (admins see everyone, members see their own calls)
  api.get('/audit', requireUser, async (req, res) => {
    const isAdmin = req.user!.role === 'admin';
    const userId = isAdmin ? (req.query.user_id ? Number(req.query.user_id) : null) : req.user!.id;
    const server = typeof req.query.server === 'string' && req.query.server ? req.query.server : null;
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    res.json(
      await query(
        `SELECT id, created_at, user_id, user_email, server_slug, tool, source, duration_ms, outcome, error
         FROM audit_log
         WHERE ($1::int IS NULL OR user_id = $1) AND ($2::text IS NULL OR server_slug = $2)
         ORDER BY id DESC LIMIT $3`,
        [userId, server, limit],
      ),
    );
  });

  return api;
}
