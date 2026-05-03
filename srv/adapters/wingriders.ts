/**
 * WingRiders V2 adapter — direct GraphQL pool reader.
 *
 * Covers NIGHT-ADA + the four ADA-stable pairs. Audit 2026-05-03 confirmed
 * WingRiders V2 ADA-stable pools are CONSTANT_PRODUCT (not STABLESWAP as
 * a stale comment previously claimed) — naive `tokenUnits / adaUnits`
 * spot math gives the right number, verified live against ADA-USD ~$0.248:
 *   ADA-USDM 4.25M ADA pool → 0.2487 USDM/ADA
 *   ADA-USDA 4.50M ADA pool → 0.2486 USDA/ADA
 *   ADA-DJED   277k ADA pool → 0.2505 DJED/ADA
 *   ADA-iUSD    11k ADA pool → 0.2499 iUSD/ADA (small, but routable)
 * Stable-vs-stable STABLESWAP pools live in `wingriders-stableswap.ts`;
 * those genuinely need amplification-factor decoding and are a different
 * concern.
 *
 * Two known schema gotchas:
 *   1. The `liquidityPools(input: { poolAssets: [...] })` filter returns
 *      `[]` even when a pool exists — verified 2026-05-02 across 6 tokens.
 *      Workaround: fetch the unfiltered pool list and client-side-filter.
 *   2. `tokenA.policyId == ""` is the ADA side. The PoolAsset filter
 *      rejects empty policy IDs, so we always identify pools by the
 *      non-ADA token only and verify the other side is ADA in the response.
 *
 * Pool selection: deepest CONSTANT_PRODUCT pool above a 1000-ADA dust
 * floor, matched by exact (policyId, assetNameHex) tuple. Important for
 * shared-policy assets — Indigo policy `f66d78b4...` mints iUSD plus
 * iBTC/iETH/iSOL on the same policyId, so the asset-name filter is
 * load-bearing for correct pool selection.
 *
 * Endpoint: `https://api.mainnet.wingriders.com/graphql`. No auth, no
 * documented rate limit (it's an internal endpoint discovered via
 * introspection — see docs/research/dex-apis.md §3).
 */

import { postJson } from './http';
import { assertIsAdapter, type PriceAdapter, type PriceQuote } from './types';

const SOURCE_NAME = 'wingriders';
const URL = 'https://api.mainnet.wingriders.com/graphql';

interface PairCfg {
  /** Non-ADA token's policy ID (28 bytes / 56 hex). */
  policyId: string;
  /** Non-ADA token's asset name in hex. */
  assetNameHex: string;
  /** Decimals of the non-ADA token (ADA is always 6). */
  tokenDecimals: number;
  /**
   * 'ada-base' (X-Y, X = ADA): spot = tokenUnits / adaUnits.
   * 'ada-quote' (X-ADA, X = non-ADA): spot = adaUnits / tokenUnits.
   */
  direction: 'ada-base' | 'ada-quote';
}

const PAIR_CONFIG: Readonly<Record<string, PairCfg>> = Object.freeze({
  'NIGHT-ADA': {
    policyId:      '0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa',
    assetNameHex:  '4e49474854',  // "NIGHT"
    tokenDecimals: 6,
    direction:     'ada-quote',
  },
  'ADA-USDM': {
    policyId:      'c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad',
    assetNameHex:  '0014df105553444d',  // CIP-67 prefix + "USDM"
    tokenDecimals: 6,
    direction:     'ada-base',
  },
  'ADA-USDA': {
    policyId:      'fe7c786ab321f41c654ef6c1af7b3250a613c24e4213e0425a7ae456',
    assetNameHex:  '55534441',  // "USDA"
    tokenDecimals: 6,
    direction:     'ada-base',
  },
  'ADA-DJED': {
    // Coti's policy mints both DjedMicroUSD and ShenMicroUSD — exact
    // assetName filter is what disambiguates. The DJED pool is much
    // smaller than the SHEN one (live: 277k vs 470k ADA TVL), so a naive
    // policy-only match would pick the wrong pool.
    policyId:      '8db269c3ec630e06ae29f74bc39edd1f87c819f1056206e879a1cd61',
    assetNameHex:  '446a65644d6963726f555344',  // "DjedMicroUSD"
    tokenDecimals: 6,
    direction:     'ada-base',
  },
  'ADA-iUSD': {
    // Indigo's policy mints iUSD + iBTC + iETH + iSOL — assetName
    // disambiguates. Pool is small (~11k ADA) but the math matches,
    // and orcfax + Minswap V2 backstop the source coverage.
    policyId:      'f66d78b4a3cb3d37afa0ec36461e51ecbde00f26c8f0a68f94b69880',
    assetNameHex:  '69555344',  // "iUSD"
    tokenDecimals: 6,
    direction:     'ada-base',
  },
});

// Filter floor: ignore pools below 1000 ADA on the ADA side. Same threshold
// as the SundaeSwap adapter — keeps dust pools out of price aggregation.
const MIN_ADA_RESERVE_LOVELACE = 1000n * 1_000_000n;

// We pull pool TVL + types in one query. `aggregatedMarketData` is volumes/fees,
// not used here but cheap to fetch and exposed on rawPayload for debugging.
const QUERY_ALL_POOLS = `query AllPools {
  liquidityPools {
    ... on ILiquidityPool {
      version
      poolType
      tokenA { policyId assetName quantity }
      tokenB { policyId assetName quantity }
      tvlInAda
    }
  }
}`;

interface WrToken {
  policyId?: string;
  assetName?: string;
  quantity?: string;
}

interface WrPool {
  version?: string;
  poolType?: string;
  tokenA?: WrToken;
  tokenB?: WrToken;
  tvlInAda?: string | null;
}

interface WrResponse {
  data?: { liquidityPools?: WrPool[] };
  errors?: unknown[];
}

async function getPrice(pair: string): Promise<PriceQuote> {
  const cfg = PAIR_CONFIG[pair];
  if (!cfg) throw new Error(`wingriders: pair '${pair}' not supported`);

  const r = await postJson<WrResponse>(URL, { query: QUERY_ALL_POOLS }, { timeoutMs: 8_000 });
  if (r?.errors?.length) {
    throw new Error(`wingriders: graphql errors — ${JSON.stringify(r.errors).slice(0, 200)}`);
  }
  const pools = r?.data?.liquidityPools ?? [];
  if (pools.length === 0) {
    throw new Error('wingriders: liquidityPools returned empty list');
  }

  // Find ADA / token pools. ADA side has `policyId === ''`.
  // Only CONSTANT_PRODUCT — stableswap math is different and we don't decode it.
  let best: { adaQ: bigint; tokenQ: bigint; version?: string; tvl?: string | null } | null = null;
  for (const p of pools) {
    if (p.poolType !== 'CONSTANT_PRODUCT') continue;
    const a = p.tokenA ?? {};
    const b = p.tokenB ?? {};
    const aIsAda = a.policyId === '';
    const bIsAda = b.policyId === '';
    const aIsToken = a.policyId === cfg.policyId && a.assetName === cfg.assetNameHex;
    const bIsToken = b.policyId === cfg.policyId && b.assetName === cfg.assetNameHex;
    let adaQ: bigint, tokenQ: bigint;
    if (aIsAda && bIsToken) {
      adaQ   = BigInt(a.quantity ?? '0');
      tokenQ = BigInt(b.quantity ?? '0');
    } else if (bIsAda && aIsToken) {
      adaQ   = BigInt(b.quantity ?? '0');
      tokenQ = BigInt(a.quantity ?? '0');
    } else {
      continue;
    }
    if (adaQ < MIN_ADA_RESERVE_LOVELACE) continue;
    if (!best || adaQ > best.adaQ) {
      best = { adaQ, tokenQ, version: p.version, tvl: p.tvlInAda ?? null };
    }
  }
  if (!best) {
    throw new Error(`wingriders: no CONSTANT_PRODUCT ADA-${pair} pool above the ${MIN_ADA_RESERVE_LOVELACE / 1_000_000n} ADA dust floor`);
  }
  if (best.tokenQ === 0n) {
    throw new Error(`wingriders: best ${pair} pool has zero token reserve`);
  }

  const adaUnits   = Number(best.adaQ)   / 1_000_000;
  const tokenUnits = Number(best.tokenQ) / 10 ** cfg.tokenDecimals;

  const price = cfg.direction === 'ada-base'
    ? tokenUnits / adaUnits
    : adaUnits   / tokenUnits;

  return {
    kind: 'price',
    sourceName: SOURCE_NAME,
    pair,
    price,
    timestamp:  Date.now(),
    rawPayload: {
      version:      best.version,
      poolType:     'CONSTANT_PRODUCT',
      adaReserve:   best.adaQ.toString(),
      tokenReserve: best.tokenQ.toString(),
      tvlInAda:     best.tvl,
      direction:    cfg.direction,
    },
  };
}

function supportsPair(pair: string): boolean {
  return Object.prototype.hasOwnProperty.call(PAIR_CONFIG, pair);
}

const adapter: PriceAdapter = { sourceName: SOURCE_NAME, getPrice, supportsPair };
assertIsAdapter(adapter, 'wingriders');

export = adapter;
