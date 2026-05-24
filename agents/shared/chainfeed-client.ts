/**
 * Typed CHAINFEED client over MCP streamable-HTTP.
 *
 * Both demo agents (watcher, dashboard) import only this — never the raw MCP
 * SDK. Keeps the agent code free of `result.content[0].text` JSON-parsing
 * boilerplate, and gives us one place to evolve when the tool surface grows.
 *
 * Connection model is one persistent client per agent (not per-call). The
 * server (`srv/mcp/http.ts`) is stateless — sessionIdGenerator: undefined —
 * so the SDK creates a transport instance per request internally; from the
 * client's POV it looks like a normal long-lived connection.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AssessmentResponse, StableSymbol } from './types.js';

export interface ChainfeedClient {
  /** Verdict + reasons + suggested actions for one stable. Full `detail` block included. */
  assessStable(symbol: StableSymbol): Promise<AssessmentResponse>;
  /** Per-adapter cache snapshot — pure read of in-memory state, never triggers a fetch. */
  getServiceStatus(): Promise<unknown>;
  /** Cross-rate matrix + convergenceScore across all USD stables. */
  getStableConvergence(): Promise<unknown>;
  /** Combined FluidTokens v3 + Liqwid v2 health rollup. */
  getLendingHealth(): Promise<unknown>;
  /** Close the underlying transport. Idempotent. */
  close(): Promise<void>;
}

export interface ConnectOptions {
  /** Streamable-HTTP endpoint, e.g. `http://localhost:4005/mcp`. */
  url: string;
  /** Identifier sent on the MCP `initialize` handshake. Mostly cosmetic. */
  clientName?: string;
  clientVersion?: string;
}

/** Connect to a running CHAINFEED MCP HTTP server and return a typed client. */
export async function connectMcp(opts: ConnectOptions): Promise<ChainfeedClient> {
  const client = new Client({
    name:    opts.clientName    ?? 'chainfeed-agent',
    version: opts.clientVersion ?? '0.0.1',
  });
  const transport = new StreamableHTTPClientTransport(new URL(opts.url));
  await client.connect(transport);

  /**
   * Tool calls return `{ content: [{ type:'text', text:<json> }], isError }`.
   * We always treat the first text-block as the JSON payload — that's the
   * contract `srv/mcp/server.ts:toMcpResult` upholds.
   */
  async function call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const res = await client.callTool({ name, arguments: args });
    const content = res.content as Array<{ type: string; text: string }> | undefined;
    const text = content?.[0]?.text;

    if (res.isError) {
      // Server already serialised the error as JSON under content[0].text.
      throw new Error(`MCP tool '${name}' returned an error: ${text ?? 'no message'}`);
    }
    if (typeof text !== 'string') {
      throw new Error(`MCP tool '${name}' returned no text content`);
    }
    try {
      return JSON.parse(text) as T;
    } catch (e) {
      throw new Error(`MCP tool '${name}' returned invalid JSON: ${(e as Error).message}`);
    }
  }

  return {
    assessStable:          (symbol)  => call<AssessmentResponse>('assess_stable', { symbol }),
    getServiceStatus:      ()        => call<unknown>('get_service_status'),
    getStableConvergence:  ()        => call<unknown>('get_stable_convergence'),
    getLendingHealth:      ()        => call<unknown>('get_lending_health'),
    close:                 ()        => client.close(),
  };
}
