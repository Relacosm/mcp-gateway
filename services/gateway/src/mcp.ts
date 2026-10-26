import { Router } from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { apiKeyUser } from './auth.js';
import { routeToolCall, type Gateway } from './router.js';

function rpcError(code: number, message: string) {
  return { jsonrpc: '2.0', error: { code, message }, id: null };
}

/**
 * The one MCP endpoint members connect to. Authenticated by the member's own
 * API key; that key is never forwarded upstream.
 */
export function mcpRouter(gw: Gateway): Router {
  const router = Router();

  router.use(async (req, res, next) => {
    const auth = await apiKeyUser(req);
    if (!auth) {
      res.status(401).set('WWW-Authenticate', 'Bearer').json(rpcError(-32001, 'invalid or revoked API key'));
      return;
    }
    req.user = auth.user;
    res.locals.keyId = auth.keyId;
    next();
  });

  // Stateless: a fresh MCP server per request, bound to the calling user.
  router.post('/', async (req, res) => {
    const caller = { user: req.user!, rateKey: `key:${res.locals.keyId}`, source: 'mcp' as const };
    const server = new Server(
      { name: 'team-mcp-gateway', version: '0.1.0' },
      {
        capabilities: { tools: {} },
        instructions: 'Tools from every server the team has connected, named <server>__<tool>.',
      },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: gw.upstreams.listTools(caller.user) }));
    server.setRequestHandler(CallToolRequestSchema, async (request) =>
      routeToolCall(gw, caller, request.params.name, request.params.arguments ?? {}),
    );

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
      if (!res.headersSent) res.status(500).json(rpcError(-32603, 'Internal error'));
    }
  });

  router.all('/', (_req, res) => {
    res.status(405).set('Allow', 'POST').json(rpcError(-32000, 'Method not allowed'));
  });

  return router;
}
