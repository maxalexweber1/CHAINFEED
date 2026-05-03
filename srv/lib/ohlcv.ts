/**
 * OHLCV bucketing — turn the AggregatedPrices stream into candles.
 *
 * CHAINFEED is an oracle aggregator, not a trading venue, so "volume"
 * here means the **count of oracle observations** that fell into a
 * bucket — not traded volume. That's the most honest signal we can
 * publish; downstream chart consumers who want trading volume should
 * pull it from a DEX-specific source.
 *
 * Pure function — `bucketSamples` takes a sample array + window + interval
 * and returns a candle array. The CDS handler just queries the DB and
 * passes through. Tests target this directly without booting CAP.
 *
 * Bucket alignment: candle timestamps are aligned to interval boundaries
 * (epoch-aligned, UTC). A 1h interval produces candles at 00:00, 01:00,
 * 02:00... A 1d interval at 00:00 UTC each day. This matches what every
 * charting library expects.
 *
 * Empty buckets: we DO NOT emit empty candles. If a 1h interval had no
 * oracle reads (e.g. low-traffic stable, no consumer hit `getBestPrice`),
 * that hour is skipped. Consumers see gaps. This is more honest than
 * forward-filling — the aggregator didn't have a price for that period.
 */

export interface TimePrice {
  ts: number;     // epoch ms
  price: number;
}

export interface Candle {
  /** Bucket-aligned epoch ms (start of bucket). */
  ts: number;
  open:  number;
  high:  number;
  low:   number;
  close: number;
  /** Count of oracle observations in this bucket. */
  sampleCount: number;
}

/** Supported interval identifiers. */
export type Interval = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';

const INTERVAL_TO_MS: Readonly<Record<Interval, number>> = Object.freeze({
  '1m':         60_000,
  '5m':       5 * 60_000,
  '15m':     15 * 60_000,
  '1h':      60 * 60_000,
  '4h':  4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
});

/**
 * Per-interval maximum lookback (ms). Consumers requesting longer windows
 * are clamped — protects the DB from a "give me 1m candles for 1 year"
 * query that would scan ~525k rows. Numbers chosen so each interval's
 * max-window produces ≤ ~2k candles, which fits cleanly in a single
 * HTTP response.
 */
const MAX_LOOKBACK_MS_BY_INTERVAL: Readonly<Record<Interval, number>> = Object.freeze({
  '1m':       2 * 60 * 60_000,         // 2 hours    → 120 candles
  '5m':      24 * 60 * 60_000,         // 24 hours   → 288 candles
  '15m':  3 * 24 * 60 * 60_000,         // 3 days     → 288 candles
  '1h':  14 * 24 * 60 * 60_000,         // 14 days    → 336 candles
  '4h':  60 * 24 * 60 * 60_000,         // 60 days    → 360 candles
  '1d': 365 * 24 * 60 * 60_000,         // 1 year     → 365 candles
});

const INTERVALS: ReadonlyArray<Interval> = ['1m', '5m', '15m', '1h', '4h', '1d'];

export function isValidInterval(s: string): s is Interval {
  return INTERVALS.includes(s as Interval);
}

export function intervalToMs(interval: Interval): number {
  return INTERVAL_TO_MS[interval];
}

export function maxLookbackMsForInterval(interval: Interval): number {
  return MAX_LOOKBACK_MS_BY_INTERVAL[interval];
}

/**
 * Bucket-align a timestamp downward. `ts: 1234567` with `intervalMs: 1000`
 * → `1234000` (the start of the bucket the timestamp falls into).
 */
export function bucketStartMs(ts: number, intervalMs: number): number {
  return Math.floor(ts / intervalMs) * intervalMs;
}

/**
 * Group samples into candles. Samples are sorted internally so callers
 * can pass them in any order. Empty buckets are skipped (no fill-forward
 * — the aggregator didn't have a price for that interval, and saying it
 * did would be a lie).
 *
 * Window semantics: samples whose `ts` falls in `[windowStartMs, windowEndMs]`
 * (inclusive both ends) are considered. Samples outside are dropped silently.
 */
export function bucketSamples(
  samples: ReadonlyArray<TimePrice>,
  windowStartMs: number,
  windowEndMs:   number,
  intervalMs:    number,
): Candle[] {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error(`bucketSamples: intervalMs must be positive finite (got ${intervalMs})`);
  }
  if (!(windowEndMs > windowStartMs)) {
    throw new Error('bucketSamples: windowEndMs must be > windowStartMs');
  }

  // Filter + sort. Tolerate caller mistakes (NaN ts, negative price, etc).
  const inWindow = samples
    .filter(s => Number.isFinite(s.ts) && Number.isFinite(s.price)
                 && s.ts >= windowStartMs && s.ts <= windowEndMs)
    .sort((a, b) => a.ts - b.ts);

  if (inWindow.length === 0) return [];

  const buckets = new Map<number, Candle>();
  for (const s of inWindow) {
    const bs = bucketStartMs(s.ts, intervalMs);
    const cur = buckets.get(bs);
    if (!cur) {
      // First sample in this bucket — initialize with sample as OHLC.
      buckets.set(bs, {
        ts: bs,
        open:  s.price,
        high:  s.price,
        low:   s.price,
        close: s.price,
        sampleCount: 1,
      });
    } else {
      // Subsequent sample. open stays (first), close updates (latest by ts).
      // High/low track extremes.
      if (s.price > cur.high) cur.high = s.price;
      if (s.price < cur.low)  cur.low  = s.price;
      cur.close = s.price;
      cur.sampleCount++;
    }
  }

  // Sort by bucket start time ascending (Map iteration order is insertion
  // order which here matches sample-time-order, but be defensive).
  return Array.from(buckets.values()).sort((a, b) => a.ts - b.ts);
}
