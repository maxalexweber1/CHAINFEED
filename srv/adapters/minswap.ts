/**
 * Minswap adapter — read-only ADA-USD spot price via the Minswap
 * Aggregator's dedicated `/ada-price` endpoint.
 *
 * Why this endpoint (and not the per-asset metrics path): the aggregator
 * computes a single canonical "ADA in USD" number across Minswap's pools
 * with sane volume weighting. One round-trip, no decimals fiddling.
 *
 * USDM ≠ USD strictly (USDM was trading at $1.008 at research time), but
 * for Phase 2 v0.1 we expose only `ADA-USD` here. ADA-USDM coverage comes
 * from SundaeSwap V3 + DexHunter, which read real ADA/USDM pool data.
 *
 * Source: docs.minswap.org/developer/aggregator-api
 */

import { getJson } from './http';
import { assertIsAdapter, type PriceAdapter, type PriceQuote } from './types';

const SOURCE_NAME = 'minswap';
const URL_ADA_PRICE = 'https://agg-api.minswap.org/aggregator/ada-price?currency=usd';

const SUPPORTED_PAIRS = new Set(['ADA-USD']);

interface MinswapAdaPriceResponse {
  value?: { price?: number | string };
}

async function getPrice(pair: string): Promise<PriceQuote> {
  if (!SUPPORTED_PAIRS.has(pair)) throw new Error(`minswap: pair '${pair}' not supported`);

  const r = await getJson<MinswapAdaPriceResponse>(URL_ADA_PRICE);
  const price = Number(r?.value?.price);
  if (!Number.isFinite(price)) {
    throw new Error(`minswap: malformed response (price is ${r?.value?.price})`);
  }

  return {
    sourceName: SOURCE_NAME,
    pair,
    price,
    timestamp:  Date.now(),
    rawPayload: { source: 'aggregator/ada-price', value: r?.value },
  };
}

function supportsPair(pair: string): boolean {
  return SUPPORTED_PAIRS.has(pair);
}

const adapter: PriceAdapter = { sourceName: SOURCE_NAME, getPrice, supportsPair };
assertIsAdapter(adapter, 'minswap');

export = adapter;
