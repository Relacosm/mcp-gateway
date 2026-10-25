export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const res = await fetch(`/api${path}`, {
    method,
    // The backend requires JSON on every write (its CSRF guard).
    headers: { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(opts.body ?? {}),
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? res.statusText);
  return data as T;
}

export type Role = 'admin' | 'member';

export interface Me {
  id: number;
  email: string;
  name: string;
  role: Role;
}

export interface Server {
  id: number;
  name: string;
  slug: string;
  url: string;
  auth_type: 'none' | 'bearer' | 'header';
  auth_header: string | null;
  has_credential: boolean;
  enabled: boolean;
  members_read_only: boolean;
  status: 'connected' | 'unreachable' | 'disabled';
  error: string | null;
  checked_at: string | null;
  tools: { name: string; description: string; read_only: boolean }[];
}

export interface ServerMetrics {
  calls: number;
  errors: number;
  avg_ms: number;
  p95_ms: number;
}

export interface Metrics {
  window: string;
  rate_limit_per_minute: number;
  rate_limited: Record<string, number>;
  servers: Record<string, ServerMetrics>;
}

export interface Member {
  id: number;
  email: string;
  name: string;
  role: Role;
  created_at: string;
}

export interface ApiKey {
  id: number;
  name: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  user_id: number;
  user_email: string;
}

export interface AuditRow {
  id: number;
  created_at: string;
  user_id: number | null;
  user_email: string;
  server_slug: string | null;
  tool: string;
  source: 'mcp' | 'chat';
  duration_ms: number;
  outcome: 'ok' | 'tool_error' | 'gateway_error';
  error: string | null;
}

// Every time on the dashboard is IST, whatever the viewer's browser is set to.
export const TIME_ZONE = 'Asia/Kolkata';

export function when(value: string | null): string {
  return value
    ? `${new Date(value).toLocaleString('en-IN', { timeZone: TIME_ZONE, dateStyle: 'medium', timeStyle: 'medium' })} IST`
    : '—';
}
