import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { User } from './auth.js';
import { query } from './db.js';
import type { RateLimiter } from './ratelimit.js';
import { GatewayError, SEPARATOR, type UpstreamManager } from './upstreams.js';

export type Source = 'mcp' | 'chat';

export interface Gateway {
  upstreams: UpstreamManager;
  limiter: RateLimiter;
}

export interface Caller {
  user: User;
  // What the rate limit counts against: one API key, or one user's chat.
  rateKey: string;
  source: Source;
}

function firstText(result: CallToolResult): string {
  const block = result.content?.find((c) => c.type === 'text');
  return block && 'text' in block ? String(block.text).slice(0, 500) : 'tool returned an error';
}

/**
 * The single path every tool call takes, from external MCP clients and from the
 * chat agent alike: split "<slug>__<tool>", apply the rate limit and role
 * policy, call the owning upstream, and write one audit row under the user.
 */
export async function routeToolCall(
  gw: Gateway,
  caller: Caller,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const started = Date.now();
  const sep = name.indexOf(SEPARATOR);
  const slug = sep > 0 ? name.slice(0, sep) : null;
  const tool = sep > 0 ? name.slice(sep + SEPARATOR.length) : name;

  // Rejected calls are counted in metrics but not audited, so a flood cannot fill the audit log.
  if (!gw.limiter.take(caller.rateKey, slug)) {
    return {
      isError: true,
      content: [{ type: 'text', text: `rate limit exceeded: ${gw.limiter.limit} tool calls per minute` }],
    };
  }

  const upstream = slug ? gw.upstreams.bySlug(slug) : undefined;
  let result: CallToolResult;
  let outcome: 'ok' | 'tool_error' | 'gateway_error' = 'ok';
  let error: string | null = null;
  try {
    if (!slug) throw new GatewayError(`unknown tool '${name}': expected <server>${SEPARATOR}<tool>`);
    result = await gw.upstreams.callTool(slug, tool, args, caller.user.role);
    if (result.isError) {
      outcome = 'tool_error';
      error = firstText(result);
    }
  } catch (err) {
    outcome = 'gateway_error';
    error = err instanceof Error ? err.message : String(err);
    result = { isError: true, content: [{ type: 'text', text: error }] };
  }

  await query(
    `INSERT INTO audit_log (user_id, user_email, server_id, server_slug, tool, source, duration_ms, outcome, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [caller.user.id, caller.user.email, upstream?.row.id ?? null, slug, tool, caller.source, Date.now() - started, outcome, error],
  ).catch((err) => console.error('audit write failed', err));

  return result;
}
