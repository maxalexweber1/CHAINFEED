/**
 * WingRiders V2 STABLESWAP direct-read — stable-vs-stable cross-rates.
 *
 * The existing `wingriders.ts` adapter handles CONSTANT_PRODUCT pools
 * (currently only NIGHT-ADA in scope). STABLESWAP pools live in the same
 * `LiquidityPoolV2` GraphQL type but use a Curve-style invariant, so naive
 * x*y/k math is wrong. This adapter handles the STABLESWAP family.
 *
 * **Why a separate adapter** (vs. extending wingriders.ts):
 *   1. Pair shape is **stable-vs-stable** (USDM-DJED, USDM-USDA, …),
 *      not ADA-vs-X. The existing adapter's `direction: 'ada-base' |
 *      'ada-quote'` model doesn't fit.
 *   2. Math differs: STABLESWAP requires treasury subtraction + scale
 *      normalization + (optionally) full Curve invariant solve.
 *   3. Source-name `wingriders-stableswap` is clearer in dashboards and
 *      in the convergence-checker (which asks "where did this stable-vs-
 *      stable cross-rate come from").
 *
 * **Math: this adapter exposes the RESERVE-RATIO, not exact STABLESWAP spot.**
 *
 * Curve's full STABLESWAP invariant is:
 *   `An × ∑x + D = An × D × n^n + D^(n+1) / (n^n × ∏x)`
 *
 * where `A` is the amplification factor — embedded in the pool datum
 * (not in the GraphQL response). Without `A` we can't compute the exact
 * spot. We compute the next-best signal: the reserve ratio
 *
 *   ratio(B per 1 A) = (activeReserveB × scaleB / 10^decB) / (activeReserveA × scaleA / 10^decA)
 *
 * with `activeReserve = quantity - treasury`. Live verification 2026-05-02:
 * the deepest WingRiders STABLESWAP pools (USDM-USDA, DJED-USDM, …) hold
 * reserves up to 7 % off the 1:1 balance point, while their actual
 * executable spot stays close to 1.0 — Curve's high-amplification design
 * keeps spot near peg even when reserves drift. So the reserve-ratio
 * reported here is **systematically MORE EXTREME than the true spot**.
 *
 * **Where this is useful**:
 *   - pool-imbalance monitoring (a 5 % reserve drift IS a stress signal,
 *     even if the actual swap price stays at 1.000 ± 0.5 %)
 *   - cross-stable convergence: persistent imbalance across multiple pools
 *     for the same stable surfaces protocol-specific peg-risk
 *
 * **Where this is the wrong tool**:
 *   - exact-trade pricing on large notionals — would need pool-datum
 *     decoding for the amplification factor (future sprint)
 *   - `pegDeviationBps` computation — would systematically over-state
 *     deviations relative to a true-spot reference
 *
 * Future Sprint candidate: decode the pool datum (28-byte factory hash +
 * encoded curve params + amplification) to compute true spot. Datum format
 * isn't published; would need reverse-engineering against
 * `@wingriders/dex-serializer` source if reachable. Out of scope today.
 *
 * **GraphQL endpoint** + filter caveats from the original wingriders.ts
 * apply: the `poolAssets` filter is broken, so we fetch all pools and
 * client-side-match by both policy IDs. Same 10s cache TTL applies.
 */

import { postJson } from './http';
import { assertIsAdapter, type PriceAdapter, type PriceQuote } from './types';

const SOURCE_NAME = 'wingriders-stableswap';
const URL = 'https://api.mainnet.wingriders.com/graphql';

interface TokenSpec {
  policyId: string;
  assetNameHex: string;
  /** Token decimals — almost always 6 on Cardano stables. */
  decimals: number;
}

interface PairCfg {
  /** "Numerator" token in the pair name X-Y. Pair "DJED-USDM" → tokenA = DJED. */
  tokenA: TokenSpec;
  /** "Denominator" token. Pair "DJED-USDM" → tokenB = USDM (price expressed as USDM per DJED). */
  tokenB: TokenSpec;
}

// Asset hex-name fragments for known stables (matches the policy IDs in
// `srv/lib/stable-metadata.ts`). Repeated here to keep the adapter
// self-contained — these change ~never.
const POL = {
  DJED: '8db269c3ec630e06ae29f74bc39edd1f87c819f1056206e879a1cd61',
  USDM: 'c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad',
  iUSD: 'f66d78b4a3cb3d37afa0ec36461e51ecbde00f26c8f0a68f94b69880',
  USDA: 'fe7c786ab321f41c654ef6c1af7b3250a613c24e4213e0425a7ae456',
  DAI:  '25c5de5f5b286073c593edfd77b48abc7a48e5a4f3d4cd9d428ff935',
} as const;

const NAME = {
  DJED: '446a65644d6963726f555344',  // ASCII "DjedMicroUSD"
  USDM: '0014df105553444d',           // CIP-67 prefix + "USDM"
  iUSD: '69555344',                   // ASCII "iUSD"
  USDA: '55534441',                   // ASCII "USDA"
  DAI:  '444149',                     // ASCII "DAI" (Wanchain bridged)
} as const;

const TOK = {
  DJED: { policyId: POL.DJED, assetNameHex: NAME.DJED, decimals: 6 },
  USDM: { policyId: POL.USDM, assetNameHex: NAME.USDM, decimals: 6 },
  iUSD: { policyId: POL.iUSD, assetNameHex: NAME.iUSD, decimals: 6 },
  USDA: { policyId: POL.USDA, assetNameHex: NAME.USDA, decimals: 6 },
  DAI:  { policyId: POL.DAI,  assetNameHex: NAME.DAI,  decimals: 6 },
} satisfies Record<string, TokenSpec>;

// Live-verified 2026-05-02: 5 of 7 STABLESWAP pools have meaningful TVL
// and a stable-vs-stable composition. iUSD-USDA pool [1] (8k ADA TVL)
// excluded — too dust to give a reliable signal. ADA-paired pool [0]
// excluded — STABLESWAP doesn't make sense for assets with very
// different prices.
//
// Convention: pair name `X-Y` reads "Y per 1 X". Inverted pairs
// (USDM-DJED + DJED-USDM) both supported; adapter picks up the same
// pool and outputs the appropriate side.
const PAIR_CONFIG: Readonly<Record<string, PairCfg>> = Object.freeze({
  // USDM as denominator (tokenB). Headline question: "how many USDM per 1 X?"
  'DJED-USDM': { tokenA: TOK.DJED, tokenB: TOK.USDM },
  'iUSD-USDM': { tokenA: TOK.iUSD, tokenB: TOK.USDM },
  'USDA-USDM': { tokenA: TOK.USDA, tokenB: TOK.USDM },
  // USDM as numerator
  'USDM-DJED': { tokenA: TOK.USDM, tokenB: TOK.DJED },
  'USDM-iUSD': { tokenA: TOK.USDM, tokenB: TOK.iUSD },
  'USDM-USDA': { tokenA: TOK.USDM, tokenB: TOK.USDA },
  // DJED-iUSD pool ~$37k TVL — moderate but routable.
  'DJED-iUSD': { tokenA: TOK.DJED, tokenB: TOK.iUSD },
  'iUSD-DJED': { tokenA: TOK.iUSD, tokenB: TOK.DJED },
  // DAI-DJED pool deliberately NOT included — live-verified 2026-05-02
  // it has only ~16 ADA TVL (pool 25c5de5f.DAI vs DjedMicroUSD), too dust
  // to give a usable reserve-ratio signal. Re-add if liquidity grows.
});

// 1000 ADA-equivalent floor — STABLESWAP pools don't expose tvlInAda
// reliably for ADA-paired entries, but for stable-stable it's a USD-scale
// proxy. Pools below this threshold (e.g. the 8k iUSD-USDA dust) won't be
// considered.
const MIN_POOL_VALUE_PROXY_ADA = 1000n * 1_000_000n;

const QUERY = `query AllPools {
  liquidityPools {
    ... on LiquidityPoolV2 {
      poolType
      tokenA { policyId assetName quantity }
      tokenB { policyId assetName quantity }
      treasuryA
      treasuryB
      scaleA
      scaleB
      tvlInAda
    }
  }
}`;

interface WrToken {
  policyId?: string;
  assetName?: string;
  quantity?: string;
}

interface WrPoolV2 {
  poolType?: string;
  tokenA?: WrToken;
  tokenB?: WrToken;
  treasuryA?: string;
  treasuryB?: string;
  scaleA?: string;
  scaleB?: string;
  tvlInAda?: string | null;
}

interface WrResp {
  data?: { liquidityPools?: WrPoolV2[] };
  errors?: unknown[];
}

/**
 * Match a token spec against a WingRiders Token. Both sides may be
 * empty-policy (ADA) — token-spec only matters when policyId set.
 */
function tokenMatches(t: WrToken | undefined, spec: TokenSpec): boolean {
  return !!t
      && t.policyId === spec.policyId
      && t.assetName === spec.assetNameHex;
}

/**
 * Find the pool matching the pair config (either A-B or B-A side order).
 * Returns the active reserves on each side (treasury subtracted), oriented
 * to the pair config's `tokenA`/`tokenB` direction.
 */
function findPool(pools: WrPoolV2[], cfg: PairCfg): {
  activeA: bigint;
  activeB: bigint;
  scaleA: bigint;
  scaleB: bigint;
  tvlInAda: string | null;
  rawPoolValueAda: bigint;
} | null {
  for (const p of pools) {
    if (p.poolType !== 'STABLESWAP') continue;
    const aIsTokenA = tokenMatches(p.tokenA, cfg.tokenA);
    const bIsTokenB = tokenMatches(p.tokenB, cfg.tokenB);
    const aIsTokenB = tokenMatches(p.tokenA, cfg.tokenB);
    const bIsTokenA = tokenMatches(p.tokenB, cfg.tokenA);

    let pairA: WrToken | undefined;
    let pairB: WrToken | undefined;
    let treasuryA: string | undefined;
    let treasuryB: string | undefined;
    let scaleAStr: string | undefined;
    let scaleBStr: string | undefined;

    if (aIsTokenA && bIsTokenB) {
      pairA = p.tokenA; pairB = p.tokenB;
      treasuryA = p.treasuryA; treasuryB = p.treasuryB;
      scaleAStr = p.scaleA;    scaleBStr = p.scaleB;
    } else if (bIsTokenA && aIsTokenB) {
      // Pool has tokens reversed relative to our pair config — flip.
      pairA = p.tokenB; pairB = p.tokenA;
      treasuryA = p.treasuryB; treasuryB = p.treasuryA;
      scaleAStr = p.scaleB;    scaleBStr = p.scaleA;
    } else {
      continue;
    }

    const qA = BigInt(pairA?.quantity ?? '0');
    const qB = BigInt(pairB?.quantity ?? '0');
    const tA = BigInt(treasuryA ?? '0');
    const tB = BigInt(treasuryB ?? '0');
    const sA = BigInt(scaleAStr ?? '1');
    const sB = BigInt(scaleBStr ?? '1');

    const activeA = qA - tA;
    const activeB = qB - tB;
    if (activeA <= 0n || activeB <= 0n) continue;

    // Use the pool's tvlInAda if available; if null (rare for stable-stable
    // pools), fall back to a floor-check via raw quantity sums.
    const tvl = p.tvlInAda ?? null;
    const rawPoolValueAda = tvl !== null ? BigInt(tvl.split('.')[0] ?? '0') : qA + qB;
    if (rawPoolValueAda < MIN_POOL_VALUE_PROXY_ADA) continue;

    return { activeA, activeB, scaleA: sA, scaleB: sB, tvlInAda: tvl, rawPoolValueAda };
  }
  return null;
}

async function getPrice(pair: string): Promise<PriceQuote> {
  const cfg = PAIR_CONFIG[pair];
  if (!cfg) throw new Error(`wingriders-stableswap: pair '${pair}' not supported`);

  const r = await postJson<WrResp>(URL, { query: QUERY }, { timeoutMs: 8_000 });
  if (r?.errors?.length) {
    throw new Error(`wingriders-stableswap: graphql errors — ${JSON.stringify(r.errors).slice(0, 200)}`);
  }
  const pools = r?.data?.liquidityPools ?? [];
  if (pools.length === 0) {
    throw new Error('wingriders-stableswap: liquidityPools returned empty list');
  }

  const found = findPool(pools, cfg);
  if (!found) {
    throw new Error(`wingriders-stableswap: no STABLESWAP pool matching ${pair} above the ${MIN_POOL_VALUE_PROXY_ADA / 1_000_000n}-ADA TVL floor`);
  }

  // Spot ≈ (activeB × scaleB) / (activeA × scaleA), then divide by the
  // decimal-adjustment ratio to express in whole tokens. Both stables
  // here are 6-decimal so the decimal correction cancels.
  // Use Number() for the final division — at this scale (≤ 1e15 raw
  // units) we're well inside Number's 2^53 precision band.
  const scaledA = Number(found.activeA * found.scaleA) / 10 ** cfg.tokenA.decimals;
  const scaledB = Number(found.activeB * found.scaleB) / 10 ** cfg.tokenB.decimals;
  const price = scaledB / scaledA;

  return {
    kind: 'price',
    sourceName: SOURCE_NAME,
    pair,
    price,
    timestamp: Date.now(),
    rawPayload: {
      poolKind:        'STABLESWAP',
      activeReserveA:  found.activeA.toString(),
      activeReserveB:  found.activeB.toString(),
      scaleA:          found.scaleA.toString(),
      scaleB:          found.scaleB.toString(),
      tvlInAda:        found.tvlInAda,
      formula:         'reserveRatio = (activeB × scaleB / 10^decB) / (activeA × scaleA / 10^decA) — this is the POOL RESERVE-RATIO, not exact STABLESWAP spot.',
      caveat:          'Reserve-ratio systematically over-states peg deviation vs true Curve spot (which depends on the amplification factor, not exposed via GraphQL). Use for pool-imbalance monitoring and cross-stable convergence checks; do NOT compute pegDeviationBps from this. Exact-trade pricing requires pool-datum decoding (future sprint).',
    },
  };
}

function supportsPair(pair: string): boolean {
  return Object.prototype.hasOwnProperty.call(PAIR_CONFIG, pair);
}

const adapter: PriceAdapter = { sourceName: SOURCE_NAME, getPrice, supportsPair };
assertIsAdapter(adapter, 'wingriders-stableswap');

const exported = {
  ...adapter,
  // exposed for tests:
  _findPool: findPool,
  _PAIR_CONFIG: PAIR_CONFIG,
  _MIN_POOL_VALUE_PROXY_ADA: MIN_POOL_VALUE_PROXY_ADA,
};

export = exported;
