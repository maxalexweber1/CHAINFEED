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
 * Env:  MCP_HTTP_PORT (default 4005), CHAINFEED_BASE_URL (default :4004),
 *       MCP_AUTH_TOKEN (bearer token required on /mcp; see auth note below)
 *
 * Auth: when MCP_AUTH_TOKEN is set, every /mcp request must carry
 * `Authorization: Bearer <token>` or it's rejected 401. When unset, the
 * transport is UNAUTHENTICATED — tolerated in dev (logged loudly), but
 * `main()` refuses to boot in production without it (fail closed, same idiom
 * as CHAINFEED_SUBSCRIPTION_KEK_HEX). /healthz is always open for probes.
 */

import { timingSafeEqual } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
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

/** Constant-time string compare. Length is checked first (leaks length only). */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface McpHttpOptions {
  /** Bearer token required on /mcp. Falls back to MCP_AUTH_TOKEN when omitted. */
  authToken?: string;
}

export function createMcpHttpApp(
  ctx: ChainfeedToolContext = makeContext(),
  opts: McpHttpOptions = {},
) {
  const authToken = opts.authToken ?? process.env.MCP_AUTH_TOKEN;
  const app = express();
  app.use(express.json());

  // Liveness — does not touch the upstream CHAINFEED service. Intentionally
  // unauthenticated so uptime probes don't need the token.
  app.get('/healthz', (_req: Request, res: Response) => {
    res.json({ ok: true, transport: 'streamable-http', base: ctx.baseUrl });
  });

  // Bearer-token gate on the whole /mcp surface (POST + the 405 GET/DELETE).
  // No-op when no token is configured (dev mode); main() blocks that in prod.
  app.use('/mcp', (req: Request, res: Response, next: NextFunction) => {
    if (!authToken) return next();
    const header = req.get('authorization') ?? '';
    const match = /^Bearer (.+)$/.exec(header);
    if (!match || !tokenMatches(match[1]!, authToken)) {
      log.warn({ ip: req.ip, hasHeader: !!header }, 'rejected unauthenticated /mcp request');
      // Generic message — don't reveal whether the header was missing vs wrong.
      return res.status(401).json(jsonRpcError(-32001, 'unauthorized'));
    }
    next();
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
  const authToken = process.env.MCP_AUTH_TOKEN;

  if (!authToken) {
    if (process.env.NODE_ENV === 'production') {
      log.fatal('MCP_AUTH_TOKEN is required in production — refusing to start an unauthenticated MCP transport');
      process.exit(1);
    }
    log.warn('MCP_AUTH_TOKEN not set — /mcp is UNAUTHENTICATED (dev only). Set it before exposing this port.');
  }

  const app = createMcpHttpApp(ctx, { authToken });
  app.listen(port, () => {
    log.info({ port, base: ctx.baseUrl, authenticated: !!authToken }, 'MCP HTTP server ready');
  });
}

if (require.main === module) {
  main().catch((e) => {
    log.fatal({ err: (e as Error)?.stack ?? String(e) }, 'MCP HTTP server failed to start');
    process.exit(1);
  });
}
