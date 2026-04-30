/**
 * SundaeSwap V3 adapter — reads ADA/USDM pool reserves directly via the
 * V3 GraphQL endpoint, computes spot from the constant-product ratio.
 *
 * SundaeSwap's `pools.byPair` returns multiple pools for the same pair,
 * including dust ones. We pick the deepest by ADA reserve, which is the
 * one any sensible trader would route through.
 *
 * Source: api.sundae.fi/graphql, schema discovered via introspection.
 */

import { postJson } from './http';
import { assertIsAdapter, type PriceAdapter, type PriceQuote } from './types';

const SOURCE_NAME = 'sundaeswap';
const URL = 'https://api.sundae.fi/graphql';

// Asset ID format on SundaeSwap V3: `<policyId>.<assetNameHex>`. ADA is `ada.lovelace`.
const ASSET_ADA  = 'ada.lovelace';
const ASSET_USDM = 'c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad.0014df105553444d';

// Both ADA and USDM are 6-decimal, so the raw quantity ratio IS the price.
// If we ever add pairs with different decimals, factor that in here.

// Note: SundaeSwap V3's schema declares assetA/assetB as ID!, not String!,
// so the query variables must be typed accordingly or the GraphQL server
// 422s with a position-mismatch error.
const QUERY = `query Pools($a: ID!, $b: ID!) {
  pools {
    byPair(assetA: $a, assetB: $b) {
      id
      current { quantityA { quantity } quantityB { quantity } }
    }
  }
}`;

const SUPPORTED_PAIRS = new Set(['ADA-USDM']);

// Filter out dust pools — anything with < 1000 ADA reserve is liquidity
// theatre, not a price-discovery venue.
const MIN_ADA_RESERVE_LOVELACE = 1000n * 1_000_000n; // 1000 ADA

interface SundaePool {
  id?: string;
  current?: {
    quantityA?: { quantity?: string };
    quantityB?: { quantity?: string };
  };
}

interface SundaeResponse {
  data?: { pools?: { byPair?: SundaePool[] } };
  errors?: unknown[];
}

async function getPrice(pair: string): Promise<PriceQuote> {
  if (!SUPPORTED_PAIRS.has(pair)) throw new Error(`sundaeswap: pair '${pair}' not supported`);

  const r = await postJson<SundaeResponse>(URL, {
    query: QUERY,
    variables: { a: ASSET_ADA, b: ASSET_USDM },
  });
  if (r?.errors?.length) {
    throw new Error(`sundaeswap: graphql errors — ${JSON.stringify(r.errors).slice(0, 200)}`);
  }
  const pools = r?.data?.pools?.byPair ?? [];
  if (pools.length === 0) {
    throw new Error('sundaeswap: no pools returned for ADA/USDM');
  }

  // Pick the pool with the largest ADA reserve.
  let best: { adaQ: bigint; usdmQ: bigint; id?: string } | null = null;
  for (const p of pools) {
    const adaQ = BigInt(p?.current?.quantityA?.quantity ?? '0');
    if (adaQ < MIN_ADA_RESERVE_LOVELACE) continue;
    if (!best || adaQ > best.adaQ) {
      best = {
        adaQ,
        usdmQ: BigInt(p?.current?.quantityB?.quantity ?? '0'),
        id: p?.id,
      };
    }
  }
  if (!best) {
    throw new Error('sundaeswap: every ADA/USDM pool was below the dust floor');
  }
  if (best.adaQ === 0n) {
    throw new Error('sundaeswap: best pool has zero ADA reserve');
  }

  // Spot price = USDM-per-ADA. Both 6 decimals, so raw ratio is final.
  const price = Number(best.usdmQ) / Number(best.adaQ);

  return {
    sourceName: SOURCE_NAME,
    pair,
    price,
    timestamp:  Date.now(),
    rawPayload: {
      poolId:        best.id,
      adaReserve:    best.adaQ.toString(),
      usdmReserve:   best.usdmQ.toString(),
      poolCount:     pools.length,
    },
  };
}

function supportsPair(pair: string): boolean {
  return SUPPORTED_PAIRS.has(pair);
}

const adapter: PriceAdapter = { sourceName: SOURCE_NAME, getPrice, supportsPair };
assertIsAdapter(adapter, 'sundaeswap');

export = adapter;
