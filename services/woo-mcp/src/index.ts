import { createHash, timingSafeEqual } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from './config.js';
import { buildServer } from './tools.js';
import { WooClient } from './woo.js';

const woo = new WooClient(config.wooUrl, config.wooKey, config.wooSecret, config.requestTimeoutMs);
const expected = createHash('sha256').update(config.mcpToken).digest();

function requireToken(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  // Compare fixed-length hashes so the check takes the same time for any input.
  const given = createHash('sha256').update(token).digest();
  if (!token || !timingSafeEqual(given, expected)) {
    res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
    return;
  }
  next();
}

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

// Stateless Streamable HTTP: a fresh server + transport per request, so any
// replica can answer any request and a restart loses nothing.
app.post('/mcp', requireToken, async (req, res) => {
  const server = buildServer(woo, config.storeTimezone, config.storePublicUrl.replace(/\/$/, ''));
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
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  }
});

// No server-initiated streams or sessions in stateless mode.
app.all('/mcp', requireToken, (_req, res) => {
  res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
});

const httpServer = app.listen(config.port, () => {
  console.log(`woo-mcp listening on :${config.port}`);
});

process.on('SIGTERM', () => httpServer.close(() => process.exit(0)));
