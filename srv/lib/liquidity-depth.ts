/**
 * Liquidity-depth probe — measures executable size at a target slippage.
 *
 * Reads pool reserves from each direct-DEX adapter that supports the
 * ADA-X pair (Minswap V2, WingRiders V2, SundaeSwap V3) and simulates a
 * constant-product swap of N ADA at several notionals. For each probe
 * we report the effective price `dy / dx` and the slippage vs the
 * marginal mid (`yReserve / xReserve`); the headline `depthAda` is the
 * largest probed amount where THIS plus all smaller probes stayed within
 * the target slippage band.
 *
 * **Multi-pool merge:** when more than one adapter returns reserves for
 * the pair we sum them into one virtual pool — `xTotal = Σ xRes_i`,
 * `yTotal = Σ yRes_i` — and apply constant-product math on the merged
 * pool. This is the well-known continuous-routing optimal for AMM
 * splits between identical-curve pools, and slightly OVER-estimates
 * what a real router achieves (real routing has per-pool overhead). For
 * the ADA-stable pairs we cover, all surviving pools sit within ~0.3 %
 * of each other (verified 2026-05-03 cross-source spread), so the
 * merged-pool model is accurate to within a fraction of one slippage
 * basis-point. Per-pool reserves are exposed in the result so consumers
 * can reconstruct tighter routing if they care.
 *
 * **Trading fee:** assumed 0.3 % across the surveyed venues — Minswap V2
 * default tier `[0.3, 0.3]`, WingRiders V2 typical, SundaeSwap V3
 * common tier. Real fees vary slightly per pool; consumers needing exact
 * post-fee execution should use the per-pool data.
 *
 * **Mid-price methodology:** `marginalPrice = yTotal / xTotal` — the
 * PRE-fee marginal at zero notional. Slippage figures (computed against
 * this mid) therefore *include* the fee component: a probe of 100 ADA
 * into an infinite-depth pool reports `slippagePct ≈ feePct`. Consumers
 * setting `targetSlippagePct ≤ feePct` should expect `depthAda = 0` —
 * the fee alone consumes the budget. The legacy field `midPrice` is
 * kept on the result for backwards compatibility; both fields hold the
 * same number.
 *
 * **Conservative depth:** scan smallest-to-largest. Depth is the largest
 * probe whose slippage AND every smaller probe's slippage stayed within
 * the target band. With merged-pool constant-product math, slippage is
 * monotone in notional — so `routingMonotone` is always true unless
 * a probe failed (no reserves available). Kept on the `DepthResult`
 * shape for backwards-compat with consumers that branch on it.
 *
 * Cost: one `fanout(pair)` call per invocation. Each adapter's
 * `getPrice()` is registry-cached, so when `getStableHealth(USDM)` has
 * already triggered the price fanout, the depth probe hits warm caches.
 */

import { fanout } from '../adapters/registry';
import { STABLE_METADATA } from './stable-metadata';

const DEFAULT_PROBES_ADA: ReadonlyArray<number> =
  Object.freeze([100, 1_000, 10_000, 100_000, 1_000_000]);

const DEFAULT_TARGET_SLIPPAGE_PCT = 1.0;
const DEFAULT_FEE_PCT = 0.3;   // 0.3 % typical CP-pool trading fee on Cardano DEXes

/** Per-pool reserves snapshot, normalised to whole-unit Numbers. */
export interface PoolReserveSample {
  source: string;
  /** ADA reserve in whole ADA units. */
  adaReserve: number;
  /** Non-ADA token reserve in whole token units (decimals already applied). */
  tokenReserve: number;
}

export interface ProbedPoint {
  /** ADA notional sent in (whole units). */
  amountAda: number;
  /** token_out / amount_in (whole units). */
  effectivePrice: number;
  /**
   * Slippage in PERCENT relative to the marginal mid-price (yTotal/xTotal).
   * Positive = worse than mid. Infinity = probe failed (no reserves).
   */
  slippagePct: number;
}

export interface DepthResult {
  /**
   * Pre-fee marginal price `yTotal / xTotal`. Null if no reserves were
   * available. Slippage measurements are taken against this number, so
   * slippage absorbs the trading fee — a 100-ADA probe against an
   * infinite-depth pool reports `slippagePct ≈ feeFraction × 100`.
   */
  marginalPrice: number | null;
  /**
   * @deprecated alias for `marginalPrice` — kept for callers serializing
   * the legacy field name. New code should read `marginalPrice`.
   */
  midPrice: number | null;
  /** Notional in ADA swappable at-or-below `targetSlippagePct` (conservative). */
  depthAda: number;
  /** True when ALL probes stayed within target — "depth is AT LEAST this much". */
  depthAtMaxProbed: boolean;
  /**
   * Always true under the merged-pool CP model unless a probe failed.
   * Retained for shape-compat with consumers branching on it.
   */
  routingMonotone: boolean;
  targetSlippagePct: number;
  probedPoints: ProbedPoint[];
  /** Per-pool reserves used to build the merged pool. Empty if no source returned reserves. */
  pools: PoolReserveSample[];
}

export interface ExecutableDepthOptions {
  probesAda?: ReadonlyArray<number>;
  targetSlippagePct?: number;
  /** Trading fee fraction (e.g. 0.003 for 0.3 %). Default 0.003. */
  feeFraction?: number;
  /** Test seam — replace the default fanout-backed pool fetcher. */
  fetchPools?: (pair: string) => Promise<PoolReserveSample[]>;
}

/**
 * Linear interpolation helper — finds where a piecewise function crosses
 * `target`. Returns null if the function never crosses.
 *
 * Retained from the previous DexHunter-backed implementation since the
 * unit-test suite covers it as a pure utility, and it's still useful
 * for downstream consumers that want fractional-depth interpolation.
 */
export function interpolateCrossing(
  points: ReadonlyArray<{ x: number; y: number }>,
  target: number,
): { x: number } | null {
  if (points.length === 0) return null;
  const idx = points.findIndex(p => p.y >= target);
  if (idx === -1) return null;
  if (idx === 0) return { x: points[0]!.x };
  const lo = points[idx - 1]!;
  const hi = points[idx]!;
  if (hi.y === lo.y) return { x: lo.x };
  const t = (target - lo.y) / (hi.y - lo.y);
  return { x: lo.x + t * (hi.x - lo.x) };
}

/**
 * Map a non-ADA token id (`policyId + assetNameHex` concatenated, lower-case
 * hex) to the canonical ADA-X pair name from the stable metadata registry.
 * Returns null if the token isn't a registered stable.
 */
function tokenIdToPair(tokenId: string): string | null {
  for (const meta of Object.values(STABLE_METADATA)) {
    if (meta.policyId + meta.assetNameHex === tokenId) return meta.pegPair;
  }
  return null;
}

/**
 * Default pool fetcher — calls the price registry's `fanout(pair)` and
 * extracts `adaReserve` + `tokenReserve` from each adapter's rawPayload.
 * Adapters that don't expose pool reserves (oracles, off-chain
 * attestations) are silently skipped.
 */
async function defaultFetchPools(pair: string): Promise<PoolReserveSample[]> {
  const meta = (() => {
    for (const m of Object.values(STABLE_METADATA)) {
      if (m.pegPair === pair) return m;
    }
    return null;
  })();
  const tokenDecimals = meta?.decimals ?? 6;

  const { quotes } = await fanout(pair);
  const samples: PoolReserveSample[] = [];
  for (const q of quotes) {
    const rp = q.rawPayload as { adaReserve?: string | number; tokenReserve?: string | number } | undefined;
    if (!rp || rp.adaReserve === undefined || rp.tokenReserve === undefined) continue;
    let adaRaw: bigint, tokRaw: bigint;
    try {
      adaRaw = BigInt(String(rp.adaReserve));
      tokRaw = BigInt(String(rp.tokenReserve));
    } catch { continue; }
    if (adaRaw <= 0n || tokRaw <= 0n) continue;
    samples.push({
      source:       q.sourceName,
      adaReserve:   Number(adaRaw) / 1_000_000,
      tokenReserve: Number(tokRaw) / 10 ** tokenDecimals,
    });
  }
  return samples;
}

/**
 * Constant-product swap output: `dy = dx · (1-f) · yRes / (xRes + dx · (1-f))`.
 * Inputs and outputs are in whole units (ADA, token).
 */
function cpSwapOutput(xRes: number, yRes: number, dxIn: number, feeFrac: number): number {
  if (xRes <= 0 || yRes <= 0 || dxIn <= 0) return 0;
  const dxAfterFee = dxIn * (1 - feeFrac);
  return (dxAfterFee * yRes) / (xRes + dxAfterFee);
}

/**
 * Probe executable depth for an ADA-paired stable token. `tokenId` is the
 * non-ADA token's `policyId + assetNameHex` concatenated.
 *
 * Returns a `DepthResult` describing the largest notional executable
 * within `targetSlippagePct` (default 1 %) given the merged-pool reserves
 * available across the supporting direct-DEX adapters.
 */
export async function executableDepthForToken(
  tokenId: string,
  opts: ExecutableDepthOptions = {},
): Promise<DepthResult> {
  if (!tokenId || typeof tokenId !== 'string') {
    throw new TypeError('executableDepthForToken: tokenId must be a non-empty string');
  }
  const pair = tokenIdToPair(tokenId);
  if (!pair) {
    throw new Error(`executableDepthForToken: tokenId ${tokenId} is not a registered stable`);
  }

  const probes = opts.probesAda ?? DEFAULT_PROBES_ADA;
  const targetSlip = opts.targetSlippagePct ?? DEFAULT_TARGET_SLIPPAGE_PCT;
  const feeFrac   = opts.feeFraction ?? (DEFAULT_FEE_PCT / 100);
  const fetchPools = opts.fetchPools ?? defaultFetchPools;

  const pools = await fetchPools(pair);

  // Merge: sum reserves into a virtual single CP pool.
  let xTotal = 0, yTotal = 0;
  for (const p of pools) {
    xTotal += p.adaReserve;
    yTotal += p.tokenReserve;
  }

  if (xTotal <= 0 || yTotal <= 0) {
    return {
      marginalPrice: null,
      midPrice: null,
      depthAda: 0,
      depthAtMaxProbed: false,
      routingMonotone: true,
      targetSlippagePct: targetSlip,
      probedPoints: probes.map(amount => ({
        amountAda: amount, effectivePrice: 0, slippagePct: Infinity,
      })),
      pools,
    };
  }

  const midPrice = yTotal / xTotal;

  // Probe each notional: simulate CP swap on the merged pool.
  const probedPoints: ProbedPoint[] = probes.map(amount => {
    const dyOut = cpSwapOutput(xTotal, yTotal, amount, feeFrac);
    if (dyOut <= 0) {
      return { amountAda: amount, effectivePrice: 0, slippagePct: Infinity };
    }
    const eff = dyOut / amount;
    const slip = midPrice > 0 ? ((midPrice - eff) / midPrice) * 100 : 0;
    return { amountAda: amount, effectivePrice: eff, slippagePct: Math.max(0, slip) };
  });

  // Conservative depth: largest probe where THIS and every smaller probe
  // stayed within target slippage. CP slippage is monotone in notional,
  // so this is equivalent to "largest probe under target".
  let depthAda = 0;
  let depthAtMaxProbed = true;
  for (const p of probedPoints) {
    if (p.slippagePct === Infinity || p.slippagePct > targetSlip) {
      depthAtMaxProbed = false;
      break;
    }
    depthAda = p.amountAda;
  }
  if (depthAda === 0) depthAtMaxProbed = false;

  return {
    marginalPrice: midPrice,
    midPrice,
    depthAda,
    depthAtMaxProbed,
    routingMonotone: true,    // merged-pool CP is monotone by construction
    targetSlippagePct: targetSlip,
    probedPoints,
    pools,
  };
}
