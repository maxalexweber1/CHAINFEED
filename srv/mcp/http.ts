/**
 * CHAINFEED MCP server — streamable-HTTP transport (remote agents).
 *
 * Same curated tool set as the stdio server (srv/mcp/server.ts), exposed over
 * HTTP so a remote, wallet-equipped agent can consume it — and pay via x402:
 * a gated tool surfaces a structured `paymentRequired` result (see tools.ts)
 * carrying the buildPaymentTx handoff.
 *
 * Stateless mode (`sessionIdGenerator: undefined`): a fresh McpServer +
 * transport is created per request and torn down on response close. No session
 * affinity needed — every tool call is an independent OData round-trip — which
 * keeps the facade horizontally scalable.
 *
 * Run:  npm run mcp:http
 * Env:  MCP_HTTP_PORT (default 4005), CHAINFEED_BASE_URL (default :4004)
 */

import express, { type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildServer } from './server';
import { makeContext, type ChainfeedToolContext } from './tools';
import { getLogger } from '../lib/log';

const log = getLogger('mcp:http');

const jsonRpcError = (code: number, message: string) => ({
  jsonrpc: '2.0' as const,
  error: { code, message },
  id: null,
});

export function createMcpHttpApp(ctx: ChainfeedToolContext = makeContext()) {
  const app = express();
  app.use(express.json());

  // Liveness — does not touch the upstream CHAINFEED service.
  app.get('/healthz', (_req: Request, res: Response) => {
    res.json({ ok: true, transport: 'streamable-http', base: ctx.baseUrl });
  });

  app.post('/mcp', async (req: Request, res: Response) => {
    // Stateless: one server + transport per request.
    const server = buildServer(ctx);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      log.error({ err: (e as Error)?.stack ?? String(e) }, 'request failed');
      if (!res.headersSent) res.status(500).json(jsonRpcError(-32603, 'internal error'));
    }
  });

  // GET (server-push SSE) and DELETE (session teardown) are meaningless in
  // stateless mode — reject cleanly so clients fall back to POST-only.
  const methodNotAllowed = (_req: Request, res: Response) =>
    res.status(405).json(jsonRpcError(-32000, 'Method not allowed: stateless server is POST-only'));
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  return app;
}

async function main(): Promise<void> {
  const ctx = makeContext();
  const port = Number(process.env.MCP_HTTP_PORT ?? 4005);
  const app = createMcpHttpApp(ctx);
  app.listen(port, () => {
    log.info({ port, base: ctx.baseUrl }, 'MCP HTTP server ready');
  });
}

if (require.main === module) {
  main().catch((e) => {
    log.fatal({ err: (e as Error)?.stack ?? String(e) }, 'MCP HTTP server failed to start');
    process.exit(1);
  });
}
