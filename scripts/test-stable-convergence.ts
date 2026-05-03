/**
 * Cross-stable convergence pure-fn tests.
 * Run: npx tsx scripts/test-stable-convergence.ts
 */

import assert from 'node:assert/strict';
import {
  computeConvergenceMatrix, perSymbolDeviation,
} from '../srv/lib/stable-convergence';

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

const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

console.log('stable-convergence ──────────────────────────────────────');

// ── basic shape ──────────────────────────────────────────────────────
t('empty input → empty result, score 1.0', () => {
  const m = computeConvergenceMatrix({ adaPrices: {} });
  assert.deepEqual(m.symbols, []);
  assert.deepEqual(m.matrix, {});
  assert.equal(m.convergenceScore, 1.0);
  assert.equal(m.maxDeviationPct, 0);
  assert.deepEqual(m.outliers, []);
});

t('single symbol → no cross-rates, score 1.0 (vacuously converged)', () => {
  const m = computeConvergenceMatrix({ adaPrices: { USDM: 0.247 } });
  assert.deepEqual(m.symbols, ['USDM']);
  assert.deepEqual(m.matrix.USDM, {});
  assert.equal(m.convergenceScore, 1.0);
});

t('two perfectly-pegged stables → all cross-rates at 1.000, score 1.0', () => {
  const m = computeConvergenceMatrix({
    adaPrices: { USDM: 0.247, USDA: 0.247 },
  });
  assert.equal(m.symbols.length, 2);
  assert.ok(close(m.matrix.USDM!.USDA!.impliedRate, 1.0));
  assert.ok(close(m.matrix.USDM!.USDA!.deviationPct, 0));
  assert.ok(close(m.matrix.USDA!.USDM!.impliedRate, 1.0));
  assert.equal(m.maxDeviationPct, 0);
  assert.equal(m.convergenceScore, 1.0);
  assert.deepEqual(m.outliers, []);
});

// ── sort order ──────────────────────────────────────────────────────
t('symbols sorted alphabetically', () => {
  const m = computeConvergenceMatrix({
    adaPrices: { USDM: 0.247, DJED: 0.247, iUSD: 0.247 },
  });
  assert.deepEqual(m.symbols, ['DJED', 'USDM', 'iUSD']);
});

// ── deviation math ──────────────────────────────────────────────────
t('one stable 1% off → maxDeviation ≈ 1.0%, score ≈ 0.8', () => {
  // ADA-USDM cheaper than ADA-DJED → USDM is cheaper than DJED in ADA terms,
  // i.e. 1 USDM gets you fewer DJED. Implied DJED/USDM = 0.247/0.2495 ≈ 0.99.
  const m = computeConvergenceMatrix({
    adaPrices: { USDM: 0.247, DJED: 0.2495 },
  });
  // implied B per A = b / a. matrix[USDM][DJED] = 0.2495 / 0.247 = 1.01012...
  assert.ok(close(m.matrix.USDM!.DJED!.impliedRate, 1.01012, 1e-4));
  assert.ok(close(m.matrix.DJED!.USDM!.impliedRate, 0.98996, 1e-4));
  // maxDev ~1.012%
  assert.ok(m.maxDeviationPct > 1.0 && m.maxDeviationPct < 1.1);
  // score = 1 - 1.012/5 ≈ 0.798
  assert.ok(m.convergenceScore > 0.7 && m.convergenceScore < 0.85);
});

t('matrix is anti-symmetric (ish): A→B and B→A devs are inverses', () => {
  const m = computeConvergenceMatrix({
    adaPrices: { USDM: 0.247, DJED: 0.245 },
  });
  // Both deviations exist, A→B is positive when A is dearer (a < b means
  // implied B/A > 1 → positive dev); B→A then negative.
  const ab = m.matrix.DJED!.USDM!.deviationPct;
  const ba = m.matrix.USDM!.DJED!.deviationPct;
  assert.ok(ab * ba < 0, 'anti-symmetric signs');
});

// ── score scaling ───────────────────────────────────────────────────
t('5% spread → score 0.0 (clamped)', () => {
  // ADA-USDM and ADA-DJED with 5% spread between them
  const m = computeConvergenceMatrix({
    adaPrices: { USDM: 0.247, DJED: 0.247 * 1.05 },
  });
  assert.equal(m.convergenceScore, 0);
});

t('10% spread → score still clamped at 0', () => {
  const m = computeConvergenceMatrix({
    adaPrices: { USDM: 0.247, DJED: 0.247 * 1.10 },
  });
  assert.equal(m.convergenceScore, 0);
});

// ── outlier detection ───────────────────────────────────────────────
t('one rogue stable in a basket of 4 → flagged as outlier', () => {
  // 3 stables at peg, 1 rogue at 5% premium
  const m = computeConvergenceMatrix({
    adaPrices: {
      USDM:  0.2470,
      USDA:  0.2470,
      iUSD:  0.2470,
      DJED:  0.2470 * 1.05,    // 5% off everyone else
    },
  });
  // DJED's median deviation against {USDM, USDA, iUSD} = 5% > warningBand
  assert.ok(m.outliers.includes('DJED'), `expected DJED in outliers, got ${m.outliers.join(',')}`);
  // The other three see DJED as their only outlier; their median against the
  // peer-set is 0% (perfect peer match) — so they should NOT be flagged.
  // Median of [0, 0, 5] = 0 → not outliers.
  assert.equal(m.outliers.length, 1);
});

t('all stables equally spread → multiple outliers', () => {
  // 4 stables each 1% apart from each other — no clear "rogue" but cohesion
  // is poor. Each has a non-trivial median deviation.
  const m = computeConvergenceMatrix({
    adaPrices: {
      A: 0.245,
      B: 0.247,
      C: 0.249,
      D: 0.251,
    },
    warningBandPct: 0.5,    // tighter band to surface this
  });
  // Each symbol's median absolute deviation across peers > 0.5%
  assert.ok(m.outliers.length >= 2, `expected ≥2 outliers, got ${m.outliers.length}`);
});

// ── input validation ────────────────────────────────────────────────
t('non-positive / non-finite prices silently dropped', () => {
  const m = computeConvergenceMatrix({
    adaPrices: {
      USDM:  0.247,
      USDA:  0.247,
      DJED:  0,            // dropped
      iUSD:  NaN,          // dropped
      USDCx: -1.0,         // dropped
    },
  });
  assert.deepEqual(m.symbols.sort(), ['USDA', 'USDM']);
});

// ── perSymbolDeviation helper ───────────────────────────────────────
t('perSymbolDeviation returns median-abs-deviation per symbol', () => {
  const m = computeConvergenceMatrix({
    adaPrices: {
      USDM:  0.2470,
      USDA:  0.2470,
      iUSD:  0.2470,
      DJED:  0.2470 * 1.05,
    },
  });
  const dev = perSymbolDeviation(m);
  // DJED ~5% off all 3 others → median = 5%
  assert.ok(dev.DJED! > 4.5 && dev.DJED! < 5.5);
  // USDM/USDA/iUSD against peers: [0, 0, 5] median = 0
  assert.ok(dev.USDM! < 0.1);
  assert.ok(dev.USDA! < 0.1);
  assert.ok(dev.iUSD! < 0.1);
});

// ── realistic CHAINFEED snapshot ────────────────────────────────────
t('realistic snapshot: 5 stables on near-peg → high score, no outliers', () => {
  const m = computeConvergenceMatrix({
    adaPrices: {
      USDM:  0.2476,
      DJED:  0.2484,
      iUSD:  0.2470,
      USDA:  0.2480,
      USDCx: 0.2466,
    },
  });
  // Spread is ~0.7% — within warning band by default.
  assert.ok(m.convergenceScore > 0.85, `expected ≥0.85, got ${m.convergenceScore}`);
  assert.deepEqual(m.outliers, []);
});

t('Wanchain USDT off-peg badly → flagged as severe outlier', () => {
  const m = computeConvergenceMatrix({
    adaPrices: {
      USDM:  0.247,
      USDA:  0.247,
      USDCx: 0.247,
      USDT:  0.199,    // Wanchain USDT, ~24% off-peg
    },
  });
  assert.ok(m.outliers.includes('USDT'));
  assert.ok(m.maxDeviationPct > 20);
  assert.equal(m.convergenceScore, 0);     // clamped
});

console.log(`\n${n - fails}/${n} passed`);
process.exit(fails ? 1 : 0);
