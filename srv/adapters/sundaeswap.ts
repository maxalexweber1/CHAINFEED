/**
 * SundaeSwap V3 adapter — reads ADA-paired pool reserves directly via the
 * V3 GraphQL endpoint, computes spot from the constant-product ratio.
 *
 * Per-pair config carries the non-ADA token (Sundae's `byPair` API takes
 * `assetA`, `assetB`; we always set `assetA = ada.lovelace`) plus the
 * non-ADA token's decimals so the raw quantity ratio can be normalised.
 *
 * Pool selection: `byPair` returns multiple pools for the same pair —
 * including dust ones. We pick the deepest by ADA reserve and discard
 * pools below `MIN_ADA_RESERVE_LOVELACE`.
 *
 * Pair direction follows CHAINFEED's convention: "Y per 1 X" for `X-Y`.
 *   - ADA-USDM → "USDM per 1 ADA" → spot = usdmReserve / adaReserve
 *   - ADA-USDCx → "USDCx per 1 ADA"
 *   - NIGHT-ADA → "ADA per 1 NIGHT" → spot = adaReserve / nightReserve
 *
 * Source: api.sundae.fi/graphql, schema discovered via introspection.
 */

import { postJson } from './http';
import { assertIsAdapter, type PriceAdapter, type PriceQuote } from './types';

const SOURCE_NAME = 'sundaeswap';
const URL = 'https://api.sundae.fi/graphql';

// Asset ID format on SundaeSwap V3: `<policyId>.<assetNameHex>`. ADA is `ada.lovelace`.
const ASSET_ADA = 'ada.lovelace';

interface PairCfg {
  /** Non-ADA token's `policyId.assetNameHex` for the V3 byPair query. */
  assetId: string;
  /** Decimals of the non-ADA token. ADA is always 6. */
  tokenDecimals: number;
  /**
   * Direction of the pair name relative to ADA position in the pool.
   * 'ADA-Y' (Y per 1 ADA): tokenY is the *quote* — return tokenY/ADA ratio.
   * 'X-ADA' (ADA per 1 X): tokenX is the *base* — return ADA/tokenX ratio.
   */
  direction: 'ada-base' | 'ada-quote';
}

const PAIR_CONFIG: Readonly<Record<string, PairCfg>> = Object.freeze({
  'ADA-USDM': {
    assetId:       'c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad.0014df105553444d',
    tokenDecimals: 6,
    direction:     'ada-base',
  },
  'ADA-USDCx': {
    assetId:       '1f3aec8bfe7ea4fe14c5f121e2a92e301afe414147860d557cac7e34.5553444378',
    tokenDecimals: 6,
    direction:     'ada-base',
  },
  'NIGHT-ADA': {
    assetId:       '0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa.4e49474854',
    tokenDecimals: 6,
    direction:     'ada-quote',
  },
});

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
  const cfg = PAIR_CONFIG[pair];
  if (!cfg) throw new Error(`sundaeswap: pair '${pair}' not supported`);

  const r = await postJson<SundaeResponse>(URL, {
    query: QUERY,
    variables: { a: ASSET_ADA, b: cfg.assetId },
  });
  if (r?.errors?.length) {
    throw new Error(`sundaeswap: graphql errors — ${JSON.stringify(r.errors).slice(0, 200)}`);
  }
  const pools = r?.data?.pools?.byPair ?? [];
  if (pools.length === 0) {
    throw new Error(`sundaeswap: no pools returned for ${pair}`);
  }

  // Pick the pool with the largest ADA reserve, ignoring dust. Require the
  // token side to be non-zero in the selection predicate — otherwise the
  // deepest-ADA pool with an empty token reserve would shadow a healthier
  // pool with a smaller (but real) ADA reserve.
  let best: { adaQ: bigint; tokenQ: bigint; id?: string } | null = null;
  for (const p of pools) {
    const adaQ = BigInt(p?.current?.quantityA?.quantity ?? '0');
    const tokenQ = BigInt(p?.current?.quantityB?.quantity ?? '0');
    if (adaQ < MIN_ADA_RESERVE_LOVELACE) continue;
    if (tokenQ <= 0n) continue;
    if (!best || adaQ > best.adaQ) {
      best = { adaQ, tokenQ, id: p?.id };
    }
  }
  if (!best) {
    throw new Error(`sundaeswap: every ${pair} pool was below the ${MIN_ADA_RESERVE_LOVELACE / 1_000_000n} ADA dust floor`);
  }
  if (best.adaQ === 0n || best.tokenQ === 0n) {
    throw new Error(`sundaeswap: best ${pair} pool has zero reserve on one side`);
  }

  // Both sides as JS numbers in their respective natural units.
  // ADA: lovelace / 1e6 = whole ADA. Token: raw / 10^tokenDecimals.
  const adaUnits   = Number(best.adaQ)   / 1_000_000;
  const tokenUnits = Number(best.tokenQ) / 10 ** cfg.tokenDecimals;

  // Spot price per pair-direction convention.
  const price = cfg.direction === 'ada-base'
    ? tokenUnits / adaUnits   // ADA-Y → Y per 1 ADA
    : adaUnits   / tokenUnits; // X-ADA → ADA per 1 X

  return {
    kind: 'price',
    sourceName: SOURCE_NAME,
    pair,
    price,
    timestamp:  Date.now(),
    rawPayload: {
      poolId:       best.id,
      adaReserve:   best.adaQ.toString(),
      tokenReserve: best.tokenQ.toString(),
      direction:    cfg.direction,
      poolCount:    pools.length,
    },
  };
}

function supportsPair(pair: string): boolean {
  return Object.prototype.hasOwnProperty.call(PAIR_CONFIG, pair);
}

const adapter: PriceAdapter = { sourceName: SOURCE_NAME, getPrice, supportsPair };
assertIsAdapter(adapter, 'sundaeswap');

export = adapter;
