/**
 * CHAINFEED live terminal dashboard — entry point.
 *
 * Connects to a running CHAINFEED MCP HTTP server (default :4005), then mounts
 * the ink app. SIGINT / SIGTERM unmount the app cleanly so terminal escape
 * sequences don't leak into the shell.
 *
 * Run:  npm run agent:dashboard
 * Env:  MCP_URL (default http://localhost:4005/mcp)
 */

import React from 'react';
import { render } from 'ink';
import { connectMcp } from '../shared/chainfeed-client.js';
import { App } from './App.js';

async function main(): Promise<void> {
  const url = process.env.MCP_URL ?? 'http://localhost:4005/mcp';

  let client;
  try {
    client = await connectMcp({ url, clientName: 'chainfeed-dashboard', authToken: process.env.MCP_AUTH_TOKEN });
  } catch (e) {
    process.stderr.write(
      `\nchainfeed-dashboard: failed to connect to MCP at ${url}\n` +
      `  → ${(e as Error)?.message ?? e}\n` +
      `  → Is the CHAINFEED MCP HTTP server running? Try: npm run mcp:http\n\n`,
    );
    process.exit(1);
  }

  // Pretty intro on stderr — keep stdout clean for ink's terminal control.
  process.stderr.write(`chainfeed-dashboard: connected to ${url}\n`);

  const app = render(<App client={client} baseUrl={url} />);

  // Clean shutdown: unmount ink so terminal state is restored, then close the
  // MCP transport. Without unmount, leftover escape codes garble the shell.
  const shutdown = async (sig: NodeJS.Signals) => {
    process.stderr.write(`\nchainfeed-dashboard: received ${sig}, shutting down…\n`);
    app.unmount();
    try { await client.close(); } catch { /* best-effort */ }
    process.exit(0);
  };
  process.once('SIGINT',  () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await app.waitUntilExit();
  try { await client.close(); } catch { /* best-effort */ }
}

void main().catch((e) => {
  process.stderr.write(`chainfeed-dashboard: ${(e as Error)?.stack ?? e}\n`);
  process.exit(1);
});
