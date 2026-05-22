/**
 * CHAINFEED MCP streamable-HTTP end-to-end test.
 *
 * Boots the HTTP MCP app on an ephemeral port with a MOCKED CHAINFEED upstream
 * (no real OData service or network needed), then drives it with the real MCP
 * client over the streamable-HTTP transport: initialize → tools/list → call.
 *
 * Run: npx tsx scripts/test-mcp-http.ts
 */

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpHttpApp } from '../srv/mcp/http';
import { makeContext, type FetchLike } from '../srv/mcp/tools';

let n = 0, fails = 0;
async function t(name: string, fn: () => Promise<void>) {
  n++;
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (e) { fails++; console.log(`FAIL  ${name}\n      ${(e as Error).stack || (e as Error).message}`); }
}

// Mock CHAINFEED OData upstream — replies based on the action in the URL.
const fetchImpl: FetchLike = async (url) => {
  const action = url.split('/').pop()!;
  const bodies: Record<string, unknown> = {
    assessStable:     { '@odata.context': 'x', symbol: 'USDM', verdict: 'ok', riskScore: 0.96 },
    getServiceStatus: { '@odata.context': 'x', value: { adapters: [{ sourceName: 'orcfax' }] } },
  };
  const body = bodies[action] ?? 'no route';
  const status = body === 'no route' ? 404 : 200;
  return {
    status,
    ok: status < 300,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
};

async function main() {
  console.log('mcp-http (e2e) ──────────────────────────────────────────');

  const app = createMcpHttpApp(makeContext({ baseUrl: 'http://upstream.test', fetchImpl }));
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  const port = (server.address() as AddressInfo).port;
  const url = new URL(`http://127.0.0.1:${port}/mcp`);

  try {
    await t('client connects, lists the curated tool set', async () => {
      const client = new Client({ name: 'test', version: '0.0.0' });
      const transport = new StreamableHTTPClientTransport(url);
      await client.connect(transport);
      const { tools } = await client.listTools();
      assert.ok(tools.length >= 8, `expected ≥ 8 tools, got ${tools.length}`);
      assert.ok(tools.some(t => t.name === 'assess_stable'));
      assert.ok(tools.every(t => typeof t.description === 'string' && t.description.length > 0));
      await client.close();
    });

    await t('tools/call assess_stable round-trips through to the (mocked) OData action', async () => {
      const client = new Client({ name: 'test', version: '0.0.0' });
      const transport = new StreamableHTTPClientTransport(url);
      await client.connect(transport);
      const res = await client.callTool({ name: 'assess_stable', arguments: { symbol: 'USDM' } });
      assert.equal(res.isError, false);
      const content = res.content as Array<{ type: string; text: string }>;
      const payload = JSON.parse(content[0]!.text);
      assert.equal(payload.verdict, 'ok');
      assert.equal(payload.symbol, 'USDM');
      assert.ok(!('@odata.context' in payload), 'OData metadata should be stripped');
      await client.close();
    });

    await t('tools/call get_service_status unwraps the value envelope', async () => {
      const client = new Client({ name: 'test', version: '0.0.0' });
      const transport = new StreamableHTTPClientTransport(url);
      await client.connect(transport);
      const res = await client.callTool({ name: 'get_service_status', arguments: {} });
      const content = res.content as Array<{ type: string; text: string }>;
      const payload = JSON.parse(content[0]!.text);
      assert.deepEqual(payload, { adapters: [{ sourceName: 'orcfax' }] });
      await client.close();
    });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }

  console.log(`\n${n - fails}/${n} passed`);
  process.exit(fails ? 1 : 0);
}

void main();
