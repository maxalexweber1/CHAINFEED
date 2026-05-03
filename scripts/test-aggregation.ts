/**
 * Unit tests for the aggregation engine.
 * Run: npx tsx scripts/test-aggregation.ts
 */

import assert from 'node:assert/strict';
import {
  median, weightedMedian, stddev, confidence, deviationPct, aggregate, twap,
  pegDeviationBps, SINGLE_SOURCE_CONFIDENCE_CAP,
} from '../srv/aggregation';

let n = 0, fails = 0;
function t(name: string, fn: () => void | Promise<void>) {
  n++;
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) {
    fails++;
    const err = e as Error;
    console.log(`FAIL  ${name}\n      ${err.stack || err.message}`);
  }
}

const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

console.log('aggregation ─────────────────────────────────────────────');

// ── median ────────────────────────────────────────────────────────────
t('median: throws on empty', () => assert.throws(() => median([]), /empty/));
t('median: single value', () => assert.equal(median([42]), 42));
t('median: odd length', () => assert.equal(median([1, 5, 3]), 3));
t('median: even length averages middle two', () => assert.equal(median([1, 2, 3, 4]), 2.5));
t('median: handles negatives + zeros', () => assert.equal(median([-1, 0, 1]), 0));
t('median: robust to single outlier', () => {
  // Three honest sources at ~0.50, one rogue at 100. Median should still be ~0.50.
  assert.equal(median([0.49, 0.50, 0.51, 100]), (0.50 + 0.51) / 2);
});

// ── weightedMedian ────────────────────────────────────────────────────
t('weightedMedian: equal weights matches median', () =>
  assert.equal(weightedMedian([1, 2, 3], [1, 1, 1]), 2));
t('weightedMedian: heavy weight on outlier shifts result', () =>
  // values [1,2,3], weights [1,1,5] — sorted is same; cumulative 1,2,7; halfW=3.5; first acc≥3.5 is third = 3
  assert.equal(weightedMedian([1, 2, 3], [1, 1, 5]), 3));
t('weightedMedian: rejects mismatched lengths', () =>
  assert.throws(() => weightedMedian([1, 2], [1]), /length mismatch/));
t('weightedMedian: rejects non-positive weights', () =>
  assert.throws(() => weightedMedian([1, 2], [1, 0]), /positive finite/));

// ── stddev ────────────────────────────────────────────────────────────
t('stddev: single value is 0', () => assert.equal(stddev([5]), 0));
t('stddev: identical values is 0', () => assert.equal(stddev([1, 1, 1, 1]), 0));
t('stddev: known sample (Bessel-corrected)', () => {
  // [2,4,4,4,5,5,7,9] sample stddev = 2.138...
  assert.ok(close(stddev([2, 4, 4, 4, 5, 5, 7, 9]), 2.138089935299395, 1e-6));
});

// ── confidence ────────────────────────────────────────────────────────
t('confidence: identical values → 1.0', () =>
  assert.equal(confidence([0.5, 0.5, 0.5]), 1.0));
t('confidence: single value → 1.0', () =>
  assert.equal(confidence([0.5]), 1.0));
t('confidence: noisy 10% spread → ~0.94', () => {
  // [0.95, 1.00, 1.05] mean=1, stddev=0.05, cv=0.05 → conf 0.95
  const c = confidence([0.95, 1.00, 1.05]);
  assert.ok(close(c, 1 - 0.05, 1e-3), `got ${c}`);
});
t('confidence: extremely noisy → low', () => {
  // Outlier dominates: stddev/mean > 0.5
  const c = confidence([0.5, 0.5, 100]);
  assert.ok(c < 0.5, `expected low confidence, got ${c}`);
});
t('confidence: zero mean → 0', () =>
  assert.equal(confidence([-1, 1]), 0));

// ── deviationPct ──────────────────────────────────────────────────────
t('deviationPct: identical values → 0', () =>
  assert.equal(deviationPct([0.5, 0.5, 0.5]), 0));
t('deviationPct: single value → 0', () =>
  assert.equal(deviationPct([0.5]), 0));
t('deviationPct: 5% spread', () => {
  // [100, 102, 105] median=102, max-min=5, dev = 5/102 * 100 ≈ 4.902%
  assert.ok(close(deviationPct([100, 102, 105]), 5 / 102 * 100, 1e-9));
});
t('deviationPct: handles all-zero', () =>
  assert.equal(deviationPct([0, 0]), 0));

// ── aggregate ─────────────────────────────────────────────────────────
t('aggregate: 3-source happy path', () => {
  const r = aggregate([
    { price: 0.4810 }, { price: 0.4815 }, { price: 0.4820 },
  ]);
  assert.equal(r.sourcesUsed, 3);
  assert.equal(r.price, 0.4815);
  assert.ok(r.confidence > 0.99);
  assert.ok(r.deviationPct < 0.3);
});

t('aggregate: drops null prices', () => {
  // Test feeds intentionally-malformed values through to verify runtime defense.
  const r = aggregate([
    { price: 0.50 }, { price: null as unknown as undefined }, { price: undefined }, { price: NaN }, { price: 0.51 },
  ]);
  assert.equal(r.sourcesUsed, 2);
});

t('aggregate: throws when no usable quotes', () =>
  assert.throws(() => aggregate([{ price: NaN }, { price: null as unknown as undefined }]), /no usable quotes/));

t('aggregate: single source → confidence capped, deviation 0', () => {
  // Math primitive `confidence([x])` is 1.0, but the aggregator caps single
  // -source aggregates to SINGLE_SOURCE_CONFIDENCE_CAP — a degraded fanout
  // shouldn't claim full confidence (see Charli3-only pairs like NIGHT-ADA).
  const r = aggregate([{ price: 0.4813 }]);
  assert.equal(r.sourcesUsed, 1);
  assert.equal(r.price, 0.4813);
  assert.equal(r.confidence, SINGLE_SOURCE_CONFIDENCE_CAP);
  assert.equal(r.deviationPct, 0);
});

t('aggregate: cap does NOT apply once 2+ sources are present', () => {
  // Two identical quotes → math gives confidence 1.0; cap must not kick in.
  const r = aggregate([{ price: 0.4813 }, { price: 0.4813 }]);
  assert.equal(r.sourcesUsed, 2);
  assert.equal(r.confidence, 1.0);
});

t('aggregate: cap is the ceiling, not the floor — noisy single source stays low', () => {
  // confidence([x]) is 1.0 by math, but cap brings it down. We never raise
  // a low confidence — the cap is `min(raw, 0.5)`. With one value there's
  // nothing to raise anyway, but verify the property holds.
  const r = aggregate([{ price: 100 }]);
  assert.ok(r.confidence <= SINGLE_SOURCE_CONFIDENCE_CAP);
});

t('aggregate: outlier degrades confidence + raises deviation', () => {
  const r = aggregate([
    { price: 0.50 }, { price: 0.51 }, { price: 0.49 }, { price: 100.0 },
  ]);
  // Median is robust → ~0.5 region. Confidence collapses; deviation huge.
  assert.ok(r.price < 1, `median should ignore the 100 outlier, got ${r.price}`);
  assert.ok(r.confidence < 0.5, `outlier should drop confidence, got ${r.confidence}`);
  assert.ok(r.deviationPct > 1000, `outlier should produce huge deviation, got ${r.deviationPct}`);
});

// ── pegDeviationBps ──────────────────────────────────────────────────
t('pegDeviationBps: perfect peg → 0 bps', () => {
  // 1 ADA buys exactly 0.247 USDM. ADA-USD = 0.247. Implied USDM/USD = 1.0.
  assert.equal(pegDeviationBps(0.247, 0.247), 0);
});

t('pegDeviationBps: stable below peg → negative bps', () => {
  // ADA-USDM = 0.252 (1 ADA buys MORE USDM, USDM is cheap), ADA-USD = 0.247.
  // implied USDM/USD = 0.247/0.252 = 0.9802 → -198.4 bps
  const bps = pegDeviationBps(0.252, 0.247);
  assert.ok(bps < 0, `expected negative bps for below-peg, got ${bps}`);
  assert.ok(close(bps, -198.4127, 0.01), `got ${bps}`);
});

t('pegDeviationBps: stable above peg → positive bps', () => {
  // ADA-USDM = 0.242 (1 ADA buys FEWER USDM, USDM is dear), ADA-USD = 0.247.
  // implied USDM/USD = 0.247/0.242 = 1.0207 → +206.6 bps
  const bps = pegDeviationBps(0.242, 0.247);
  assert.ok(bps > 0, `expected positive bps for above-peg, got ${bps}`);
  assert.ok(close(bps, 206.6116, 0.01), `got ${bps}`);
});

t('pegDeviationBps: depeg event (10% below) ≈ -1000 bps', () => {
  // ADA-USDM = 0.2744 means USDM = 0.247/0.2744 = 0.9001, deviation -999 bps
  const bps = pegDeviationBps(0.2744, 0.247);
  assert.ok(close(bps, -998.5, 1.0), `got ${bps}`);
});

t('pegDeviationBps: scale-invariant (works at any ADA-USD level)', () => {
  // Same proportion: 1% above peg should always give ~+100 bps regardless of
  // the absolute ADA-USD level. Two scales that should produce same bps.
  const bpsLow  = pegDeviationBps(0.10 / 1.01, 0.10);   // ADA = $0.10
  const bpsHigh = pegDeviationBps(2.00 / 1.01, 2.00);   // ADA = $2.00
  assert.ok(close(bpsLow, bpsHigh, 0.01), `bps depends on scale: ${bpsLow} vs ${bpsHigh}`);
  assert.ok(close(bpsLow, 100, 0.5), `expected ~100 bps, got ${bpsLow}`);
});

t('pegDeviationBps: rejects non-positive prices', () => {
  assert.throws(() => pegDeviationBps(0,    0.247), /adaStablePrice/);
  assert.throws(() => pegDeviationBps(-1,   0.247), /adaStablePrice/);
  assert.throws(() => pegDeviationBps(0.247, 0),    /adaUsdPrice/);
  assert.throws(() => pegDeviationBps(0.247, NaN),  /adaUsdPrice/);
  assert.throws(() => pegDeviationBps(NaN,   0.247), /adaStablePrice/);
});

// ── twap ──────────────────────────────────────────────────────────────
t('twap: empty samples → null', () => {
  const r = twap([], 0, 100);
  assert.equal(r.twap, null);
  assert.equal(r.count, 0);
});

t('twap: single sample → that price', () => {
  const r = twap([{ ts: 50, price: 0.5 }], 0, 100);
  assert.equal(r.count, 1);
  assert.equal(r.twap, 0.5);
});

t('twap: equal-spaced samples → equal weights ≈ mean', () => {
  // Three samples at 0, 30, 60 in window [0, 90]. Weights: 30, 30, 30. TWAP = (1+2+3)/3 = 2.
  const r = twap([
    { ts: 0,  price: 1 },
    { ts: 30, price: 2 },
    { ts: 60, price: 3 },
  ], 0, 90);
  assert.equal(r.count, 3);
  assert.equal(r.twap, 2);
});

t('twap: stuck price weighted higher', () => {
  // Price 1 from ts=0, price 5 from ts=80 in window [0, 100].
  // Weights: 80, 20. TWAP = (80*1 + 20*5)/100 = 1.8
  const r = twap([
    { ts: 0,  price: 1 },
    { ts: 80, price: 5 },
  ], 0, 100);
  assert.ok(close(r.twap!,1.8, 1e-9), `got ${r.twap}`);
});

t('twap: filters out samples outside window', () => {
  const r = twap([
    { ts: -10, price: 999 },     // before window
    { ts: 50,  price: 1 },
    { ts: 200, price: 999 },     // after window
  ], 0, 100);
  assert.equal(r.count, 1);
  assert.equal(r.twap, 1);
});

t('twap: rejects inverted window', () =>
  assert.throws(() => twap([{ ts: 50, price: 1 }], 100, 0), /windowEndMs must be/));

console.log(`\n${n - fails}/${n} passed`);
process.exit(fails ? 1 : 0);
