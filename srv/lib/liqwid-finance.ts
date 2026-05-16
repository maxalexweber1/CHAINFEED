/**
 * Liqwid Finance v2 — empirical APR/APY derivation from interestIndex deltas.
 *
 * Liqwid v2 is closed-source Plutarch; the rate-curve params encoded in
 * MarketState `field[6]` use an undocumented bigint pair. Rather than crack
 * that encoding, this module derives the borrow rate empirically from the
 * cumulative `interestIndex` field over wall-time:
 *
 *   borrowAPR ≈ (currentIndex - prevIndex) / prevIndex × (year_ms / Δt_ms)
 *
 * Snapshots are kept in-memory per process. After Δt ≥ MIN_DELTA_MS, the
 * adapter can return a derived APR alongside (or instead of) the GraphQL
 * APY. Pre-baseline (single snapshot) calls return null; consumer should
 * fall back to the GraphQL value.
 *
 * Trade-off vs persistent snapshots: this resets on server restart and
 * needs a few minutes to accumulate baselines. Acceptable for v1 because
 * the GraphQL fallback covers cold-start; persistent variant is a future
 * upgrade (would survive restarts and give immediate baselines).
 */

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Minimum Δt before deriving APR. Liqwid markets settle batches every ~62s,
 * so anything under a couple of batch cycles produces noisy first-derivative
 * estimates. 60s is a balance between freshness and signal quality.
 */
export const MIN_DELTA_MS = 60_000;

interface Snapshot {
  /** Cumulative interest index from MarketState field[5]. */
  interestIndex: bigint;
  /** On-chain `lastInterestUpdateMs` from MarketState field[7] — the chain's
   *  authoritative timestamp for when this index was last accrued. NOT the
   *  wall-clock time we captured the snapshot. Idle markets may keep the
   *  same lastInterestUpdateMs across many wall-clock seconds; using the
   *  on-chain timestamp avoids spurious zero-Δindex/positive-Δt derivations. */
  lastInterestUpdateMs: number;
}

/**
 * Per-process snapshot store. Keyed by market symbol (DJED / iUSD / USDM).
 * Holds the most-recent snapshot only — APR is computed against this when a
 * fresher reading arrives. Module-scoped so all adapter calls share state.
 */
const snapshots = new Map<string, Snapshot>();

export interface DerivedRates {
  /** Empirical annualized borrow rate as a decimal fraction (0.05 = 5%). */
  borrowAPR: number;
  /** Continuous-compounded borrow APY: e^APR − 1. */
  borrowAPY: number;
  /** Width of the observation window used to derive the rate (ms). */
  observedDeltaMs: number;
  /** Wall-clock of the older snapshot. */
  baselineAtMs: number;
}

/**
 * Record a snapshot keyed on the on-chain `lastInterestUpdateMs` and derive
 * APR/APY against the previous DIFFERENT-timestamped snapshot.
 *
 * Critical detail: we only update the snapshot map when the chain timestamp
 * actually advances. This means repeated polls of an idle market don't
 * overwrite the baseline — the next time the market settles a batch, we
 * derive against a meaningful Δt. Trade-off: cold start needs at least one
 * batch-settle event (typically minutes to hours for low-activity markets).
 *
 * Returns null when:
 *   - First snapshot for the market (no baseline)
 *   - Chain timestamp unchanged (no fresh accrual to measure)
 *   - Δt (on-chain) < MIN_DELTA_MS
 *   - interestIndex moved backwards (chain re-org / decode bug)
 */
export function recordAndDerive(
  symbol: string,
  interestIndex: bigint,
  lastInterestUpdateMs: number,
): DerivedRates | null {
  const key = symbol.toUpperCase();
  const prev = snapshots.get(key);

  // Don't overwrite when the chain hasn't moved — we'd lose the baseline
  // distance. Skip silently.
  if (prev && prev.lastInterestUpdateMs === lastInterestUpdateMs) {
    return null;
  }

  if (!prev) {
    // First observation — store the baseline; no derivation possible yet.
    snapshots.set(key, { interestIndex, lastInterestUpdateMs });
    return null;
  }

  const dt = lastInterestUpdateMs - prev.lastInterestUpdateMs;
  if (dt < MIN_DELTA_MS) return null;
  // Reject reorgs / regressions BEFORE replacing the baseline — otherwise a
  // chain re-org checkpoint would overwrite a perfectly good prev and we'd
  // lose the working baseline for the next poll.
  if (interestIndex <= prev.interestIndex) return null;

  // Validation passed; commit the new checkpoint.
  snapshots.set(key, { interestIndex, lastInterestUpdateMs });

  // Use Number for the ratio — interestIndex magnitudes are ~10^16 in
  // observed data, well inside Float64 safe range. The relative growth is
  // tiny (basis-points per snapshot interval), so precision loss is bounded.
  const indexDelta = Number(interestIndex - prev.interestIndex);
  const indexBase  = Number(prev.interestIndex);
  if (!Number.isFinite(indexDelta) || !Number.isFinite(indexBase) || indexBase === 0) {
    return null;
  }
  const periodRate = indexDelta / indexBase;
  const borrowAPR = periodRate * (YEAR_MS / dt);

  // Continuous compounding: e^APR − 1. Liqwid actually compounds per batch
  // (~62s) so the true APY is fractionally lower than e^APR − 1, but the
  // difference is sub-bp at observed APR ranges. Document as continuous.
  const borrowAPY = Math.expm1(borrowAPR);

  return {
    borrowAPR,
    borrowAPY,
    observedDeltaMs: dt,
    baselineAtMs: prev.lastInterestUpdateMs,
  };
}

/**
 * Derive supplyAPY from borrowAPY + utilization + reserveFactor.
 *
 * Compound v2 model: suppliers earn a fraction of what borrowers pay,
 * scaled by utilization (since only borrowed capital pays interest):
 *
 *   supplyAPY = borrowAPY × utilization × (1 − reserveFactor)
 *
 * `reserveFactor` defaults to 0.10 (typical Compound-style cut). Liqwid's
 * actual factor is encoded in field[6] params we haven't decoded; 0.10 is
 * within the band consistent with observed supplyAPY/borrowAPY ratios on
 * mainnet (DJED ≈ 0.484, iUSD ≈ 0.302, USDM ≈ 0.309 — broadly matches
 * util × (1−0.1) for those markets).
 */
export function deriveSupplyAPY(
  borrowAPY: number,
  utilization: number,
  reserveFactor: number = 0.10,
): number {
  return borrowAPY * utilization * (1 - reserveFactor);
}

/** Snapshot-store inspection (test / smoke / debug only). */
export function _inspectSnapshots(): Map<string, Snapshot> {
  return new Map(snapshots);
}

/** Drop all snapshots (test setup). */
export function _resetSnapshots(): void {
  snapshots.clear();
}
