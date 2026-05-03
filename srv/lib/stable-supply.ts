/**
 * Stable supply fetcher — pulls total/circulating from Minswap's
 * `/v1/assets/{policy+name}/metrics` endpoint. Currency-independent (the
 * supply field is the same regardless of the broken `currency` parameter).
 *
 * **Future ODATANO migration target**: this should switch to
 * `bridge.getAssetInfo(policyId, assetNameHex)` once the bridge ships
 * Priority 3 from `docs/odatano-feedback.md`. The Minswap path stays as
 * a fallback/cross-check then.
 *
 * Sprint 2 isolation: this lives in `srv/lib/` (not in an adapter)
 * because supply is metadata about the asset, not a price quote — it
 * doesn't fit the `PriceAdapter` interface.
 */

import { getJson } from '../adapters/http';
import type { StableMetadata } from './stable-metadata';

const MINSWAP_BASE = 'https://api-mainnet-prod.minswap.org/v1/assets';

export interface StableSupply {
  totalSupply: number | null;
  circulatingSupply: number | null;
  source: 'minswap-metrics';
  fetchedAt: number;
}

interface MinswapAssetMetricsResponse {
  total_supply?: number | string;
  circulating_supply?: number | string;
  asset?: { metadata?: { decimals?: number } };
}

/**
 * Hard-timeout helper — Promise.race against a setTimeout-rejected promise.
 * Used by stable-health orchestration so a slow/hung Minswap fetch can't
 * pin the whole getStableHealth call.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}: timeout after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      v => { clearTimeout(timer); resolve(v); },
      e => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * Fetch supply for a registered stable. Uses the asset's policyId +
 * assetNameHex from STABLE_METADATA. Returns nulls (not throws) on
 * failure so the caller can decide whether to surface a degraded
 * response or fail outright.
 */
export async function fetchStableSupply(
  meta: Pick<StableMetadata, 'policyId' | 'assetNameHex'>,
  opts: { timeoutMs?: number } = {},
): Promise<StableSupply> {
  const url = `${MINSWAP_BASE}/${meta.policyId}${meta.assetNameHex}/metrics?currency=usd`;
  try {
    const r = await withTimeout(
      getJson<MinswapAssetMetricsResponse>(url),
      opts.timeoutMs ?? 5_000,
      `fetchStableSupply(${meta.policyId.slice(0, 8)})`,
    );
    const total = Number(r?.total_supply);
    const circ  = Number(r?.circulating_supply);
    return {
      totalSupply:       Number.isFinite(total) ? total : null,
      circulatingSupply: Number.isFinite(circ)  ? circ  : null,
      source:            'minswap-metrics',
      fetchedAt:         Date.now(),
    };
  } catch {
    return {
      totalSupply:       null,
      circulatingSupply: null,
      source:            'minswap-metrics',
      fetchedAt:         Date.now(),
    };
  }
}
