import { createHash, timingSafeEqual } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const port = Number(process.env.PORT ?? 3000);
const token = process.env.MCP_TOKEN;
if (!token) throw new Error('missing required env var MCP_TOKEN');
const expected = createHash('sha256').update(token).digest();

// Reference rates: units of each currency per 1 USD. Fixed on purpose so the
// demo is deterministic and needs no outbound network; not for real money.
const RATES_PER_USD: Record<string, number> = {
  USD: 1,
  INR: 84.0,
  EUR: 0.92,
  GBP: 0.77,
  JPY: 150.0,
  AED: 3.6725,
  SGD: 1.34,
  AUD: 1.52,
  CAD: 1.37,
};
const RATES_AS_OF = '2026-10-01';

function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function fail(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function buildServer(): McpServer {
  const server = new McpServer({ name: 'utils', version: '0.1.0' });

  server.registerTool(
    'get_time',
    {
      description: 'Current date and time, in a given IANA timezone (default UTC).',
      annotations: { readOnlyHint: true },
      inputSchema: { timezone: z.string().optional().describe('e.g. "Asia/Kolkata", "America/New_York"') },
    },
    async ({ timezone }) => {
      const timeZone = timezone || 'UTC';
      try {
        const now = new Date();
        const local = new Intl.DateTimeFormat('en-GB', { timeZone, dateStyle: 'full', timeStyle: 'long' }).format(now);
        return ok({ timezone: timeZone, iso_utc: now.toISOString(), local });
      } catch {
        return fail(`unknown timezone "${timeZone}"`);
      }
    },
  );

  server.registerTool(
    'convert_currency',
    {
      description: `Convert an amount between currencies using fixed reference rates (as of ${RATES_AS_OF}). Supported: ${Object.keys(RATES_PER_USD).join(', ')}.`,
      annotations: { readOnlyHint: true },
      inputSchema: {
        amount: z.coerce.number().describe('Amount to convert'),
        from: z.string().describe('ISO code, e.g. INR'),
        to: z.string().describe('ISO code, e.g. USD'),
      },
    },
    async ({ amount, from, to }) => {
      const f = from.toUpperCase();
      const t = to.toUpperCase();
      if (!RATES_PER_USD[f] || !RATES_PER_USD[t]) {
        return fail(`unsupported currency; supported: ${Object.keys(RATES_PER_USD).join(', ')}`);
      }
      const rate = RATES_PER_USD[t] / RATES_PER_USD[f];
      return ok({ amount, from: f, to: t, rate: Number(rate.toFixed(6)), result: Number((amount * rate).toFixed(2)), rates_as_of: RATES_AS_OF });
    },
  );

  return server;
}

function requireToken(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? '';
  const given = createHash('sha256').update(header.startsWith('Bearer ') ? header.slice(7) : '').digest();
  if (!timingSafeEqual(given, expected)) {
    res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
    return;
  }
  next();
}

const app = express();
app.use(express.json({ limit: '256kb' }));
app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

app.post('/mcp', requireToken, async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('mcp request failed', err);
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
  }
});

app.all('/mcp', requireToken, (_req, res) => {
  res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
});

const httpServer = app.listen(port, () => console.log(`utils-mcp listening on :${port}`));
process.on('SIGTERM', () => httpServer.close(() => process.exit(0)));
