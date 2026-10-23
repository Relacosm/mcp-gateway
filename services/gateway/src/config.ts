function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var ${name}`);
  return value;
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export interface SeedServer {
  name: string;
  slug: string;
  url: string;
  // Name of the env var holding the bearer token, if the server needs one.
  tokenEnv?: string;
}

// Postgres connection comes from the standard PGHOST/PGUSER/PGPASSWORD/PGDATABASE vars.
export const config = {
  port: Number(process.env.PORT ?? 3000),
  // Encrypts upstream credentials at rest.
  masterKey: required('MASTER_KEY'),
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  sessionTtlHours: Number(process.env.SESSION_TTL_HOURS ?? 24 * 7),
  callTimeoutMs: Number(process.env.CALL_TIMEOUT_MS ?? 15000),
  healthTimeoutMs: Number(process.env.HEALTH_TIMEOUT_MS ?? 5000),
  healthIntervalMs: Number(process.env.HEALTH_INTERVAL_MS ?? 10000),
  // Tool calls allowed per API key (MCP) or per user (chat), per minute.
  rateLimitPerMinute: Number(process.env.RATE_LIMIT_PER_MINUTE ?? 60),
  // Blocks upstream URLs that resolve to private, loopback or link-local
  // addresses, except for the in-cluster hosts listed here.
  ssrfProtection: process.env.SSRF_PROTECTION !== 'false',
  allowedInternalHosts: list(process.env.ALLOWED_INTERNAL_HOSTS),
  // First admin, created only when the users table is empty.
  adminEmail: process.env.ADMIN_EMAIL ?? '',
  adminPassword: process.env.ADMIN_PASSWORD ?? '',
  // Upstream servers registered once on first start.
  seedServers: JSON.parse(process.env.SEED_SERVERS ?? '[]') as SeedServer[],
  // Chat agent: any OpenAI-compatible chat completions API.
  llmBaseUrl: (process.env.LLM_BASE_URL ?? '').replace(/\/$/, ''),
  llmModel: process.env.LLM_MODEL ?? '',
  llmApiKey: process.env.LLM_API_KEY ?? '',
  llmTimeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 90000),
  chatMaxSteps: Number(process.env.CHAT_MAX_STEPS ?? 6),
  // Run one tool call per LLM step. Small models often fire dependent calls in
  // parallel with made-up arguments; this makes them see each result first.
  chatSequentialTools: process.env.CHAT_SEQUENTIAL_TOOLS === 'true',
};
