/**
 * OHLCV pure-fn tests. Pure-Node, no DB / CDS boot.
 *
 * Run: npx tsx scripts/test-ohlcv.ts
 */

import assert from 'node:assert/strict';
import {
  bucketSamples, bucketStartMs, intervalToMs, maxLookbackMsForInterval,
  isValidInterval,
  type TimePrice, type Interval,
} from '../srv/lib/ohlcv';

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

console.log('ohlcv ───────────────────────────────────────────────────');

// ── interval helpers ────────────────────────────────────────────────
t('intervalToMs covers all 6 intervals', () => {
  assert.equal(intervalToMs('1m'),      60_000);
  assert.equal(intervalToMs('5m'),     300_000);
  assert.equal(intervalToMs('15m'),    900_000);
  assert.equal(intervalToMs('1h'),   3_600_000);
  assert.equal(intervalToMs('4h'),  14_400_000);
  assert.equal(intervalToMs('1d'),  86_400_000);
});

t('isValidInterval gates on the supported set', () => {
  assert.equal(isValidInterval('1m'),  true);
  assert.equal(isValidInterval('1h'),  true);
  assert.equal(isValidInterval('30s'), false);
  assert.equal(isValidInterval('2h'),  false);
  assert.equal(isValidInterval(''),    false);
});

t('maxLookbackMsForInterval is monotonically increasing', () => {
  const intervals: Interval[] = ['1m', '5m', '15m', '1h', '4h', '1d'];
  for (let i = 1; i < intervals.length; i++) {
    assert.ok(maxLookbackMsForInterval(intervals[i]!) > maxLookbackMsForInterval(intervals[i-1]!),
      `${intervals[i-1]} → ${intervals[i]} not increasing`);
  }
});

t('maxLookback caps each interval at ≤ ~2000 candles per response', () => {
  const intervals: Interval[] = ['1m', '5m', '15m', '1h', '4h', '1d'];
  for (const iv of intervals) {
    const candles = maxLookbackMsForInterval(iv) / intervalToMs(iv);
    assert.ok(candles <= 2000, `${iv}: max candles ${candles} exceeds 2000`);
  }
});

// ── bucketStartMs ────────────────────────────────────────────────────
t('bucketStartMs aligns down to interval boundary', () => {
  // 1h interval
  assert.equal(bucketStartMs(3_605_000, 3_600_000), 3_600_000);    // 5s past hour → hour boundary
  assert.equal(bucketStartMs(3_600_000, 3_600_000), 3_600_000);    // exact
  // 1m interval
  assert.equal(bucketStartMs(120_999, 60_000), 120_000);
});

t('bucketStartMs handles epoch (ts=0)', () => {
  assert.equal(bucketStartMs(0, 60_000), 0);
});

// ── bucketSamples — base cases ──────────────────────────────────────
t('bucketSamples: empty samples → empty result', () => {
  assert.deepEqual(bucketSamples([], 0, 1000, 100), []);
});

t('bucketSamples: window/interval validation', () => {
  assert.throws(() => bucketSamples([], 100, 100, 60), /windowEndMs must be > windowStartMs/);
  assert.throws(() => bucketSamples([], 0, 100, 0), /intervalMs must be positive finite/);
  assert.throws(() => bucketSamples([], 0, 100, NaN), /intervalMs must be positive finite/);
});

t('bucketSamples: single sample → single 1-count candle with all-equal OHLC', () => {
  const c = bucketSamples([{ ts: 50_000, price: 0.247 }], 0, 100_000, 60_000);
  assert.equal(c.length, 1);
  assert.equal(c[0]!.ts, 0);
  assert.equal(c[0]!.open,  0.247);
  assert.equal(c[0]!.high,  0.247);
  assert.equal(c[0]!.low,   0.247);
  assert.equal(c[0]!.close, 0.247);
  assert.equal(c[0]!.sampleCount, 1);
});

// ── OHLC math ───────────────────────────────────────────────────────
t('bucketSamples: 4 samples in 1 bucket → correct OHLC', () => {
  // All within minute 0 (ts 0..59999). intervals=60000ms.
  const samples: TimePrice[] = [
    { ts: 10_000, price: 0.247 },   // open
    { ts: 20_000, price: 0.250 },   // high
    { ts: 30_000, price: 0.245 },   // low
    { ts: 50_000, price: 0.248 },   // close
  ];
  const c = bucketSamples(samples, 0, 60_000, 60_000)[0]!;
  assert.equal(c.ts, 0);
  assert.equal(c.open,  0.247);
  assert.equal(c.high,  0.250);
  assert.equal(c.low,   0.245);
  assert.equal(c.close, 0.248);
  assert.equal(c.sampleCount, 4);
});

t('bucketSamples: handles out-of-order input (sorts internally)', () => {
  const samples: TimePrice[] = [
    { ts: 50_000, price: 0.248 },
    { ts: 10_000, price: 0.247 },
    { ts: 30_000, price: 0.245 },
    { ts: 20_000, price: 0.250 },
  ];
  const c = bucketSamples(samples, 0, 60_000, 60_000)[0]!;
  assert.equal(c.open,  0.247);   // earliest ts
  assert.equal(c.close, 0.248);   // latest ts
  assert.equal(c.high,  0.250);
  assert.equal(c.low,   0.245);
});

// ── Multi-bucket ────────────────────────────────────────────────────
t('bucketSamples: 1m interval over 3 minutes produces 3 candles', () => {
  const samples: TimePrice[] = [
    { ts:      5_000, price: 1.00 },
    { ts:     30_000, price: 1.10 },
    { ts:     65_000, price: 1.20 },
    { ts:     90_000, price: 1.15 },
    { ts:    125_000, price: 1.25 },
  ];
  const candles = bucketSamples(samples, 0, 180_000, 60_000);
  assert.equal(candles.length, 3);
  // Bucket 0 (0-59s): samples at 5s, 30s
  assert.equal(candles[0]!.ts, 0);
  assert.equal(candles[0]!.open,  1.00);
  assert.equal(candles[0]!.close, 1.10);
  assert.equal(candles[0]!.sampleCount, 2);
  // Bucket 60s: samples at 65s, 90s
  assert.equal(candles[1]!.ts, 60_000);
  assert.equal(candles[1]!.open,  1.20);
  assert.equal(candles[1]!.close, 1.15);
  // Bucket 120s: sample at 125s
  assert.equal(candles[2]!.ts, 120_000);
  assert.equal(candles[2]!.open, 1.25);
});

t('bucketSamples: empty buckets are NOT emitted (gaps are honest)', () => {
  // Samples only at t=5s and t=185s — bucket 60s and 120s should have NO entry
  const samples: TimePrice[] = [
    { ts:   5_000, price: 1.00 },
    { ts: 185_000, price: 2.00 },
  ];
  const candles = bucketSamples(samples, 0, 240_000, 60_000);
  assert.equal(candles.length, 2);              // not 4 — empty buckets dropped
  assert.equal(candles[0]!.ts,    0);
  assert.equal(candles[1]!.ts, 180_000);
});

// ── Window filtering ────────────────────────────────────────────────
t('bucketSamples: drops samples outside [windowStart, windowEnd]', () => {
  const samples: TimePrice[] = [
    { ts:    -1, price: 999 },     // before window
    { ts:    50, price: 1.0 },
    { ts:   150, price: 2.0 },
    { ts:   500, price: 3.0 },
    { ts:   501, price: 999 },     // after window
  ];
  const candles = bucketSamples(samples, 0, 500, 100);
  // Only ts 50, 150, 500 should be considered → 3 buckets at 0, 100, 500.
  assert.equal(candles.length, 3);
  assert.equal(candles.map(c => c.ts).join(','), '0,100,500');
});

t('bucketSamples: window-end is inclusive', () => {
  const candles = bucketSamples([{ ts: 1000, price: 5 }], 0, 1000, 1000);
  assert.equal(candles.length, 1);
  assert.equal(candles[0]!.ts, 1000);
});

// ── Defensive: NaN / negatives ──────────────────────────────────────
t('bucketSamples: silently drops samples with NaN ts or price', () => {
  const samples: TimePrice[] = [
    { ts: 100, price: NaN },
    { ts: NaN, price: 1.0 },
    { ts: 200, price: 2.0 },     // valid
  ];
  const candles = bucketSamples(samples, 0, 500, 100);
  assert.equal(candles.length, 1);
  assert.equal(candles[0]!.sampleCount, 1);
});

// ── Stable-realistic scenario ───────────────────────────────────────
t('bucketSamples: realistic ADA-USD 1h candles over 4 hours', () => {
  // Simulate ~5 oracle reads per hour with tiny price jitter.
  const baseTs = Date.UTC(2026, 4, 1, 0, 0, 0);   // 2026-05-01 00:00 UTC
  const HOUR = 3_600_000;
  const samples: TimePrice[] = [];
  for (let h = 0; h < 4; h++) {
    for (let i = 0; i < 5; i++) {
      samples.push({
        ts:    baseTs + h * HOUR + i * 12 * 60_000,   // every 12 min
        price: 0.247 + (h * 0.001) + (i % 2 === 0 ? 0.0005 : -0.0005),
      });
    }
  }
  const candles = bucketSamples(samples, baseTs, baseTs + 4 * HOUR, HOUR);
  assert.equal(candles.length, 4);
  for (const c of candles) {
    assert.equal(c.sampleCount, 5);
    assert.ok(c.high >= c.low);
    assert.ok(c.high >= c.open  && c.high >= c.close);
    assert.ok(c.low  <= c.open  && c.low  <= c.close);
  }
  // Bucket timestamps should be hour-aligned.
  for (const c of candles) assert.equal(c.ts % HOUR, 0);
});

console.log(`\n${n - fails}/${n} passed`);
process.exit(fails ? 1 : 0);
