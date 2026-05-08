/**
 * Liqwid Finance v2 — GraphQL client (APY-only fallback).
 *
 * Liqwid v2 is closed-source Plutarch; the rate-curve params encoded in
 * MarketState `field[6]` use an undocumented schema. CHAINFEED's hybrid
 * strategy reads supply/borrow/utilization/qTokenRate directly from the
 * on-chain datum (verifiable) and uses this GraphQL endpoint only for
 * APY values.
 *
 * Endpoint: https://v2.api.liqwid.finance/graphql — Express server, CORS
 * open, no auth required, no rate-limit observed in light testing.
 *
 * Caveats:
 *   - This is a third-party API. Treat APY values as `source: liqwid-api`
 *     in the response so consumers can distinguish from on-chain reads.
 *   - The schema is not versioned; field renames would silently break.
 *     We over-narrow the query to fail fast on unexpected nulls.
 */

import { resolveLiqwidNetwork, cfg, type LiqwidNetwork } from './liqwid-config';

// ── Public types ─────────────────────────────────────────────────────

export interface LiqwidApyData {
  /** Liqwid GraphQL `id` field (e.g. 'DJED', 'IUSD', 'USDM'). */
  liqwidId: string;
  /** Suppliers' annualized yield as a decimal fraction (0.05 = 5%). Excludes LQ rewards. */
  supplyAPY: number;
  /** Borrowers' annualized rate as a decimal fraction. */
  borrowAPY: number;
  /** LQ-rewards APY for suppliers. Often 0 in current epochs. */
  lqSupplyAPY: number;
  /** ISO timestamp of last update on Liqwid's side. */
  updatedAt: string;
}

// ── Implementation ──────────────────────────────────────────────────

const QUERY_ALL_MARKETS = `{
  liqwid {
    data {
      markets(input: { perPage: 100 }) {
        results {
          id
          supplyAPY
          borrowAPY
          lqSupplyAPY
          updatedAt
          frozen
          private
          delisting
        }
      }
    }
  }
}`;

interface GraphQLMarketRow {
  id: string;
  supplyAPY: number;
  borrowAPY: number;
  lqSupplyAPY: number;
  updatedAt: string;
  frozen: boolean;
  private: boolean;
  delisting: boolean;
}

interface GraphQLEnvelope {
  data?: { liqwid?: { data?: { markets?: { results?: GraphQLMarketRow[] } } } };
  errors?: Array<{ message: string }>;
}

/**
 * Fetch APY data for a specific market by Liqwid GraphQL id.
 * Returns null if the market is missing, frozen, private, or delisting —
 * caller should fall back to on-chain-only output in that case.
 */
export async function fetchLiqwidApy(
  liqwidId: string,
  network: LiqwidNetwork = resolveLiqwidNetwork(),
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 8000,
): Promise<LiqwidApyData | null> {
  const all = await fetchAllLiqwidApy(network, fetchImpl, timeoutMs);
  return all.get(liqwidId.toUpperCase()) ?? null;
}

/**
 * Fetch APY data for all in-scope markets in one shot. Returns a map
 * keyed by uppercased Liqwid id (so 'iUSD' lookup uses 'IUSD' on the API
 * side — Liqwid's id is uppercased even when displayName isn't).
 *
 * Excludes frozen / private / delisting markets — those are not
 * meaningful for public-facing health views.
 */
export async function fetchAllLiqwidApy(
  network: LiqwidNetwork = resolveLiqwidNetwork(),
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 8000,
): Promise<Map<string, LiqwidApyData>> {
  const endpoint = cfg(network).graphqlEndpoint;
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);

  let envelope: GraphQLEnvelope;
  try {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ query: QUERY_ALL_MARKETS }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new Error(`liqwid-graphql: HTTP ${res.status} ${res.statusText}`);
    }
    envelope = await res.json() as GraphQLEnvelope;
  } finally {
    clearTimeout(tid);
  }

  if (envelope.errors && envelope.errors.length > 0) {
    throw new Error(`liqwid-graphql: ${envelope.errors.map(e => e.message).join('; ')}`);
  }

  const rows = envelope.data?.liqwid?.data?.markets?.results;
  if (!Array.isArray(rows)) {
    throw new Error('liqwid-graphql: unexpected response shape (missing markets.results)');
  }

  const out = new Map<string, LiqwidApyData>();
  for (const r of rows) {
    if (r.frozen || r.private || r.delisting) continue;
    out.set(r.id.toUpperCase(), {
      liqwidId:    r.id,
      supplyAPY:   r.supplyAPY,
      borrowAPY:   r.borrowAPY,
      lqSupplyAPY: r.lqSupplyAPY,
      updatedAt:   r.updatedAt,
    });
  }
  return out;
}
