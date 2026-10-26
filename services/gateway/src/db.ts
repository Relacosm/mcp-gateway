import pg from 'pg';

export const pool = new pg.Pool({ max: 10 });

export async function query<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const result = await pool.query(text, params);
  return result.rows as T[];
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id           SERIAL PRIMARY KEY,
  user_id      INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  prefix       TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS servers (
  id             SERIAL PRIMARY KEY,
  name           TEXT NOT NULL,
  slug           TEXT NOT NULL UNIQUE,
  url            TEXT NOT NULL,
  auth_type      TEXT NOT NULL DEFAULT 'none' CHECK (auth_type IN ('none', 'bearer', 'header')),
  auth_header    TEXT,
  credential_enc TEXT,
  enabled        BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- user_email and server_slug are copied in so rows stay readable after a
-- user or server is deleted.
CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id     INT REFERENCES users(id) ON DELETE SET NULL,
  user_email  TEXT NOT NULL,
  server_id   INT REFERENCES servers(id) ON DELETE SET NULL,
  server_slug TEXT,
  tool        TEXT NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('mcp', 'chat')),
  duration_ms INT NOT NULL,
  outcome     TEXT NOT NULL CHECK (outcome IN ('ok', 'tool_error', 'gateway_error')),
  error       TEXT
);
CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log (created_at DESC);

ALTER TABLE servers ADD COLUMN IF NOT EXISTS members_read_only BOOLEAN NOT NULL DEFAULT false;
-- Admin labels per tool ({"tool": "read" | "write"}), replacing the upstream's readOnlyHint.
ALTER TABLE servers ADD COLUMN IF NOT EXISTS tool_access JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Extra stores created from the dashboard. token_enc is the bearer token the
-- store's MCP server requires; server_id is set once the store is registered.
CREATE TABLE IF NOT EXISTS stores (
  name       TEXT PRIMARY KEY,
  token_enc  TEXT NOT NULL,
  server_id  INT REFERENCES servers(id) ON DELETE SET NULL,
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Which starter products the store was created with (store.catalogs in the chart).
ALTER TABLE stores ADD COLUMN IF NOT EXISTS catalog TEXT NOT NULL DEFAULT 'custom';
ALTER TABLE stores ALTER COLUMN catalog SET DEFAULT 'custom';
UPDATE stores SET catalog = 'custom' WHERE catalog = 'general';

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Servers are members-read-only unless an admin turns it off. Existing servers
-- are switched once; the meta row keeps a later admin choice from being undone.
ALTER TABLE servers ALTER COLUMN members_read_only SET DEFAULT true;
WITH once AS (
  INSERT INTO meta (key, value) VALUES ('members_read_only_default', 'true') ON CONFLICT (key) DO NOTHING RETURNING 1
)
UPDATE servers SET members_read_only = true WHERE EXISTS (SELECT 1 FROM once);
`;

/** Waits for Postgres (it may still be starting), then creates the schema. */
export async function migrate(): Promise<void> {
  let client: pg.PoolClient | undefined;
  for (let attempt = 1; !client; attempt++) {
    try {
      client = await pool.connect();
    } catch (err) {
      if (attempt >= 30) throw err;
      console.log(`waiting for postgres (${(err as Error).message})`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  // An advisory lock keeps two replicas from racing.
  try {
    await client.query('SELECT pg_advisory_lock(4242)');
    await client.query(SCHEMA);
  } finally {
    await client.query('SELECT pg_advisory_unlock(4242)').catch(() => undefined);
    client.release();
  }
}
