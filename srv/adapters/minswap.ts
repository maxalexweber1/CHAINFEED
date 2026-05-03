/**
 * Minswap adapter — read-only ADA-USD spot price via the Minswap
 * Aggregator's dedicated `/ada-price` endpoint.
 *
 * Why this endpoint (and not the per-asset metrics path): the aggregator
 * computes a single canonical "ADA in USD" number across Minswap's pools
 * with sane volume weighting. One round-trip, no decimals fiddling.
 *
 * Why we no longer use `/v1/assets/{id}/metrics?currency=ada` for other
 * pairs: the `currency` query parameter is silently ignored. For stables
 * (DJED, iUSD, USDM, USDA) the response is always USD-denominated; for
 * volatile tokens it appears ADA-denominated, but the absence of a
 * reliable indicator (categories field is empty for many tokens) makes
 * unit interpretation guesswork. Verified 2026-05-02 with curl probes
 * across 8 tokens including stables and volatiles. We rely on direct DEX
 * adapters (sundae, wingriders, minswap-v2) for non-USD pairs.
 *
 * USDM ≠ USD strictly (USDM was trading at $1.008 at research time), but
 * for ADA-USD the aggregator is fine; ADA-USDM coverage comes from
 * SundaeSwap V3 + Minswap V2 + WingRiders V2, all reading real
 * ADA/USDM pool data.
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
    kind: 'price',
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
