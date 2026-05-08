/**
 * Liqwid Finance v2 — MarketState datum decoder.
 *
 * Liqwid v2 is closed-source Plutarch (no public Aiken types). The 11-field
 * layout was reverse-engineered 2026-05-08 by decoding live MarketState
 * UTxOs across qDJED / qiUSD / qUSDM and cross-validating field semantics
 * against on-chain invariants:
 *
 *   - field[2] (qTokenSupply) === qToken policy total_supply on chain
 *   - field[9].denominator === field[2]   (qTokenRate-as-rational invariant)
 *   - field[0] + field[3] + field[4] ≈ public app's "Total supplied" stat
 *
 * Outer datum is a `PlutusData.List` (NOT a Constr-wrap). Fields are flat:
 * 9 raw integers + two `[num, denom]` integer pairs at indexes [6] and [9].
 *
 * Field [6] (interestModel) is decoded as opaque `[hi, lo]` bigints — its
 * encoding is unknown and not needed for utilization/totalSupplied/qTokenRate.
 * APY computation is delegated to the Liqwid GraphQL API via liqwid-graphql.ts.
 *
 * Live anchor samples (datum hashes captured 2026-05-08, see memory file
 * `liqwid-reverse-engineering.md`):
 *   qDJED MarketState `9ea052184bccfe38ad952c6af40f90cecce184cebcef89c705b2205be55bb821`
 *   qiUSD MarketState `606d42b00ca7a29bc88461cb95f33e6f1bd39dc1ff96ddd2b615c1bf004d231b`
 *   qUSDM MarketState `83c09d5d92f6c55c92f1c604a60cee9cab73d33617afbab2403f05b91e61a9a3`
 */

import * as CSL from '@emurgo/cardano-serialization-lib-nodejs';

// ── Types ────────────────────────────────────────────────────────────

export interface DecodedMarketState {
  /** field[0] — idle / unborrowed underlying in market (raw units). */
  supplyRaw: bigint;
  /** field[1] — signed interest accumulator. Negative observed in v1; v2 fix unconfirmed. */
  interestRaw: bigint;
  /** field[2] — total qTokens minted. Invariant: equals qToken policy total_supply. */
  qTokenSupplyRaw: bigint;
  /** field[3] — total borrowed (raw units). */
  principalRaw: bigint;
  /** field[4] — protocol reserve cut from accrued interest. */
  reserveRaw: bigint;
  /** field[5] — cumulative interest index (~10^16 magnitude observed). */
  interestIndex: bigint;
  /** field[6] — opaque [hi, lo] rate-curve params; encoding unknown, do NOT use for math. */
  interestModelHi: bigint;
  interestModelLo: bigint;
  /** field[7] — wall-time of last interest accrual (ms epoch). */
  lastInterestUpdateMs: number;
  /** field[8] — next batch settlement deadline (ms epoch). */
  nextBatchDeadlineMs: number;
  /** field[9] — qTokenRate as rational [num, denom]. Invariant: denom === qTokenSupplyRaw. */
  qTokenRateNum: bigint;
  qTokenRateDenom: bigint;
  /** field[10] — dust ADA in lovelace (3_000_000 observed across all 3 markets). */
  minAdaLovelace: bigint;
}

// ── Helpers (CSL → bigint) ───────────────────────────────────────────

function asInt(d: CSL.PlutusData | null | undefined): bigint | null {
  if (!d) return null;
  const i = d.as_integer();
  if (!i) return null;
  // CSL.BigInt.to_str() preserves sign for negative values.
  return BigInt(i.to_str());
}

function asUintMs(d: CSL.PlutusData | null | undefined): number | null {
  const v = asInt(d);
  if (v === null) return null;
  // Number-precision ms timestamps are good through year 287396 — safe.
  return Number(v);
}

function asList(d: CSL.PlutusData | null | undefined): CSL.PlutusList | null {
  if (!d) return null;
  return d.as_list() ?? null;
}

function listGet(l: CSL.PlutusList, idx: number): CSL.PlutusData | null {
  if (idx >= l.len()) return null;
  return l.get(idx);
}

// ── Decoder ──────────────────────────────────────────────────────────

/**
 * Decode a Liqwid MarketState inline-datum hex string.
 * Returns null if the hex is unparseable or doesn't match the 11-field shape.
 *
 * Expects an outer `PlutusData.List` (not `Constr`). Fields [6] and [9] are
 * sub-lists of two integers each. Any structural deviation returns null —
 * caller MUST log + skip rather than throw, so we don't 5xx on a chain
 * change between deploys.
 */
export function decodeMarketStateDatum(inlineDatumHex: string): DecodedMarketState | null {
  let outer: CSL.PlutusList | null;
  try {
    const data = CSL.PlutusData.from_hex(inlineDatumHex);
    outer = data.as_list() ?? null;
  } catch {
    return null;
  }
  if (!outer || outer.len() < 11) return null;

  const supplyRaw         = asInt(listGet(outer, 0));
  const interestRaw       = asInt(listGet(outer, 1));
  const qTokenSupplyRaw   = asInt(listGet(outer, 2));
  const principalRaw      = asInt(listGet(outer, 3));
  const reserveRaw        = asInt(listGet(outer, 4));
  const interestIndex     = asInt(listGet(outer, 5));
  const interestModelList = asList(listGet(outer, 6));
  const lastInterestMs    = asUintMs(listGet(outer, 7));
  const nextBatchMs       = asUintMs(listGet(outer, 8));
  const qTokenRateList    = asList(listGet(outer, 9));
  const minAdaLovelace    = asInt(listGet(outer, 10));

  if (
    supplyRaw       === null ||
    interestRaw     === null ||
    qTokenSupplyRaw === null ||
    principalRaw    === null ||
    reserveRaw      === null ||
    interestIndex   === null ||
    !interestModelList || interestModelList.len() < 2 ||
    lastInterestMs  === null ||
    nextBatchMs     === null ||
    !qTokenRateList || qTokenRateList.len() < 2 ||
    minAdaLovelace  === null
  ) {
    return null;
  }

  const interestModelHi = asInt(listGet(interestModelList, 0));
  const interestModelLo = asInt(listGet(interestModelList, 1));
  const qTokenRateNum   = asInt(listGet(qTokenRateList, 0));
  const qTokenRateDenom = asInt(listGet(qTokenRateList, 1));
  if (
    interestModelHi === null || interestModelLo === null ||
    qTokenRateNum   === null || qTokenRateDenom === null
  ) return null;

  return {
    supplyRaw,
    interestRaw,
    qTokenSupplyRaw,
    principalRaw,
    reserveRaw,
    interestIndex,
    interestModelHi,
    interestModelLo,
    lastInterestUpdateMs: lastInterestMs,
    nextBatchDeadlineMs:  nextBatchMs,
    qTokenRateNum,
    qTokenRateDenom,
    minAdaLovelace,
  };
}

// ── Pure-fn helpers (deriving public stats from decoded state) ───────

/**
 * Total supplied = idle + borrowed + reserve. This is what FluidTokens'
 * health-card and Liqwid's app both display as "Total supply" for a market.
 */
export function totalSuppliedRaw(s: DecodedMarketState): bigint {
  return s.supplyRaw + s.principalRaw + s.reserveRaw;
}

/**
 * Utilization in [0, 1]. Compound-v2 semantics: reserve EXCLUDED from
 * the denominator (utilization = borrowed / (idle + borrowed)). Number
 * precision is fine — all observed magnitudes fit comfortably below 2^53.
 */
export function utilizationFraction(s: DecodedMarketState): number {
  const denom = s.supplyRaw + s.principalRaw;
  if (denom === 0n) return 0;
  return Number(s.principalRaw) / Number(denom);
}

/**
 * qTokenRate as a JS Number — the on-chain rational [num, denom] is small
 * enough (≤ ~10^14 / ~10^14) to round-trip through Float64 without
 * meaningful precision loss for display purposes.
 */
export function qTokenRate(s: DecodedMarketState): number {
  if (s.qTokenRateDenom === 0n) return 0;
  return Number(s.qTokenRateNum) / Number(s.qTokenRateDenom);
}
