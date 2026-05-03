/**
 * Liquidity-depth pure + integration tests.
 *
 * Stubs `fetchPools` (the test-seam injection point) with synthetic
 * pool reserves and asserts that the merged-pool constant-product math
 * produces the right slippage at each probed notional, the right
 * conservative-depth threshold, and the right per-pool reporting.
 *
 * Run: npx tsx scripts/test-liquidity-depth.ts
 */

import assert from 'node:assert/strict';
import { executableDepthForToken, interpolateCrossing, type PoolReserveSample } from '../srv/lib/liquidity-depth';

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

const close = (a: number, b: number, eps = 1e-3) => Math.abs(a - b) < eps;

// USDM tokenId — registered in stable-metadata.
const USDM_TOKEN = 'c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad' + '0014df105553444d';
// USDA tokenId for second-pair coverage.
const USDA_TOKEN = 'fe7c786ab321f41c654ef6c1af7b3250a613c24e4213e0425a7ae456' + '55534441';

/** Build a fixed-pool stub that ignores the pair argument. */
function poolsStub(samples: PoolReserveSample[]) {
  return async () => samples;
}

/** Hand-compute expected CP swap output for assertion clarity. */
function expectedDy(xRes: number, yRes: number, dxIn: number, feeFrac = 0.003): number {
  const dxAfterFee = dxIn * (1 - feeFrac);
  return (dxAfterFee * yRes) / (xRes + dxAfterFee);
}

async function main() {
console.log('liquidity-depth ─────────────────────────────────────────');

// ── interpolateCrossing pure-fn (preserved from previous impl) ──────
t('interpolate: no points → null', () => {
  assert.equal(interpolateCrossing([], 1.0), null);
});
t('interpolate: never crosses → null', () => {
  const r = interpolateCrossing([{x: 100, y: 0.1}, {x: 1000, y: 0.2}, {x: 10000, y: 0.5}], 1.0);
  assert.equal(r, null);
});
t('interpolate: first point already over → first x', () => {
  const r = interpolateCrossing([{x: 100, y: 2.0}, {x: 1000, y: 5.0}], 1.0);
  assert.deepEqual(r, { x: 100 });
});
t('interpolate: linear between two points (1% target between 0.5% and 1.5%)', () => {
  const r = interpolateCrossing([{x: 1000, y: 0.5}, {x: 10000, y: 1.5}], 1.0);
  assert.ok(r !== null);
  assert.ok(close(r!.x, 5500));
});
t('interpolate: flat segment → conservative lower x', () => {
  const r = interpolateCrossing([{x: 100, y: 1.0}, {x: 1000, y: 1.0}], 1.0);
  assert.deepEqual(r, { x: 100 });
});

// ── token-id resolution ──────────────────────────────────────────────
await t('rejects empty tokenId', async () => {
  await assert.rejects(() => executableDepthForToken(''), /tokenId must be a non-empty string/);
});

await t('rejects unregistered tokenId', async () => {
  await assert.rejects(
    () => executableDepthForToken('aa'.repeat(28) + 'bb'.repeat(4), { fetchPools: poolsStub([]) }),
    /not a registered stable/,
  );
});

// ── single-pool merged math ──────────────────────────────────────────
await t('single 4M-ADA pool: midPrice = yReserve / xReserve', async () => {
  const r = await executableDepthForToken(USDM_TOKEN, {
    fetchPools: poolsStub([
      { source: 'minswap-v2', adaReserve: 4_000_000, tokenReserve: 1_000_000 },
    ]),
  });
  assert.ok(r.midPrice !== null && close(r.midPrice, 0.25));
  assert.equal(r.pools.length, 1);
});

await t('single-pool: 100 ADA probe slippage matches CP+fee math', async () => {
  const r = await executableDepthForToken(USDM_TOKEN, {
    fetchPools: poolsStub([
      { source: 'minswap-v2', adaReserve: 4_000_000, tokenReserve: 1_000_000 },
    ]),
  });
  // dx=100, mid=0.25. dy = (100*0.997 * 1e6)/(4e6 + 99.7) ≈ 24.92 → eff ≈ 0.2492
  // slip = (0.25 - 0.2492)/0.25 × 100 ≈ 0.305%  (≈ 0.3% fee + tiny impact)
  const dyHand = expectedDy(4_000_000, 1_000_000, 100);
  const effHand = dyHand / 100;
  const slipHand = ((0.25 - effHand) / 0.25) * 100;
  assert.ok(close(r.probedPoints[0]!.effectivePrice, effHand, 1e-6));
  assert.ok(close(r.probedPoints[0]!.slippagePct, slipHand, 1e-3));
});

// ── multi-pool merge ─────────────────────────────────────────────────
await t('two pools merged: reserves summed for slippage math', async () => {
  const r = await executableDepthForToken(USDM_TOKEN, {
    fetchPools: poolsStub([
      { source: 'minswap-v2', adaReserve: 4_000_000, tokenReserve: 1_000_000 },
      { source: 'wingriders', adaReserve: 2_000_000, tokenReserve:   500_000 },
    ]),
  });
  // xTotal=6M, yTotal=1.5M, mid=0.25
  // dx=100k → dy = (99700 × 1.5e6) / (6e6 + 99700) ≈ 24508 → eff ≈ 0.24508
  // slip = (0.25 - 0.24508)/0.25 × 100 ≈ 1.97%
  assert.ok(close(r.midPrice!, 0.25));
  const probe100k = r.probedPoints.find(p => p.amountAda === 100_000)!;
  assert.ok(close(probe100k.slippagePct, 1.97, 0.05));
  assert.equal(r.pools.length, 2);
});

await t('three-pool merge sums reserves correctly', async () => {
  const r = await executableDepthForToken(USDM_TOKEN, {
    fetchPools: poolsStub([
      { source: 'minswap-v2', adaReserve: 4_000_000, tokenReserve: 1_000_000 },
      { source: 'wingriders', adaReserve: 2_000_000, tokenReserve:   500_000 },
      { source: 'sundae',     adaReserve: 1_900_000, tokenReserve:   475_000 },
    ]),
  });
  assert.equal(r.pools.length, 3);
  // mid = (1.000 + 0.500 + 0.475)M / (4 + 2 + 1.9)M = 1.975M / 7.9M = 0.25
  assert.ok(close(r.midPrice!, 0.25));
});

// ── conservative depth scan ──────────────────────────────────────────
await t('depth: largest probe within target slippage (1%, 4M+2M merged)', async () => {
  // Merged 6M ADA pool. For 1% target slip:
  //   100  → ~0.30% slip (mostly fee) ✓
  //   1k   → ~0.32% ✓
  //   10k  → ~0.47% ✓
  //   100k → ~1.97% ✗
  // Conservative depth = 10k.
  const r = await executableDepthForToken(USDM_TOKEN, {
    fetchPools: poolsStub([
      { source: 'minswap-v2', adaReserve: 4_000_000, tokenReserve: 1_000_000 },
      { source: 'wingriders', adaReserve: 2_000_000, tokenReserve:   500_000 },
    ]),
  });
  assert.equal(r.depthAda, 10_000);
  assert.equal(r.depthAtMaxProbed, false);
});

await t('depth: at-max-probed when ALL probes within target (deep pool)', async () => {
  // 100M-ADA virtual pool — 1M ADA probe still ≈ 0.30% slip (mostly fee).
  const r = await executableDepthForToken(USDM_TOKEN, {
    fetchPools: poolsStub([
      { source: 'minswap-v2', adaReserve: 100_000_000, tokenReserve: 25_000_000 },
    ]),
    targetSlippagePct: 2.0,
  });
  assert.equal(r.depthAtMaxProbed, true);
  assert.equal(r.depthAda, 1_000_000);
});

await t('depth: 0 when even smallest probe exceeds target (high fee, low target)', async () => {
  // 1% target with 0.3% fee is fine; flip target to 0.1% — every probe fails.
  const r = await executableDepthForToken(USDM_TOKEN, {
    fetchPools: poolsStub([
      { source: 'minswap-v2', adaReserve: 4_000_000, tokenReserve: 1_000_000 },
    ]),
    targetSlippagePct: 0.1,
  });
  assert.equal(r.depthAda, 0);
  assert.equal(r.depthAtMaxProbed, false);
});

// ── empty / degenerate inputs ────────────────────────────────────────
await t('no pools available → midPrice null, depth 0, all slips Infinity', async () => {
  const r = await executableDepthForToken(USDM_TOKEN, {
    fetchPools: poolsStub([]),
  });
  assert.equal(r.midPrice, null);
  assert.equal(r.depthAda, 0);
  assert.equal(r.depthAtMaxProbed, false);
  assert.ok(r.probedPoints.every(p => p.slippagePct === Infinity));
  assert.equal(r.pools.length, 0);
});

await t('zero-reserve pools filtered (CP swap output zero rejected)', async () => {
  // Single pool with zero token reserve — math degenerate.
  const r = await executableDepthForToken(USDM_TOKEN, {
    fetchPools: poolsStub([
      { source: 'minswap-v2', adaReserve: 4_000_000, tokenReserve: 0 },
    ]),
  });
  assert.equal(r.midPrice, null);
  assert.equal(r.depthAda, 0);
});

// ── custom probes + fee + target ─────────────────────────────────────
await t('custom probe set respected', async () => {
  const r = await executableDepthForToken(USDM_TOKEN, {
    fetchPools: poolsStub([
      { source: 'minswap-v2', adaReserve: 1_000_000, tokenReserve: 250_000 },
    ]),
    probesAda: [50, 500, 5000],
  });
  assert.equal(r.probedPoints.length, 3);
  assert.deepEqual(r.probedPoints.map(p => p.amountAda), [50, 500, 5000]);
});

await t('custom fee fraction changes slip — zero fee probe matches pure CP impact', async () => {
  const r = await executableDepthForToken(USDM_TOKEN, {
    fetchPools: poolsStub([
      { source: 'minswap-v2', adaReserve: 1_000_000, tokenReserve: 250_000 },
    ]),
    feeFraction: 0,   // no fee — pure constant-product impact
  });
  // 100 ADA into 1M ADA pool: dx_after_fee = 100, dy = (100 * 250k)/(1M + 100) ≈ 24.9975
  // eff = 0.249975 → slip = (0.25 - 0.249975)/0.25 × 100 = 0.01%
  assert.ok(close(r.probedPoints[0]!.slippagePct, 0.01, 0.005));
});

// ── result shape ─────────────────────────────────────────────────────
await t('routingMonotone always true under merged-pool CP', async () => {
  const r = await executableDepthForToken(USDM_TOKEN, {
    fetchPools: poolsStub([
      { source: 'minswap-v2', adaReserve: 4_000_000, tokenReserve: 1_000_000 },
    ]),
  });
  assert.equal(r.routingMonotone, true);
});

await t('per-pool reserves preserved on result for downstream consumers', async () => {
  const pools = [
    { source: 'minswap-v2', adaReserve: 4_000_000, tokenReserve: 1_000_000 },
    { source: 'wingriders', adaReserve: 2_000_000, tokenReserve:   500_000 },
  ];
  const r = await executableDepthForToken(USDA_TOKEN, { fetchPools: poolsStub(pools) });
  assert.deepEqual(r.pools, pools);
});

console.log(`\n${n - fails}/${n} passed`);
process.exit(fails ? 1 : 0);
}

main().catch(err => { console.error('runner crash:', err); process.exit(2); });
