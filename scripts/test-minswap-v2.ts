/**
 * Minswap V2 direct adapter unit tests.
 *
 * Patches `globalThis.fetch` to stub Koios `credential_utxos` responses
 * (paginated). Verifies pool selection, dust floor, asset-name
 * disambiguation, sanity band, snapshot caching across pairs, and
 * pagination behaviour.
 *
 * Run: npx tsx scripts/test-minswap-v2.ts
 */

import assert from 'node:assert/strict';

let n = 0, fails = 0;
async function t(name: string, fn: () => Promise<void>) {
  n++;
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (e) {
    fails++;
    const err = e as Error;
    console.log(`FAIL  ${name}\n      ${err.stack || err.message}`);
  }
}

type FetchStub = { ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> };
function jsonResponse(body: unknown): FetchStub {
  return {
    ok: true, status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

interface KoiosRow {
  tx_hash: string;
  tx_index: number;
  value: string;
  asset_list: Array<{ policy_id: string; asset_name: string; quantity: string }>;
}

const POL = {
  USDM: 'c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad',
  USDA: 'fe7c786ab321f41c654ef6c1af7b3250a613c24e4213e0425a7ae456',
  DJED: '8db269c3ec630e06ae29f74bc39edd1f87c819f1056206e879a1cd61',
  IUSD: 'f66d78b4a3cb3d37afa0ec36461e51ecbde00f26c8f0a68f94b69880',
  USDCx: '1f3aec8bfe7ea4fe14c5f121e2a92e301afe414147860d557cac7e34',
  LP:    'f5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4c',
} as const;

const NAME = {
  USDM: '0014df105553444d',
  USDA: '55534441',
  DJED: '446a65644d6963726f555344',
  SHEN: '5368656e4d6963726f555344',
  IUSD: '69555344',
  IBTC: '69425443',
  USDCx: '5553444378',
} as const;

let pageQueue: KoiosRow[][] = [];
let fetchCallCount = 0;
let lastUrlSeen = '';

async function main() {
  const origFetch = globalThis.fetch;

  globalThis.fetch = (async (input: string | URL | Request) => {
    fetchCallCount++;
    const url = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);
    lastUrlSeen = url;
    if (!url.startsWith('https://api.koios.rest/api/v1/credential_utxos')) {
      throw new Error(`unexpected fetch url: ${url}`);
    }
    const offsetMatch = /offset=(\d+)/.exec(url);
    const offset = offsetMatch ? Number(offsetMatch[1]) : 0;
    const pageIndex = offset / 1000;
    const page = pageQueue[pageIndex] ?? [];
    return jsonResponse(page) as unknown as Response;
  }) as typeof globalThis.fetch;

  const minswapV2 = require('../srv/adapters/minswap-v2');

  // Helper: build a pool UTxO row (policyId of LP NFT + the stable + MSP NFT)
  function makePool(stablePolicy: string, stableAssetName: string, adaLovelace: bigint, stableQty: bigint, txHash = 'aa'.repeat(32)): KoiosRow {
    return {
      tx_hash: txHash,
      tx_index: 0,
      value: adaLovelace.toString(),
      asset_list: [
        { policy_id: stablePolicy, asset_name: stableAssetName, quantity: stableQty.toString() },
        { policy_id: POL.LP, asset_name: 'aa'.repeat(32), quantity: '9223372000000000000' },
        { policy_id: POL.LP, asset_name: '4d5350', quantity: '1' }, // MSP NFT
      ],
    };
  }

  // ── Test 1: picks deepest pool above floor ───────────────────────────
  await t('picks deepest matching pool above 10k ADA floor', async () => {
    minswapV2._resetCache();
    pageQueue = [
      [
        makePool(POL.USDA, NAME.USDA, 50_000n * 1_000_000n, 12_500n * 1_000_000n, '11'.repeat(32)),  // 50k ADA pool
        makePool(POL.USDA, NAME.USDA, 4_500_000n * 1_000_000n, 1_120_000n * 1_000_000n, '22'.repeat(32)),  // 4.5M ADA pool — deepest
        makePool(POL.USDA, NAME.USDA, 5_000n * 1_000_000n, 1_250n * 1_000_000n, '33'.repeat(32)),  // 5k ADA — below floor
      ],
    ];
    const q = await minswapV2.getPrice('ADA-USDA') as { price: number; rawPayload: { utxoTxHash: string; adaReserve: string } };
    const expected = 1_120_000 / 4_500_000;
    assert.equal(q.rawPayload.utxoTxHash, '22'.repeat(32), 'should pick the 4.5M ADA pool');
    assert.ok(Math.abs(q.price - expected) < 1e-9, `expected ~${expected}, got ${q.price}`);
    assert.equal(q.rawPayload.adaReserve, (4_500_000n * 1_000_000n).toString());
  });

  // ── Test 2: rejects when only dust pools exist ───────────────────────
  await t('throws when every matching pool is below floor', async () => {
    minswapV2._resetCache();
    pageQueue = [[
      makePool(POL.USDA, NAME.USDA, 5_000n * 1_000_000n, 1_250n * 1_000_000n),
      makePool(POL.USDA, NAME.USDA, 100n * 1_000_000n, 25n * 1_000_000n),
    ]];
    await assert.rejects(
      () => minswapV2.getPrice('ADA-USDA'),
      /no V2 pool for ADA-USDA above 10000-ADA dust floor/,
    );
  });

  // ── Test 3: asset-name disambiguation (DJED vs SHEN, same policy) ────
  await t('disambiguates DJED vs SHEN on Coti policy by assetNameHex', async () => {
    minswapV2._resetCache();
    pageQueue = [[
      makePool(POL.DJED, NAME.SHEN, 470_000n * 1_000_000n, 117_000n * 1_000_000n, '11'.repeat(32)),  // SHEN pool — bigger
      makePool(POL.DJED, NAME.DJED, 277_000n * 1_000_000n, 69_000n * 1_000_000n, '22'.repeat(32)),    // DJED pool — what we want
    ]];
    const q = await minswapV2.getPrice('ADA-DJED') as { price: number; rawPayload: { utxoTxHash: string } };
    assert.equal(q.rawPayload.utxoTxHash, '22'.repeat(32), 'should pick the DJED pool, not the deeper SHEN pool');
    const expected = 69_000 / 277_000;
    assert.ok(Math.abs(q.price - expected) < 1e-9);
  });

  // ── Test 4: asset-name disambiguation (iUSD vs iBTC on Indigo policy) ─
  await t('disambiguates iUSD vs iBTC on Indigo policy by assetNameHex', async () => {
    minswapV2._resetCache();
    pageQueue = [[
      makePool(POL.IUSD, NAME.IBTC, 100_000n * 1_000_000n, 5n * 1_000_000n, '11'.repeat(32)),  // iBTC pool
      makePool(POL.IUSD, NAME.IUSD, 540_000n * 1_000_000n, 135_000n * 1_000_000n, '22'.repeat(32)),  // iUSD pool
    ]];
    const q = await minswapV2.getPrice('ADA-iUSD') as { rawPayload: { utxoTxHash: string } };
    assert.equal(q.rawPayload.utxoTxHash, '22'.repeat(32));
  });

  // ── Test 5: sanity band rejects implausible spot ─────────────────────
  await t('rejects spot below sanity floor (would be stableswap pool)', async () => {
    minswapV2._resetCache();
    // Pool with implausibly small stable reserve — spot would be ~0.0001
    pageQueue = [[
      makePool(POL.USDA, NAME.USDA, 100_000n * 1_000_000n, 10n, '11'.repeat(32)),
    ]];
    await assert.rejects(
      () => minswapV2.getPrice('ADA-USDA'),
      /outside sanity band/,
    );
  });

  await t('rejects spot above sanity ceiling', async () => {
    minswapV2._resetCache();
    // 100 ADA + 100B USDA would give spot 1e9 — far above 100 ceiling
    pageQueue = [[
      makePool(POL.USDA, NAME.USDA, 100_000n * 1_000_000n, 1_000_000_000n * 1_000_000_000n, '11'.repeat(32)),
    ]];
    await assert.rejects(
      () => minswapV2.getPrice('ADA-USDA'),
      /outside sanity band/,
    );
  });

  // ── Test 6: snapshot cache shared across pairs ───────────────────────
  await t('5 pair calls within TTL share one upstream fetch', async () => {
    minswapV2._resetCache();
    fetchCallCount = 0;
    pageQueue = [[
      makePool(POL.USDM, NAME.USDM, 4_000_000n * 1_000_000n, 1_000_000n * 1_000_000n),
      makePool(POL.USDA, NAME.USDA, 4_500_000n * 1_000_000n, 1_120_000n * 1_000_000n),
      makePool(POL.DJED, NAME.DJED, 277_000n * 1_000_000n, 69_000n * 1_000_000n),
      makePool(POL.IUSD, NAME.IUSD, 540_000n * 1_000_000n, 135_000n * 1_000_000n),
      makePool(POL.USDCx, NAME.USDCx, 26_000n * 1_000_000n, 6_500n * 1_000_000n),
    ]];
    await minswapV2.getPrice('ADA-USDM');
    await minswapV2.getPrice('ADA-USDA');
    await minswapV2.getPrice('ADA-DJED');
    await minswapV2.getPrice('ADA-iUSD');
    await minswapV2.getPrice('ADA-USDCx');
    assert.equal(fetchCallCount, 1, `expected 1 upstream fetch, got ${fetchCallCount}`);
  });

  // ── Test 7: parallel-call deduplication via in-flight promise ────────
  await t('parallel pair calls share one in-flight upstream fetch', async () => {
    minswapV2._resetCache();
    fetchCallCount = 0;
    pageQueue = [[
      makePool(POL.USDM, NAME.USDM, 4_000_000n * 1_000_000n, 1_000_000n * 1_000_000n),
      makePool(POL.USDA, NAME.USDA, 4_500_000n * 1_000_000n, 1_120_000n * 1_000_000n),
    ]];
    await Promise.all([
      minswapV2.getPrice('ADA-USDM'),
      minswapV2.getPrice('ADA-USDA'),
    ]);
    assert.equal(fetchCallCount, 1);
  });

  // ── Test 8: pagination — fetches more pages when first is full ───────
  await t('pagination: fetches additional pages until short page', async () => {
    minswapV2._resetCache();
    fetchCallCount = 0;
    // First page: 1000 entries (full), pool of interest on page 2
    const page1 = Array.from({ length: 1000 }, (_, i) =>
      makePool(POL.LP, '00', 100n, 100n, i.toString(16).padStart(64, '0')),
    );
    page1.length = 1000;
    pageQueue = [
      page1,
      [makePool(POL.USDM, NAME.USDM, 4_000_000n * 1_000_000n, 1_000_000n * 1_000_000n, 'aa'.repeat(32))],
    ];
    const q = await minswapV2.getPrice('ADA-USDM') as { price: number };
    const expected = 1_000_000 / 4_000_000;
    assert.ok(Math.abs(q.price - expected) < 1e-9);
    assert.equal(fetchCallCount, 2, 'should have fetched 2 pages');
  });

  // ── Test 9: rejects unknown pair ─────────────────────────────────────
  await t('rejects pair outside PAIR_CONFIG', async () => {
    minswapV2._resetCache();
    pageQueue = [[]];
    await assert.rejects(
      () => minswapV2.getPrice('ADA-SOMECOIN'),
      /pair 'ADA-SOMECOIN' not supported/,
    );
  });

  // ── Test 10: empty Koios response ────────────────────────────────────
  await t('errors gracefully when koios returns no UTxOs', async () => {
    minswapV2._resetCache();
    pageQueue = [[]];
    await assert.rejects(
      () => minswapV2.getPrice('ADA-USDM'),
      /no UTxOs at pool credential/,
    );
  });

  // ── Test 11: supportsPair scope ──────────────────────────────────────
  await t('supportsPair: covers exactly the 5 ADA-stable pairs', async () => {
    for (const p of ['ADA-USDM', 'ADA-USDA', 'ADA-DJED', 'ADA-iUSD', 'ADA-USDCx']) {
      assert.ok(minswapV2.supportsPair(p), `should support ${p}`);
    }
    assert.equal(minswapV2.supportsPair('ADA-USD'), false);
    assert.equal(minswapV2.supportsPair('NIGHT-ADA'), false);
    assert.equal(minswapV2.supportsPair('SNEK-ADA'), false);
  });

  // ── Test 12: returns PriceQuote with all required fields ─────────────
  await t('returns PriceQuote with required envelope fields', async () => {
    minswapV2._resetCache();
    pageQueue = [[
      makePool(POL.USDM, NAME.USDM, 4_000_000n * 1_000_000n, 1_000_000n * 1_000_000n),
    ]];
    const q = await minswapV2.getPrice('ADA-USDM') as { kind: string; sourceName: string; pair: string; price: number; timestamp: number; rawPayload: Record<string, unknown> };
    assert.equal(q.kind, 'price');
    assert.equal(q.sourceName, 'minswap-v2');
    assert.equal(q.pair, 'ADA-USDM');
    assert.ok(q.price > 0);
    assert.ok(q.timestamp > 0);
    assert.ok(q.rawPayload.poolCredential);
    assert.ok(q.rawPayload.adaReserve);
    assert.ok(q.rawPayload.tokenReserve);
  });

  // ── Test 13: skips pools with zero token reserve ─────────────────────
  await t('skips matching pool with zero token reserve', async () => {
    minswapV2._resetCache();
    pageQueue = [[
      makePool(POL.USDM, NAME.USDM, 4_000_000n * 1_000_000n, 0n, '11'.repeat(32)),
      makePool(POL.USDM, NAME.USDM, 100_000n * 1_000_000n, 25_000n * 1_000_000n, '22'.repeat(32)),
    ]];
    const q = await minswapV2.getPrice('ADA-USDM') as { rawPayload: { utxoTxHash: string } };
    assert.equal(q.rawPayload.utxoTxHash, '22'.repeat(32), 'should skip the zero-reserve pool');
  });

  globalThis.fetch = origFetch;

  console.log(`\n${n - fails}/${n} passed`);
  process.exit(fails ? 1 : 0);
}

main().catch(e => { console.error('runner crash:', e); process.exit(2); });
