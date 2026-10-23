import express, { type NextFunction, type Request, type Response } from 'express';
import { ZodError } from 'zod';
import { apiRouter } from './api.js';
import { HttpError } from './auth.js';
import { config } from './config.js';
import { migrate, pool, query } from './db.js';
import { mcpRouter } from './mcp.js';
import { RateLimiter } from './ratelimit.js';
import type { Gateway } from './router.js';
import { encrypt, hashPassword } from './security.js';
import { UpstreamManager } from './upstreams.js';

async function seed(): Promise<void> {
  const [{ count }] = await query<{ count: string }>('SELECT count(*) FROM users');
  if (count === '0' && config.adminEmail && config.adminPassword) {
    await query(`INSERT INTO users (email, name, password_hash, role) VALUES (lower($1), 'Admin', $2, 'admin')`, [
      config.adminEmail,
      await hashPassword(config.adminPassword),
    ]);
    console.log(`created first admin ${config.adminEmail}`);
  }

  // Register each seed server once. The meta flag stops one coming back if an
  // admin later removes it.
  for (const seed of config.seedServers) {
    const flag = `seeded:${seed.slug}`;
    const [done] = await query('SELECT 1 FROM meta WHERE key = $1', [flag]);
    if (done) continue;
    const token = seed.tokenEnv ? process.env[seed.tokenEnv] : undefined;
    await query(
      `INSERT INTO servers (name, slug, url, auth_type, credential_enc) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (slug) DO NOTHING`,
      [seed.name, seed.slug, seed.url, token ? 'bearer' : 'none', token ? encrypt(token) : null],
    );
    await query('INSERT INTO meta (key, value) VALUES ($1, now()::text)', [flag]);
    console.log(`registered upstream '${seed.slug}'`);
  }
}

await migrate();
await seed();

const upstreams = new UpstreamManager({
  callTimeoutMs: config.callTimeoutMs,
  healthTimeoutMs: config.healthTimeoutMs,
  healthIntervalMs: config.healthIntervalMs,
});
await upstreams.loadAll();
upstreams.start();
const gw: Gateway = { upstreams, limiter: new RateLimiter(config.rateLimitPerMinute) };

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));

app.get('/livez', (_req, res) => {
  res.json({ ok: true });
});
app.get('/healthz', async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true });
});

app.use('/mcp', mcpRouter(gw));
app.use('/api', apiRouter(gw));

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
  } else if (err instanceof ZodError) {
    res.status(400).json({ error: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
  } else if (err instanceof SyntaxError) {
    res.status(400).json({ error: 'invalid JSON' });
  } else {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

const server = app.listen(config.port, () => {
  console.log(`gateway listening on :${config.port}`);
});

process.on('SIGTERM', () => {
  server.close(async () => {
    await upstreams.stop();
    await pool.end();
    process.exit(0);
  });
});
