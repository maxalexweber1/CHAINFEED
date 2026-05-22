/**
 * CHAINFEED MCP server — stdio transport.
 *
 * Exposes the curated CHAINFEED tool set (srv/mcp/tools.ts) to a local MCP
 * client (Claude Code, Claude Desktop, …). It is a thin facade over a running
 * CHAINFEED OData service — start `npm run dev` (or point CHAINFEED_BASE_URL
 * at a deployed instance) first.
 *
 * Run:  npm run mcp
 * Env:  CHAINFEED_BASE_URL (default http://localhost:4004)
 *
 * stdout is the MCP wire protocol — all human logging goes to stderr.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CHAINFEED_TOOLS, makeContext, type ToolRunResult } from './tools';

/** Shape a ToolRunResult into an MCP CallToolResult. */
export function toMcpResult(r: ToolRunResult): {
  content: Array<{ type: 'text'; text: string }>;
  isError: boolean;
} {
  // paymentRequired is an expected, actionable state — not a tool error.
  const isError = !r.ok && !r.paymentRequired;
  const payload = r.ok ? r.data : (r.paymentRequired ? r.data : { error: r.error });
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    isError,
  };
}

export function buildServer(ctx = makeContext()): McpServer {
  const server = new McpServer(
    { name: 'chainfeed', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );
  for (const tool of CHAINFEED_TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      async (args: Record<string, unknown>) => toMcpResult(await tool.run(args ?? {}, ctx)),
    );
  }
  return server;
}

async function main(): Promise<void> {
  const ctx = makeContext();
  const server = buildServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `chainfeed MCP server ready on stdio — ${CHAINFEED_TOOLS.length} tools, base=${ctx.baseUrl}\n`,
  );
}

// Only auto-start when run directly (not when imported by tests).
if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`chainfeed MCP server failed to start: ${(e as Error)?.stack ?? e}\n`);
    process.exit(1);
  });
}
