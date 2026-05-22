/**
 * CHAINFEED MCP tool-registry tests — no running server (fetch is mocked).
 *
 * Run: npx tsx scripts/test-mcp-tools.ts
 */

import assert from 'node:assert/strict';
import { CHAINFEED_TOOLS, makeContext, type FetchLike } from '../srv/mcp/tools';
import { toMcpResult } from '../srv/mcp/server';

let n = 0, fails = 0;
function t(name: string, fn: () => void | Promise<void>) {
  n++;
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok  ${name}`))
    .catch((e) => {
      fails++;
      const err = e as Error;
      console.log(`FAIL  ${name}\n      ${err.stack || err.message}`);
    });
}

/** Build a mock fetch that records calls and replays scripted responses. */
function mockFetch(routes: Record<string, { status?: number; body: unknown }>): {
  fetchImpl: FetchLike;
  calls: Array<{ url: string; body: unknown }>;
} {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });
    const action = url.split('/').pop()!;
    const route = routes[action] ?? { status: 404, body: 'no route' };
    const status = route.status ?? 200;
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => route.body,
      text: async () => (typeof route.body === 'string' ? route.body : JSON.stringify(route.body)),
    };
  };
  return { fetchImpl, calls };
}

const tool = (name: string) => {
  const tdef = CHAINFEED_TOOLS.find(t => t.name === name);
  if (!tdef) throw new Error(`tool ${name} not registered`);
  return tdef;
};

async function main() {
  console.log('mcp-tools ───────────────────────────────────────────────');

  // ── registry shape ────────────────────────────────────────────────────
  await t('every tool has a name, a substantial description, and an inputSchema object', () => {
    assert.ok(CHAINFEED_TOOLS.length >= 8, `expected ≥ 8 tools, got ${CHAINFEED_TOOLS.length}`);
    const names = new Set<string>();
    for (const td of CHAINFEED_TOOLS) {
      assert.ok(/^[a-z][a-z0-9_]*$/.test(td.name), `bad tool name: ${td.name}`);
      assert.ok(!names.has(td.name), `duplicate tool name: ${td.name}`);
      names.add(td.name);
      assert.ok(td.description.length >= 60, `${td.name}: description too thin for routing`);
      assert.equal(typeof td.inputSchema, 'object');
      assert.equal(typeof td.run, 'function');
    }
  });

  await t('makeContext resolves base URL + strips trailing slash', () => {
    const ctx = makeContext({ baseUrl: 'http://example.com/', fetchImpl: (async () => ({})) as unknown as FetchLike });
    assert.equal(ctx.baseUrl, 'http://example.com');
  });

  // ── assess_stable happy path ──────────────────────────────────────────
  await t('assess_stable POSTs symbol to the right action URL and returns data', async () => {
    const { fetchImpl, calls } = mockFetch({
      assessStable: { body: { '@odata.context': '$metadata#x', verdict: 'ok', symbol: 'USDM' } },
    });
    const ctx = makeContext({ baseUrl: 'http://localhost:4004', fetchImpl });
    const r = await tool('assess_stable').run({ symbol: 'USDM' }, ctx);
    assert.equal(calls[0]!.url, 'http://localhost:4004/odata/v4/price/assessStable');
    assert.deepEqual(calls[0]!.body, { symbol: 'USDM' });
    assert.ok(r.ok);
    // @odata.context stripped, object returned as-is otherwise
    assert.deepEqual(r.data, { verdict: 'ok', symbol: 'USDM' });
  });

  // ── x402 gating ───────────────────────────────────────────────────────
  await t('gated action returning 402 → paymentRequired (not an error) with hint', async () => {
    const { fetchImpl } = mockFetch({
      getBestPrice: { status: 402, body: { accepts: [{ scheme: 'exact', amount: '10000' }] } },
    });
    const ctx = makeContext({ baseUrl: 'http://x', fetchImpl });
    const r = await tool('get_best_price').run({ pair: 'ADA-USD' }, ctx);
    assert.equal(r.ok, false);
    assert.equal(r.paymentRequired, true);
    const data = r.data as { action: string; requirements: unknown; hint: string };
    assert.equal(data.action, 'getBestPrice');
    assert.ok(data.hint.includes('buildPaymentTx'));
    // toMcpResult must NOT mark a payment-required result as an error
    assert.equal(toMcpResult(r).isError, false);
  });

  // ── value-envelope unwrapping ─────────────────────────────────────────
  await t('OData { value: [...] } envelope is unwrapped', async () => {
    const { fetchImpl } = mockFetch({
      getServiceStatus: { body: { '@odata.context': 'x', value: { adapters: [] } } },
    });
    const ctx = makeContext({ baseUrl: 'http://x', fetchImpl });
    const r = await tool('get_service_status').run({}, ctx);
    assert.ok(r.ok);
    assert.deepEqual(r.data, { adapters: [] });
  });

  // ── error path ────────────────────────────────────────────────────────
  await t('non-2xx (non-402) → ok:false with HTTP status, toMcpResult.isError true', async () => {
    const { fetchImpl } = mockFetch({
      getStableHealth: { status: 400, body: 'symbol invalid' },
    });
    const ctx = makeContext({ baseUrl: 'http://x', fetchImpl });
    const r = await tool('get_stable_health').run({ symbol: 'NOPE' }, ctx);
    assert.equal(r.ok, false);
    assert.ok(r.error!.includes('HTTP 400'));
    assert.equal(toMcpResult(r).isError, true);
  });

  await t('network throw → ok:false with network-error message', async () => {
    const fetchImpl: FetchLike = async () => { throw new Error('ECONNREFUSED'); };
    const ctx = makeContext({ baseUrl: 'http://x', fetchImpl });
    const r = await tool('get_service_status').run({}, ctx);
    assert.equal(r.ok, false);
    assert.ok(r.error!.includes('network error'));
  });

  // ── lending merge ─────────────────────────────────────────────────────
  await t('get_lending_health merges both protocols; survives one being down', async () => {
    const { fetchImpl, calls } = mockFetch({
      getFluidtokensHealth: { body: { '@odata.context': 'x', poolsTotal: 12 } },
      getLiqwidHealth:      { status: 500, body: 'liqwid down' },
    });
    const ctx = makeContext({ baseUrl: 'http://x', fetchImpl });
    const r = await tool('get_lending_health').run({}, ctx);
    assert.ok(r.ok, 'overall ok when at least one protocol responds');
    const data = r.data as { fluidtokens: unknown; liqwid: { available: boolean } };
    assert.deepEqual(data.fluidtokens, { poolsTotal: 12 });
    assert.equal(data.liqwid.available, false);
    assert.equal(calls.length, 2);
  });

  await t('toMcpResult emits a single text content block with pretty JSON', () => {
    const out = toMcpResult({ ok: true, data: { a: 1 } });
    assert.equal(out.content.length, 1);
    assert.equal(out.content[0]!.type, 'text');
    assert.deepEqual(JSON.parse(out.content[0]!.text), { a: 1 });
  });

  console.log(`\n${n - fails}/${n} passed`);
  process.exit(fails ? 1 : 0);
}

void main();
