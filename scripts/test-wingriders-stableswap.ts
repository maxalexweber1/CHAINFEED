/**
 * WingRiders V2 STABLESWAP adapter tests. Mocks `globalThis.fetch` to
 * feed synthetic GraphQL responses; tests the find-pool logic + math.
 *
 * Run: npx tsx scripts/test-wingriders-stableswap.ts
 */

import assert from 'node:assert/strict';

let n = 0, fails = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  n++;
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (e) {
    fails++;
    const err = e as Error;
    console.log(`FAIL  ${name}\n      ${err.stack || err.message}`);
  }
}

const close = (a: number, b: number, eps = 1e-4) => Math.abs(a - b) < eps;

// ── Asset hex shorthands matching the adapter's POL/NAME constants ──
const POL_DJED = '8db269c3ec630e06ae29f74bc39edd1f87c819f1056206e879a1cd61';
const POL_USDM = 'c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad';
const POL_iUSD = 'f66d78b4a3cb3d37afa0ec36461e51ecbde00f26c8f0a68f94b69880';
const POL_USDA = 'fe7c786ab321f41c654ef6c1af7b3250a613c24e4213e0425a7ae456';
const POL_DAI  = '25c5de5f5b286073c593edfd77b48abc7a48e5a4f3d4cd9d428ff935';
const N_DJED   = '446a65644d6963726f555344';
const N_USDM   = '0014df105553444d';
const N_iUSD   = '69555344';
const N_USDA   = '55534441';
const N_DAI    = '444149';

interface MockToken { policyId: string; assetName: string; quantity: string }
interface MockPool {
  poolType: 'CONSTANT_PRODUCT' | 'STABLESWAP';
  tokenA: MockToken;
  tokenB: MockToken;
  treasuryA: string;
  treasuryB: string;
  scaleA: string;
  scaleB: string;
  tvlInAda: string | null;
}

function pool(opts: Partial<MockPool> & Pick<MockPool, 'tokenA' | 'tokenB'>): MockPool {
  return {
    poolType:  'STABLESWAP',
    treasuryA: '0', treasuryB: '0',
    scaleA:    '1', scaleB:    '1',
    tvlInAda:  '500000000000000',  // 500M lovelace = 500k ADA, well above floor
    ...opts,
  };
}

function tok(policyId: string, assetName: string, quantity: string): MockToken {
  return { policyId, assetName, quantity };
}

type FetchStub = { ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> };
const jsonResp = (body: unknown): FetchStub => ({
  ok: true, status: 200,
  json: async () => body,
  text: async () => JSON.stringify(body),
});
const errResp = (status: number): FetchStub => ({
  ok: false, status,
  json: async () => { throw new Error('not json'); },
  text: async () => 'error',
});

async function main() {
  const orig = { fetch: globalThis.fetch };
  let resp: FetchStub | Error = jsonResp({ data: { liquidityPools: [] } });
  globalThis.fetch = (async () => {
    if (resp instanceof Error) throw resp;
    return resp as unknown as Response;
  }) as typeof globalThis.fetch;

  const adapter = require('../srv/adapters/wingriders-stableswap');

  console.log('wingriders-stableswap ───────────────────────────────────');

  // ── happy path: USDM-DJED pool found, ratio computed correctly ─────
  await t('USDM-DJED: pool with 100M USDM + 99M DJED → spot ≈ 0.99', async () => {
    // After treasury subtraction: activeA=100M USDM, activeB=99M DJED
    // Pair USDM-DJED → tokenA=USDM, tokenB=DJED → "DJED per 1 USDM"
    // Ratio: 99M / 100M = 0.99
    resp = jsonResp({
      data: { liquidityPools: [pool({
        tokenA:    tok(POL_USDM, N_USDM, '105000000'),
        tokenB:    tok(POL_DJED, N_DJED, '104500000'),
        treasuryA: '5000000', treasuryB: '5500000',  // → active 100M / 99M
      })] },
    });
    const q = await adapter.getPrice('USDM-DJED');
    assert.equal(q.kind, 'price');
    assert.equal(q.sourceName, 'wingriders-stableswap');
    assert.equal(q.pair, 'USDM-DJED');
    assert.ok(close(q.price, 0.99, 1e-6), `expected 0.99, got ${q.price}`);
    const raw = q.rawPayload as { poolKind: string; activeReserveA: string; activeReserveB: string };
    assert.equal(raw.poolKind, 'STABLESWAP');
    assert.equal(raw.activeReserveA, '100000000');
    assert.equal(raw.activeReserveB, '99000000');
  });

  // ── inverted pair: same pool, opposite direction ───────────────────
  await t('DJED-USDM: same pool returns inverse ratio (USDM per 1 DJED)', async () => {
    resp = jsonResp({
      data: { liquidityPools: [pool({
        tokenA:    tok(POL_USDM, N_USDM, '105000000'),
        tokenB:    tok(POL_DJED, N_DJED, '104500000'),
        treasuryA: '5000000', treasuryB: '5500000',
      })] },
    });
    const q = await adapter.getPrice('DJED-USDM');
    // Pair DJED-USDM → tokenA=DJED, tokenB=USDM → USDM per 1 DJED
    // The same pool but flipped: 100M / 99M = 1.0101
    assert.ok(close(q.price, 100 / 99, 1e-4), `expected ~1.0101, got ${q.price}`);
    // rawPayload reflects pair-direction orientation
    const raw = q.rawPayload as { activeReserveA: string; activeReserveB: string };
    assert.equal(raw.activeReserveA, '99000000');     // DJED active
    assert.equal(raw.activeReserveB, '100000000');    // USDM active
  });

  // ── perfect peg ─────────────────────────────────────────────────────
  await t('balanced pool (1:1) → exactly 1.0', async () => {
    resp = jsonResp({
      data: { liquidityPools: [pool({
        tokenA:    tok(POL_USDM, N_USDM, '50000000'),
        tokenB:    tok(POL_USDA, N_USDA, '50000000'),
      })] },
    });
    const q = await adapter.getPrice('USDM-USDA');
    assert.equal(q.price, 1.0);
  });

  // ── treasury subtraction works ─────────────────────────────────────
  await t('treasury fields properly subtracted (raw quantities ignored)', async () => {
    resp = jsonResp({
      data: { liquidityPools: [pool({
        // raw 1B / 1B but treasury bites half of A — active 500M / 1B → spot 2.0
        tokenA:    tok(POL_USDM, N_USDM, '1000000000'),
        tokenB:    tok(POL_DJED, N_DJED, '1000000000'),
        treasuryA: '500000000', treasuryB: '0',
      })] },
    });
    const q = await adapter.getPrice('USDM-DJED');
    assert.equal(q.price, 2.0);
  });

  // ── scale factors honored ──────────────────────────────────────────
  await t('scale factors multiplied into reserves', async () => {
    resp = jsonResp({
      data: { liquidityPools: [pool({
        tokenA:    tok(POL_USDM, N_USDM, '100000000'),
        tokenB:    tok(POL_DJED, N_DJED, '100000000'),
        scaleA:    '1', scaleB:    '2',   // tokenB scaled 2× → effective B = 200M
      })] },
    });
    const q = await adapter.getPrice('USDM-DJED');
    assert.equal(q.price, 2.0);
  });

  // ── pool selection ─────────────────────────────────────────────────
  await t('CONSTANT_PRODUCT pools are skipped (only STABLESWAP considered)', async () => {
    resp = jsonResp({
      data: { liquidityPools: [
        pool({
          poolType:  'CONSTANT_PRODUCT',
          tokenA:    tok(POL_USDM, N_USDM, '99'),
          tokenB:    tok(POL_DJED, N_DJED, '101'),
        }),
        // ↑ would give bogus result if not filtered
      ] },
    });
    await assert.rejects(() => adapter.getPrice('USDM-DJED'), /no STABLESWAP pool matching/);
  });

  await t('TVL floor: dust pools rejected', async () => {
    resp = jsonResp({
      data: { liquidityPools: [pool({
        tokenA:    tok(POL_USDM, N_USDM, '50000000'),
        tokenB:    tok(POL_DJED, N_DJED, '50000000'),
        tvlInAda:  '500',   // 500 lovelace = 0.0005 ADA — way below 1000-ADA floor
      })] },
    });
    await assert.rejects(() => adapter.getPrice('USDM-DJED'), /no STABLESWAP pool matching/);
  });

  await t('null tvlInAda: falls back to raw-quantity floor (qty sum check)', async () => {
    resp = jsonResp({
      data: { liquidityPools: [pool({
        tokenA:    tok(POL_USDM, N_USDM, '600000000'),
        tokenB:    tok(POL_DJED, N_DJED, '500000000'),
        tvlInAda:  null,    // GraphQL didn't compute one
        // raw qty sum = 1.1B = 1100 ADA-equivalent → above 1000-ADA floor
      })] },
    });
    const q = await adapter.getPrice('USDM-DJED');
    assert.ok(close(q.price, 5/6, 1e-4));
  });

  await t('matches first pool when multiple candidates exist', async () => {
    resp = jsonResp({
      data: { liquidityPools: [
        pool({
          tokenA:    tok(POL_USDM, N_USDM, '100000000'),
          tokenB:    tok(POL_DJED, N_DJED, '100000000'),
        }),
        pool({
          tokenA:    tok(POL_USDM, N_USDM, '50000000'),
          tokenB:    tok(POL_DJED, N_DJED, '50000000'),
        }),
      ] },
    });
    const q = await adapter.getPrice('USDM-DJED');
    // First pool → 1.0
    assert.equal(q.price, 1.0);
  });

  // ── error paths ────────────────────────────────────────────────────
  await t('rejects unsupported pair', async () => {
    await assert.rejects(() => adapter.getPrice('FOO-BAR'), /not supported/);
  });

  await t('rejects when GraphQL returns errors[]', async () => {
    resp = jsonResp({ errors: [{ message: 'syntax error' }] });
    await assert.rejects(() => adapter.getPrice('USDM-DJED'), /graphql errors/);
  });

  await t('rejects when pool list is empty', async () => {
    resp = jsonResp({ data: { liquidityPools: [] } });
    await assert.rejects(() => adapter.getPrice('USDM-DJED'), /returned empty list/);
  });

  await t('rejects when no matching STABLESWAP pool exists', async () => {
    // Only iUSD-USDA pool — won't match a USDM-DJED query
    resp = jsonResp({
      data: { liquidityPools: [pool({
        tokenA:    tok(POL_iUSD, N_iUSD, '100000000'),
        tokenB:    tok(POL_USDA, N_USDA, '100000000'),
      })] },
    });
    await assert.rejects(() => adapter.getPrice('USDM-DJED'), /no STABLESWAP pool matching/);
  });

  await t('propagates fetch errors', async () => {
    resp = errResp(503);
    await assert.rejects(() => adapter.getPrice('USDM-DJED'), /503/);
  });

  // ── all 10 supported pairs are routable ────────────────────────────
  await t('supportsPair: 8 documented stable-stable pairs (DAI-DJED excluded — dust)', () => {
    const expected = [
      'DJED-USDM', 'iUSD-USDM', 'USDA-USDM',
      'USDM-DJED', 'USDM-iUSD', 'USDM-USDA',
      'DJED-iUSD', 'iUSD-DJED',
    ];
    for (const p of expected) {
      assert.equal(adapter.supportsPair(p), true, `should support ${p}`);
    }
    assert.equal(adapter.supportsPair('DAI-DJED'),  false, 'DAI-DJED dust-pool excluded');
    assert.equal(adapter.supportsPair('ADA-USDM'),  false);
    assert.equal(adapter.supportsPair('NIGHT-ADA'), false);
    assert.equal(adapter.supportsPair(''),          false);
  });

  globalThis.fetch = orig.fetch;
  console.log(`\n${n - fails}/${n} passed`);
  process.exit(fails ? 1 : 0);
}

main().catch(err => { console.error('runner crash:', err); process.exit(2); });
