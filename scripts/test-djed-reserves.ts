/**
 * DJED Reserve-Ratio adapter integration test.
 *
 * Mocks the ODATANO bridge (UTxOs at the reserve script) AND patches
 * `globalThis.fetch` to stub the two Minswap HTTP endpoints
 * (DJED metrics + ADA-USD aggregator) without hitting the network.
 *
 * Why fetch-patching instead of getJson-patching: `srv/adapters/http.ts`
 * uses named ES exports which tsx emits as non-configurable getters
 * (see CLAUDE.md "Module, die zur Laufzeit gepatcht werden müssen"),
 * so re-assigning `getJson` is rejected at runtime. The fetch primitive
 * underneath both `getJson` and `postJson` IS configurable on globalThis.
 *
 * Run: npx tsx scripts/test-djed-reserves.ts
 */

import assert from 'node:assert/strict';

const bridge = require('../srv/external/odatano-bridge');

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

type FetchResponseStub = { ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> };

function jsonResponse(body: unknown): FetchResponseStub {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function errorResponse(status: number, body: string): FetchResponseStub {
  return {
    ok: false,
    status,
    json: async () => { throw new Error('not json'); },
    text: async () => body,
  };
}

async function main() {
  const orig = {
    getUtxosAtAddress: bridge.getUtxosAtAddress,
    fetch:             globalThis.fetch,
  };

  // Per-test response map. Set by each test, consumed by the patched fetch.
  let responses: Map<string, FetchResponseStub | Error> = new Map();
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);
    const r = responses.get(url);
    if (r === undefined) throw new Error(`mock fetch: no response stubbed for ${url}`);
    if (r instanceof Error) throw r;
    return r as unknown as Response;
  }) as typeof globalThis.fetch;

  const djed = require('../srv/adapters/djed-reserves');
  const RESERVE_ADDR    = djed._RESERVE_SCRIPT_ADDRESS as string;
  const DJED_POLICY     = djed._DJED_POLICY as string;
  const DJED_NAME       = djed._DJED_ASSETNAMEHEX as string;
  const SHEN_NAME       = djed._SHEN_ASSETNAMEHEX as string;
  const DJED_ASSET_UNIT = djed._DJED_ASSET_UNIT as string;
  const SHEN_ASSET_UNIT = djed._SHEN_ASSET_UNIT as string;
  const ADA_PRICE_URL   = djed._MINSWAP_ADA_PRICE_URL as string;

  // Bridge.getAssetInfo mock — per-asset-unit response keyed by `unit`.
  const origBridgeGetAssetInfo = bridge.getAssetInfo;
  let assetInfoMap: Map<string, unknown | Error> = new Map();
  bridge.getAssetInfo = async (unit: string) => {
    const r = assetInfoMap.get(unit.toLowerCase());
    if (r === undefined) throw new Error(`mock bridge.getAssetInfo: no stub for unit ${unit}`);
    if (r instanceof Error) throw r;
    return r;
  };

  function mockUtxo(lovelace: bigint, djedRaw = 0n, shenRaw = 0n) {
    const assets: Array<{ policyId: string; assetNameHex: string; quantity: string }> = [];
    if (djedRaw > 0n) assets.push({ policyId: DJED_POLICY, assetNameHex: DJED_NAME, quantity: djedRaw.toString() });
    if (shenRaw > 0n) assets.push({ policyId: DJED_POLICY, assetNameHex: SHEN_NAME, quantity: shenRaw.toString() });
    return { lovelace: lovelace.toString(), assets };
  }

  console.log('djed-reserves integration ──────────────────────────────');

  await t('happy path: 36M ADA + 3.28M circulating DJED + ADA=$0.247 → ratio ≈ 272%', async () => {
    let capturedAddress = '';
    bridge.getUtxosAtAddress = async (address: string) => {
      capturedAddress = address;
      return [
        mockUtxo(20_000_000_000_000n, 100_000_000_000n, 500_000_000_000n),  // 20M ADA, 100k DJED, 500k SHEN
        mockUtxo(10_000_000_000_000n,  30_000_000_000n, 100_000_000_000n),  // 10M ADA
        mockUtxo( 6_124_354_090_000n,  18_179_652_111n, 96_216_240_891n),   // ~6.12M ADA
      ];
    };
    // CIP-68 pre-mint pattern: totalSupply = scriptInventory + userCirculating.
    // Mocks set totalSupply such that subtraction yields the desired
    // circulating values:
    //   DJED: scriptInventory 148,179,652,111 + circulating 3,280,606,347,889 = totalSupply 3,428,786,000,000
    //   SHEN: scriptInventory 696,216,240,891 + circulating 600,000,000,000   = totalSupply 1,296,216,240,891
    assetInfoMap = new Map<string, unknown | Error>([
      [DJED_ASSET_UNIT.toLowerCase(), { totalSupply: '3428786000000' }],
      [SHEN_ASSET_UNIT.toLowerCase(), { totalSupply: '1296216240891' }],
    ]);
    responses = new Map([
      [ADA_PRICE_URL, jsonResponse({ value: { price: 0.247 } })],
    ]);

    const q = await djed.getPrice('DJED-RESERVES');
    assert.equal(q.kind,       'attestation');
    assert.equal(q.sourceName, 'djed-reserves');
    assert.equal(q.pair,       'DJED-RESERVES');
    assert.equal(q.unit,       'ratio_pct');

    // Sanity: bridge was queried with the canonical reserve address.
    assert.equal(capturedAddress, RESERVE_ADDR);

    // Math (CIP-68 pre-mint pattern: circulating = totalSupply - scriptInventory):
    //   totalLovelace  = 36,124,354,090,000 → 36,124,354.09 ADA.
    //   inventoryRaw   = 100B + 30B + 18.179652111B = 148,179,652,111
    //   totalSupplyRaw = 3,428,786,000,000 (mock — represents the pre-mint constant)
    //   circulatingRaw = 3,428,786,000,000 - 148,179,652,111 = 3,280,606,347,889
    //   circulating    = 3,280,606,347,889 / 1e6 = 3,280,606.35 DJED
    //   collateralUsd  = 36,124,354.09 × 0.247 = 8,922,715.46 USD
    //   circulatingUsd = 3,280,606.35 × 1.0    = 3,280,606.35 USD
    //   ratioPct       = 8,922,715.46 / 3,280,606.35 × 100 ≈ 272.0%
    assert.ok(Math.abs(q.value - 272.0) < 0.5, `expected ~272% ratio, got ${q.value}`);

    const raw = q.rawPayload as {
      adaCollateral: number; djedCirculating: number; adaUsdReference: number;
      utxoCount: number; healthBucket: string;
      djedReserveInventoryRaw: string; shenReserveInventoryRaw: string;
    };
    assert.equal(raw.utxoCount,        3);
    assert.equal(raw.adaCollateral,    36_124_354.09);
    assert.ok(Math.abs(raw.djedCirculating - 3_280_606.347889) < 0.01,
      `expected djedCirculating ≈ 3,280,606.35, got ${raw.djedCirculating}`);
    assert.equal(raw.adaUsdReference,  0.247);
    assert.equal(raw.djedReserveInventoryRaw, '148179652111');
    assert.equal(raw.shenReserveInventoryRaw, '696216240891');
    // 260% < 400% (warn) but ≥ 200% (alert) → 'alert'
    assert.equal(raw.healthBucket, 'alert');

    // SHEN cushion: collateralUsd - circulatingUsd = 8,922,715 - 3,280,606 ≈ 5,642,109
    const rawCushion = q.rawPayload as {
      cushionUsd: number; cushionPctOfDjed: number;
      shenCirculating: number | null; equityPerShenUsd: number | null;
    };
    assert.ok(Math.abs(rawCushion.cushionUsd - 5_642_109) < 100,
      `expected ~5.64M cushion, got ${rawCushion.cushionUsd}`);
    // cushionPctOfDjed = ratioPct - 100 = 272.0 - 100 = 172.0
    assert.ok(Math.abs(rawCushion.cushionPctOfDjed - 172.0) < 0.5,
      `expected ~172%, got ${rawCushion.cushionPctOfDjed}`);
    // Per-SHEN equity = cushionUsd / shenCirculating = 5,642,109 / 600,000 ≈ $9.40
    assert.equal(rawCushion.shenCirculating, 600_000);
    assert.ok(rawCushion.equityPerShenUsd !== null);
    assert.ok(Math.abs(rawCushion.equityPerShenUsd! - 9.40) < 0.01,
      `expected ~9.40 per SHEN, got ${rawCushion.equityPerShenUsd}`);
  });

  await t('SHEN asset-info failure → equityPerShenUsd is null, rest unchanged', async () => {
    bridge.getUtxosAtAddress = async () => [mockUtxo(36_000_000_000_000n, 1n)];
    assetInfoMap = new Map<string, unknown | Error>([
      [DJED_ASSET_UNIT.toLowerCase(), { totalSupply: '3000000000001' }],
      [SHEN_ASSET_UNIT.toLowerCase(), new Error('shen-asset-not-indexed')],
    ]);
    responses = new Map<string, FetchResponseStub | Error>([
      [ADA_PRICE_URL, jsonResponse({ value: { price: 0.247 } })],
    ]);
    const q = await djed.getPrice('DJED-RESERVES');
    const raw = q.rawPayload as { shenCirculating: number | null; equityPerShenUsd: number | null; cushionUsd: number };
    assert.equal(raw.shenCirculating, null);
    assert.equal(raw.equityPerShenUsd, null);
    // Cushion still computed — non-SHEN math unaffected.
    assert.ok(raw.cushionUsd > 0, 'cushion should still be computed despite SHEN failure');
    assert.ok(Number.isFinite(q.value), 'ratio still computed');
  });

  await t('healthy bucket at 1000% coverage', async () => {
    bridge.getUtxosAtAddress = async () => [mockUtxo(100_000_000_000_000n, 1n)];  // 100M ADA, trace DJED
    assetInfoMap = new Map<string, unknown | Error>([
      [DJED_ASSET_UNIT.toLowerCase(), { totalSupply: '3000000000001' }],
      [SHEN_ASSET_UNIT.toLowerCase(), { totalSupply: '600000000000' }],
    ]);
    responses = new Map([
      [ADA_PRICE_URL, jsonResponse({ value: { price: 0.30 } })],
    ]);
    const q = await djed.getPrice('DJED-RESERVES');
    // ratio = 100M × 0.30 / 3M = 1000%
    assert.ok(q.value > 800, `expected ≥ 800, got ${q.value}`);
    assert.equal((q.rawPayload as { healthBucket: string }).healthBucket, 'healthy');
  });

  await t('warning bucket at 500% coverage (between 400 and 800)', async () => {
    // Reserve UTxO carries token inventory — required by the inventory filter
    // (else the ADA wouldn't be counted as reserves). 1 raw unit is enough.
    bridge.getUtxosAtAddress = async () => [mockUtxo(50_000_000_000_000n, 1n)];  // 50M ADA, trace DJED
    assetInfoMap = new Map<string, unknown | Error>([
      [DJED_ASSET_UNIT.toLowerCase(), { totalSupply: '3000000000001' }],   // +1 to absorb the trace inventory
      [SHEN_ASSET_UNIT.toLowerCase(), { totalSupply: '600000000000' }],
    ]);
    responses = new Map([
      [ADA_PRICE_URL, jsonResponse({ value: { price: 0.30 } })],
    ]);
    const q = await djed.getPrice('DJED-RESERVES');
    // ratio = 50M × 0.30 / 3M = 500%
    assert.ok(q.value >= 400 && q.value < 800, `expected 400-800, got ${q.value}`);
    assert.equal((q.rawPayload as { healthBucket: string }).healthBucket, 'warning');
  });

  await t('critical bucket at 90% coverage (depeg territory)', async () => {
    bridge.getUtxosAtAddress = async () => [mockUtxo(9_000_000_000_000n, 1n)];   // 9M ADA, trace DJED
    assetInfoMap = new Map<string, unknown | Error>([
      [DJED_ASSET_UNIT.toLowerCase(), { totalSupply: '3000000000001' }],
      [SHEN_ASSET_UNIT.toLowerCase(), { totalSupply: '600000000000' }],
    ]);
    responses = new Map([
      [ADA_PRICE_URL, jsonResponse({ value: { price: 0.30 } })],
    ]);
    const q = await djed.getPrice('DJED-RESERVES');
    // ratio = 9M × 0.30 / 3M = 90%
    assert.ok(q.value < 200, `expected < 200, got ${q.value}`);
    assert.equal((q.rawPayload as { healthBucket: string }).healthBucket, 'critical');
  });

  await t('rejects unsupported pair', async () => {
    await assert.rejects(() => djed.getPrice('FOO-BAR'), /pair 'FOO-BAR' not supported/);
  });

  await t('rejects when reserve script has no UTxOs', async () => {
    bridge.getUtxosAtAddress = async () => [];
    await assert.rejects(() => djed.getPrice('DJED-RESERVES'), /no UTxOs at reserve script/);
  });

  await t('rejects when bridge returns no totalSupply for DJED', async () => {
    bridge.getUtxosAtAddress = async () => [mockUtxo(36_000_000_000_000n, 1n)];
    assetInfoMap = new Map<string, unknown | Error>([
      [DJED_ASSET_UNIT.toLowerCase(), {}],   // no totalSupply
      [SHEN_ASSET_UNIT.toLowerCase(), { totalSupply: '600000000000' }],
    ]);
    responses = new Map([
      [ADA_PRICE_URL, jsonResponse({ value: { price: 0.247 } })],
    ]);
    await assert.rejects(() => djed.getPrice('DJED-RESERVES'), /no totalSupply for DJED/);
  });

  await t('rejects when ADA-USD reference is missing/zero', async () => {
    bridge.getUtxosAtAddress = async () => [mockUtxo(36_000_000_000_000n, 1n)];
    assetInfoMap = new Map<string, unknown | Error>([
      [DJED_ASSET_UNIT.toLowerCase(), { totalSupply: '3000000000001' }],
      [SHEN_ASSET_UNIT.toLowerCase(), { totalSupply: '600000000000' }],
    ]);
    responses = new Map([
      [ADA_PRICE_URL, jsonResponse({ value: { price: 'not-a-number' } })],
    ]);
    await assert.rejects(() => djed.getPrice('DJED-RESERVES'), /invalid ADA-USD reference/);
  });

  await t('propagates bridge.getAssetInfo errors for DJED', async () => {
    bridge.getUtxosAtAddress = async () => [mockUtxo(36_000_000_000_000n, 1n)];
    assetInfoMap = new Map<string, unknown | Error>([
      [DJED_ASSET_UNIT.toLowerCase(), new Error('odatano-backend-503')],
      [SHEN_ASSET_UNIT.toLowerCase(), { totalSupply: '600000000000' }],
    ]);
    responses = new Map<string, FetchResponseStub | Error>([
      [ADA_PRICE_URL, jsonResponse({ value: { price: 0.247 } })],
    ]);
    await assert.rejects(() => djed.getPrice('DJED-RESERVES'), /odatano-backend-503/);
  });

  await t('rejects when reserve UTxOs carry no DJED/SHEN inventory (script retired/wrong address)', async () => {
    // UTxOs exist at the address but none carry DJED or SHEN — i.e. the address
    // hosts unrelated value or has been emptied. Pre-fix this would silently
    // sum the lovelace and over-state coverage.
    bridge.getUtxosAtAddress = async () => [mockUtxo(50_000_000_000_000n)];   // no inventory
    assetInfoMap = new Map<string, unknown | Error>([
      [DJED_ASSET_UNIT.toLowerCase(), { totalSupply: '3000000000000' }],
      [SHEN_ASSET_UNIT.toLowerCase(), { totalSupply: '600000000000' }],
    ]);
    responses = new Map([
      [ADA_PRICE_URL, jsonResponse({ value: { price: 0.30 } })],
    ]);
    await assert.rejects(
      () => djed.getPrice('DJED-RESERVES'),
      /no UTxOs at .* carry DJED\/SHEN inventory/,
    );
  });

  await t('supportsPair: only DJED-RESERVES, nothing else', async () => {
    assert.equal(djed.supportsPair('DJED-RESERVES'), true);
    assert.equal(djed.supportsPair('USDM-RESERVES'), false);
    assert.equal(djed.supportsPair('ADA-DJED'),      false);
    assert.equal(djed.supportsPair(''),              false);
  });

  // restore globals so tests/runners after this don't see polluted state
  bridge.getUtxosAtAddress = orig.getUtxosAtAddress;
  bridge.getAssetInfo      = origBridgeGetAssetInfo;
  globalThis.fetch         = orig.fetch;

  console.log(`\n${n - fails}/${n} passed`);
  process.exit(fails ? 1 : 0);
}

main().catch(err => { console.error('runner crash:', err); process.exit(2); });
