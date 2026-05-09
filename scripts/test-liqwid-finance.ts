/**
 * Liqwid finance.ts — pure-function unit tests.
 *
 * No bridge, no GraphQL — exercises `recordAndDerive` + `deriveSupplyAPY`
 * with synthetic interestIndex deltas at known on-chain timestamps.
 *
 * Run: npx tsx scripts/test-liqwid-finance.ts
 */

import { strict as assert } from 'node:assert';
import {
  recordAndDerive, deriveSupplyAPY, MIN_DELTA_MS, _resetSnapshots,
} from '../srv/lib/liqwid-finance';

let n = 0, fails = 0;
function t(name: string, fn: () => void) {
  n++;
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) {
    fails++;
    const err = e as Error;
    console.log(`FAIL  ${name}\n      ${err.stack || err.message}`);
  }
}

console.log('liqwid-finance unit tests ─────────────────────────────────────');

// Realistic mainnet on-chain timestamp baseline (≈ 2026-05-09).
const T0 = 1_778_000_000_000;

t('first call returns null (no baseline)', () => {
  _resetSnapshots();
  const r = recordAndDerive('DJED', 1_000_000_000_000_000n, T0);
  assert.equal(r, null);
});

t('same lastInterestUpdateMs returns null without overwrite', () => {
  _resetSnapshots();
  recordAndDerive('DJED', 1_000_000_000_000_000n, T0);
  // Idle market: chain timestamp unchanged. Should NOT overwrite the baseline.
  const r = recordAndDerive('DJED', 1_005_000_000_000_000n, T0);
  assert.equal(r, null);
});

t('Δt below MIN_DELTA_MS returns null', () => {
  _resetSnapshots();
  recordAndDerive('DJED', 1_000_000_000_000_000n, T0);
  const r = recordAndDerive('DJED', 1_000_500_000_000_000n, T0 + MIN_DELTA_MS - 1_000);
  assert.equal(r, null);
});

t('Δindex=0 over fresh Δt returns null (no rate to measure)', () => {
  _resetSnapshots();
  recordAndDerive('DJED', 1_000_000_000_000_000n, T0);
  const r = recordAndDerive('DJED', 1_000_000_000_000_000n, T0 + MIN_DELTA_MS + 1);
  assert.equal(r, null);
});

t('non-monotonic interestIndex returns null', () => {
  _resetSnapshots();
  recordAndDerive('DJED', 1_000_000_000_000_000n, T0);
  const r = recordAndDerive('DJED', 999_000_000_000_000n, T0 + MIN_DELTA_MS + 1);
  assert.equal(r, null);
});

t('linear growth derives APR correctly (10% APR scenario)', () => {
  _resetSnapshots();
  // Baseline = 1e16. Choose Δindex so APR = 10% over a 5-min on-chain window.
  const baseline = 10_000_000_000_000_000n;  // 1e16
  const FIVE_MIN_MS = 5 * 60 * 1000;
  const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
  const expectedRate = 0.10 * (FIVE_MIN_MS / YEAR_MS);
  const delta = BigInt(Math.floor(Number(baseline) * expectedRate));
  recordAndDerive('USDM', baseline, T0);
  const r = recordAndDerive('USDM', baseline + delta, T0 + FIVE_MIN_MS);
  assert(r, 'expected derived rates');
  assert(Math.abs(r.borrowAPR - 0.10) < 0.005,
    `expected APR ≈ 0.10, got ${r.borrowAPR}`);
  // borrowAPY = e^APR - 1, for APR=0.10 → 0.10517...
  assert(Math.abs(r.borrowAPY - (Math.exp(0.10) - 1)) < 0.005,
    `expected APY ≈ 0.10517, got ${r.borrowAPY}`);
  assert.equal(r.observedDeltaMs, FIVE_MIN_MS);
  assert.equal(r.baselineAtMs, T0);
});

t('per-market snapshots independent', () => {
  _resetSnapshots();
  recordAndDerive('DJED', 1_000_000_000_000_000n, T0);
  recordAndDerive('USDM', 2_000_000_000_000_000n, T0);
  const t2 = T0 + MIN_DELTA_MS + 1_000;
  const rDjed = recordAndDerive('DJED', 1_010_000_000_000_000n, t2);
  const rUsdm = recordAndDerive('USDM', 2_005_000_000_000_000n, t2);
  assert(rDjed && rUsdm, 'both markets should derive');
  // DJED grew 1% in window, USDM 0.25% — APR ratios ~ 4:1.
  assert(rDjed.borrowAPR > rUsdm.borrowAPR * 3.5,
    `expected DJED APR significantly higher than USDM, got ${rDjed.borrowAPR} vs ${rUsdm.borrowAPR}`);
});

t('case-insensitive symbol keys', () => {
  _resetSnapshots();
  recordAndDerive('djed', 1_000_000_000_000_000n, T0);
  const r = recordAndDerive('DJED', 1_010_000_000_000_000n, T0 + MIN_DELTA_MS + 1);
  assert(r, 'expected derived rate (lowercase + uppercase share key)');
});

t('deriveSupplyAPY: standard Compound model', () => {
  // borrowAPY = 25%, util = 0.5, reserveFactor = 0.10 → supplyAPY = 25% × 0.5 × 0.9 = 11.25%
  const result = deriveSupplyAPY(0.25, 0.5);
  assert(Math.abs(result - 0.1125) < 1e-9, `expected 0.1125, got ${result}`);
});

t('deriveSupplyAPY: zero util → zero supply yield', () => {
  assert.equal(deriveSupplyAPY(0.25, 0), 0);
});

t('deriveSupplyAPY: custom reserveFactor', () => {
  // borrowAPY = 20%, util = 0.6, rf = 0.20 → 20% × 0.6 × 0.8 = 9.6%
  const result = deriveSupplyAPY(0.20, 0.6, 0.20);
  assert(Math.abs(result - 0.096) < 1e-9, `expected 0.096, got ${result}`);
});

console.log(`\n${n - fails}/${n} passed`);
process.exit(fails ? 1 : 0);
