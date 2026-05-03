/**
 * Multi-source price aggregation. Pure functions — no I/O, no time.
 *
 * Inputs are arrays of numbers (or {value, weight} pairs). Output is a
 * single representative price plus quality metrics that the API surfaces
 * to consumers as `confidence` and `deviationPct`.
 *
 * Design choices:
 * - **Median** for the central value. More robust to a single outlier
 *   (e.g. one DEX with thin liquidity) than mean. With 3 sources, median
 *   == middle value — exactly what we want.
 * - **Coefficient of variation** (stddev / mean) for confidence. Maps a
 *   pure number into a [0,1] band where 0 noise == 1.0 confidence and
 *   ≥100% noise == 0.0.
 * - **Max-min spread** for deviation. The single most useful number for
 *   a consumer deciding "should I trust this".
 *
 * Edge cases (intentional, not bugs):
 * - Empty input throws — callers must check upstream.
 * - Single source: the *math primitive* `confidence([x])` returns 1.0 (no
 *   spread). At the **aggregator** layer we cap that at
 *   `SINGLE_SOURCE_CONFIDENCE_CAP` (0.5) — once multiple adapters exist,
 *   ending up with only one quote means everyone else either failed or
 *   doesn't cover the pair, which is a degraded state, not a confirmed one.
 *   API consumers should treat `sourcesUsed: 1` as "best-effort".
 */

/**
 * Confidence cap applied by `aggregate()` when only one source returned a
 * usable quote. Phase-1 (Orcfax-only) reported 1.0; from Phase-2 onward
 * (multi-adapter fanout) a single survivor is a degraded fanout, not a
 * verified observation.
 */
export const SINGLE_SOURCE_CONFIDENCE_CAP = 0.5;

export interface AggregatedResult {
  /** median */
  price: number;
  /** [0, 1] */
  confidence: number;
  deviationPct: number;
  sourcesUsed: number;
}

export interface TwapSample {
  /** epoch ms */
  ts: number;
  price: number;
}

export interface TwapResult {
  twap: number | null;
  count: number;
}

export function median(values: number[]): number {
  if (!values || values.length === 0) throw new Error('median: empty input');
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Weighted median — value at the midpoint of the cumulative weight.
 * Use case: give Orcfax (audited, on-chain) more weight than a single
 * DEX quote.
 */
export function weightedMedian(values: number[], weights: number[]): number {
  if (!values || values.length === 0) throw new Error('weightedMedian: empty input');
  if (values.length !== weights.length) {
    throw new Error(`weightedMedian: length mismatch (${values.length} vs ${weights.length})`);
  }
  for (const w of weights) {
    if (!(w > 0) || !Number.isFinite(w)) throw new Error('weightedMedian: weights must be positive finite');
  }

  const pairs = values.map((v, i) => ({ v, w: weights[i]! })).sort((a, b) => a.v - b.v);
  const totalW = pairs.reduce((s, p) => s + p.w, 0);
  const halfW  = totalW / 2;

  let acc = 0;
  for (const p of pairs) {
    acc += p.w;
    if (acc >= halfW) return p.v;
  }
  // Unreachable for positive weights — defensive return for static analysis
  return pairs[pairs.length - 1]!.v;
}

/** Sample standard deviation (Bessel-corrected, n-1). For n=1 returns 0. */
export function stddev(values: number[]): number {
  if (!values || values.length === 0) throw new Error('stddev: empty input');
  if (values.length === 1) return 0;
  const mean = values.reduce((s, x) => s + x, 0) / values.length;
  const sumSq = values.reduce((s, x) => s + (x - mean) ** 2, 0);
  return Math.sqrt(sumSq / (values.length - 1));
}

/**
 * Coefficient of variation → [0, 1] confidence.
 *   confidence = 1 - clamp(σ / μ, 0, 1)
 *
 * If μ = 0 (theoretical: a pair with zero price), confidence is 0.
 */
export function confidence(values: number[]): number {
  if (!values || values.length === 0) throw new Error('confidence: empty input');
  if (values.length === 1) return 1.0;
  const mean = values.reduce((s, x) => s + x, 0) / values.length;
  if (mean === 0) return 0;
  const cv = stddev(values) / Math.abs(mean);
  return 1 - Math.min(Math.max(cv, 0), 1);
}

/**
 * Peg-deviation in basis points. Positive = stable trades above peg,
 * negative = below. Independent of the actual ADA-USD price scale.
 *
 *   stableUsdPrice = adaUsdPrice / adaStablePrice
 *   bps            = (stableUsdPrice - 1) × 10000
 *
 * Example: 1 USDM = $1.00 exactly when ADA-USD = ADA-USDM (both around
 * 0.247). If ADA-USDM drops to 0.252 (1 ADA buys more USDM, USDM is
 * cheaper), stableUsdPrice = 0.247/0.252 = 0.980 → -200 bps (USDM below
 * peg). Conversely ADA-USDM rising means USDM is dearer → positive bps.
 *
 * Throws on non-finite or non-positive inputs — peg-deviation is undefined
 * for missing or zero prices, and a noisy `NaN` would silently corrupt the
 * downstream HTTP response.
 */
export function pegDeviationBps(adaStablePrice: number, adaUsdPrice: number): number {
  if (!Number.isFinite(adaStablePrice) || adaStablePrice <= 0) {
    throw new Error(`pegDeviationBps: adaStablePrice must be positive finite (got ${adaStablePrice})`);
  }
  if (!Number.isFinite(adaUsdPrice) || adaUsdPrice <= 0) {
    throw new Error(`pegDeviationBps: adaUsdPrice must be positive finite (got ${adaUsdPrice})`);
  }
  const stableUsdPrice = adaUsdPrice / adaStablePrice;
  return (stableUsdPrice - 1) * 10_000;
}

/** Max-min spread as percent of median. e.g. [100, 102, 105] → 5%. */
export function deviationPct(values: number[]): number {
  if (!values || values.length === 0) throw new Error('deviationPct: empty input');
  if (values.length === 1) return 0;
  const m = median(values);
  if (m === 0) return 0;
  const max = Math.max(...values);
  const min = Math.min(...values);
  return ((max - min) / m) * 100;
}

/**
 * Top-level aggregator over an array of quotes. Drops nulls/undefineds
 * silently — callers may pre-filter for `isStale` or freshness.
 */
export function aggregate(quotes: Array<{ price?: number } | null | undefined>): AggregatedResult {
  const values = (quotes ?? [])
    .map(q => q?.price)
    .filter((p): p is number => Number.isFinite(p));
  if (values.length === 0) throw new Error('aggregate: no usable quotes');
  const rawConfidence = confidence(values);
  const cappedConfidence = values.length === 1
    ? Math.min(rawConfidence, SINGLE_SOURCE_CONFIDENCE_CAP)
    : rawConfidence;
  return {
    price:        median(values),
    confidence:   cappedConfidence,
    deviationPct: deviationPct(values),
    sourcesUsed:  values.length,
  };
}

/**
 * Time-weighted average price over a window.
 *
 * Each sample contributes proportional to the time gap until the next
 * sample (or until the window end for the most recent sample). This
 * weighting is what distinguishes TWAP from a plain average:
 * a price held for an hour outweighs one held for a minute.
 *
 * Edge cases:
 * - No samples in window  → { twap: null, count: 0 }
 * - One sample            → its price, count 1
 * - All at same instant   → falls back to the last sample's price
 */
export function twap(samples: TwapSample[], windowStartMs: number, windowEndMs: number): TwapResult {
  if (!Array.isArray(samples) || samples.length === 0) {
    return { twap: null, count: 0 };
  }
  if (!(windowEndMs > windowStartMs)) {
    throw new Error('twap: windowEndMs must be > windowStartMs');
  }
  const inWindow = samples
    .filter(s => Number.isFinite(s.price) && s.ts >= windowStartMs && s.ts <= windowEndMs)
    .sort((a, b) => a.ts - b.ts);
  if (inWindow.length === 0) return { twap: null, count: 0 };

  let weightedSum = 0;
  let totalWeight = 0;
  for (let i = 0; i < inWindow.length; i++) {
    const nextTs = i < inWindow.length - 1 ? inWindow[i + 1]!.ts : windowEndMs;
    const weight = nextTs - inWindow[i]!.ts;
    if (weight > 0) {
      weightedSum += weight * inWindow[i]!.price;
      totalWeight += weight;
    }
  }
  if (totalWeight === 0) {
    return { twap: inWindow[inWindow.length - 1]!.price, count: inWindow.length };
  }
  return { twap: weightedSum / totalWeight, count: inWindow.length };
}
