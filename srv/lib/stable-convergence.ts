/**
 * Cross-stable convergence checker.
 *
 * Given a snapshot of ADA-X prices for several USD-pegged stables, computes
 * the implied stable-vs-stable cross-rate for each pair and surfaces the
 * deviation from the theoretical 1.0 (perfectly-pegged stables should cross
 * at parity).
 *
 * Why this matters as a second-order signal:
 *
 *   - **All stables off-peg the same way** = data-quality issue (e.g. ADA-USD
 *     reference is wrong, all derived peg-deviations are misleading).
 *   - **Only one stable off-peg vs others** = stable-specific peg break
 *     (e.g. DJED at 92% while USDM/USDA/iUSD all at 100% → DJED-protocol-issue).
 *   - **Symmetric clustering** = market is pricing in differential trust
 *     levels (e.g. fiat-custodial USDM premium over algorithmic DJED).
 *
 * Pure function — input is a `Record<symbol, adaPrice>` plus the ADA-USD
 * reference. Output is an NxN matrix of cross-rates + deviations + a
 * scalar "convergence-quality" score in [0, 1] suitable for downstream
 * health-score weighting.
 *
 * Math:
 *   for stables A and B with `ADA-A = a` and `ADA-B = b`:
 *     impliedAperB = b / a       (how many A you get per 1 B at current
 *                                  cross-rate, derived through ADA pivot)
 *     theoretical  = 1.0          (both pegged to USD)
 *     deviationPct = (impliedAperB - 1.0) × 100
 *
 * The matrix is symmetric: `matrix[A][B].deviationPct === -matrix[B][A].deviationPct`
 * (modulo float-rounding). We populate both halves for consumer convenience.
 */

export interface CrossRateEntry {
  /** Implied "B per 1 A", derived through ADA pivot. */
  impliedRate: number;
  /** Distance from 1.0 in percent. Positive = A is dearer than B. */
  deviationPct: number;
}

export interface ConvergenceMatrix {
  /** Symbols that had usable input prices, sorted alphabetically. */
  symbols: string[];
  /** Per-pair cross-rates. matrix[A][B] = implied A-vs-B. Empty for A === B. */
  matrix: Record<string, Record<string, CrossRateEntry>>;
  /**
   * [0, 1] score: 1.0 = all stables converge perfectly to 1.000, 0 = chaotic.
   * `null` when there are 0 priced symbols (nothing to converge about).
   */
  convergenceScore: number | null;
  /** Maximum absolute deviation observed (in % points) — quick-glance signal. */
  maxDeviationPct: number;
  /** Symbols whose median deviation across pairs exceeded the warning band. */
  outliers: string[];
}

export interface ConvergenceInput {
  /** Map of symbol → ADA-X price (X per 1 ADA). Only USD-pegged stables. */
  adaPrices: Record<string, number>;
  /**
   * Maximum |deviation%| considered "converged". Pairs above this contribute
   * to outlier flagging and pull down convergenceScore. Default 1.0 (1%).
   */
  warningBandPct?: number;
}

const DEFAULT_WARNING_BAND_PCT = 1.0;

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Compute the matrix. Stables with non-positive or non-finite prices are
 * dropped silently (they wouldn't yield meaningful cross-rates anyway).
 */
export function computeConvergenceMatrix(input: ConvergenceInput): ConvergenceMatrix {
  const warningBand = input.warningBandPct ?? DEFAULT_WARNING_BAND_PCT;

  // Filter to symbols with valid prices, sort for stable iteration.
  const symbols = Object.keys(input.adaPrices)
    .filter(s => {
      const p = input.adaPrices[s];
      return Number.isFinite(p) && (p as number) > 0;
    })
    .sort();

  const matrix: Record<string, Record<string, CrossRateEntry>> = {};
  for (const s of symbols) matrix[s] = {};

  let maxDev = 0;
  // Per-symbol list of |deviations| against every other symbol — used for
  // outlier detection (median of absolute deviations is robust to one rogue).
  const absDevsBySymbol: Record<string, number[]> = {};
  for (const s of symbols) absDevsBySymbol[s] = [];

  for (const A of symbols) {
    const a = input.adaPrices[A]!;
    for (const B of symbols) {
      if (A === B) continue;
      const b = input.adaPrices[B]!;
      // ADA-A = X-A per ADA, ADA-B = X-B per ADA. To express "B per 1 A":
      // 1 A = (1 / ADA-A) ADA = (ADA-B / ADA-A) X-B.
      const impliedRate = b / a;
      const deviationPct = (impliedRate - 1.0) * 100;
      const abs = Math.abs(deviationPct);
      matrix[A]![B] = { impliedRate, deviationPct };
      if (abs > maxDev) maxDev = abs;
      absDevsBySymbol[A]!.push(abs);
    }
  }

  const outliers = symbols.filter(s => median(absDevsBySymbol[s]!) > warningBand);

  // convergenceScore = 1 - clamp(maxDev / 5%, 0, 1). 0% spread → 1.0;
  // 5%+ spread (extreme depeg) → 0.0. Linear in between.
  // Special cases:
  //   - 0 symbols: nothing was priced; "perfectly converged" overstates the
  //     dashboard signal. Return null so consumers render "no data".
  //   - 1 symbol: trivially converged; 1.0 is fine.
  const convergenceScore = symbols.length === 0
    ? null
    : symbols.length === 1
      ? 1.0
      : Math.max(0, Math.min(1, 1 - maxDev / 5));

  return {
    symbols,
    matrix,
    convergenceScore,
    maxDeviationPct: maxDev,
    outliers,
  };
}

/**
 * Reduce the matrix to a single per-symbol summary: for each symbol, its
 * median absolute deviation against the others. Useful for embedding into
 * `getStableHealth` per-stable response (consumer sees "this stable
 * disagrees with the basket by N% on average").
 */
export function perSymbolDeviation(matrix: ConvergenceMatrix): Record<string, number> {
  const out: Record<string, number> = {};
  for (const A of matrix.symbols) {
    const row = matrix.matrix[A]!;
    const absDevs = Object.values(row).map(e => Math.abs(e.deviationPct));
    out[A] = median(absDevs);
  }
  return out;
}
