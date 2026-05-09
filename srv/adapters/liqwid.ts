/**
 * Liqwid Finance v2 adapter.
 *
 * Hybrid read pattern:
 *   - On-chain (verifiable) — `bridge.getUtxosAtCredential(marketStateHash)`
 *     returns the singleton MarketState UTxO per market. Inline datum
 *     decoded via `decodeMarketStateDatum` gives supply / borrow / reserve /
 *     qTokenSupply / qTokenRate / utilization.
 *   - GraphQL (third-party) — `https://v2.api.liqwid.finance/graphql` for
 *     supplyAPY / borrowAPY / lqSupplyAPY. Liqwid v2 is closed-source so
 *     the rate-curve params on `field[6]` of MarketState are opaque to us.
 *     Tagged in rawPayload.apy.source = 'liqwid-api'.
 *
 * Pair contract:
 *   - `LIQWID-POOLS` → AttestationQuote, value = market count, unit = 'count',
 *     rawPayload.markets = per-market structured records.
 *
 * Scope: stable-asset markets only (DJED, iUSD, USDM). qADA / qBTC / etc.
 * exist on Liqwid but are out of CHAINFEED's stable-focus.
 *
 * Side-door exports `_fetchAllMarkets` for the composite health endpoint
 * (`getLiqwidHealth`) which needs the full per-market record without the
 * AttestationQuote envelope.
 */

import bridge from '../external/odatano-bridge';
import { assertIsAdapter, type AttestationQuote, type PriceAdapter } from './types';
import {
  cfg, resolveLiqwidNetwork, type LiqwidNetwork, type LiqwidMarket,
} from '../lib/liqwid-config';
import {
  decodeMarketStateDatum, totalSuppliedRaw, utilizationFraction, qTokenRate,
  type DecodedMarketState,
} from '../lib/liqwid-decoder';
import { fetchAllLiqwidApy, type LiqwidApyData } from '../lib/liqwid-graphql';
import { recordAndDerive, deriveSupplyAPY, type DerivedRates } from '../lib/liqwid-finance';

const SOURCE_NAME = 'liqwid';
const PAIR_POOLS  = 'LIQWID-POOLS';
const SUPPORTED_PAIRS = new Set([PAIR_POOLS]);

interface BridgeUtxo {
  txHash?: string;
  outputIndex?: number;
  lovelace?: string;
  inlineDatumHex?: string;
  assets?: Array<{ unit?: string; policyId?: string; assetNameHex?: string; quantity?: string }>;
}

// ── Per-market snapshot (combined on-chain + API) ────────────────────

interface MarketSnapshot {
  /** Canonical CHAINFEED ticker — DJED / iUSD / USDM. */
  symbol: LiqwidMarket['symbol'];
  /** Liqwid GraphQL id — used for cross-reference + provenance. */
  liqwidId: LiqwidMarket['liqwidId'];
  /** UTxO holding the MarketState datum. */
  txHash: string;
  outputIndex: number;
  /** Lovelace held by the MarketState UTxO. Just minADA — actual reserve sits
   *  on the SupplyBatch script (out of scope for pool-rollup). */
  marketStateLovelace: bigint;
  /** On-chain decoded state — verifiable, deterministic. */
  state: DecodedMarketState;
  /** APY data from Liqwid's GraphQL API. Null if API call failed or market is frozen/private/delisting. */
  apy: LiqwidApyData | null;
}

// ── Per-market fetch ─────────────────────────────────────────────────

async function fetchMarketState(market: LiqwidMarket): Promise<{
  txHash: string;
  outputIndex: number;
  lovelace: bigint;
  state: DecodedMarketState;
} | null> {
  const utxos = await bridge.getUtxosAtCredential(market.marketStateHash) as BridgeUtxo[];
  if (!Array.isArray(utxos) || utxos.length === 0) return null;

  // The MarketState UTxO is the one carrying an inline-datum decodable as the
  // 11-field MarketState shape. There is exactly one per market in steady
  // state — but during a settlement batch the spending tx may produce a
  // transient duplicate. We pick the first decodable hit and accept the rare
  // double-read; consumers care about magnitudes, not microsecond freshness.
  for (const u of utxos) {
    if (!u.inlineDatumHex) continue;
    const state = decodeMarketStateDatum(u.inlineDatumHex);
    if (!state) continue;
    return {
      txHash:      u.txHash ?? '',
      outputIndex: u.outputIndex ?? 0,
      lovelace:    BigInt(u.lovelace ?? '0'),
      state,
    };
  }
  return null;
}

/**
 * Fetch all in-scope (stable) markets in parallel + the APY map from GraphQL.
 * Each market's on-chain read is independent; an API failure doesn't fail the
 * whole call (per-market `apy` is null in that case).
 *
 * Returns the same shape `getLiqwidHealth` consumes directly.
 */
async function fetchAllMarkets(network: LiqwidNetwork = resolveLiqwidNetwork()): Promise<{
  markets: MarketSnapshot[];
  apySourceFailed: boolean;
}> {
  const c = cfg(network);

  // Parallel: per-market on-chain reads + the single GraphQL call.
  const onchainPromises = c.markets.map(async (m) => {
    const r = await fetchMarketState(m);
    return r ? { market: m, ...r } : null;
  });
  const apyPromise = fetchAllLiqwidApy(network).catch(() => null);

  const [onchainResults, apyMap] = await Promise.all([
    Promise.all(onchainPromises),
    apyPromise,
  ]);

  const markets: MarketSnapshot[] = [];
  for (const r of onchainResults) {
    if (!r) continue;
    markets.push({
      symbol:              r.market.symbol,
      liqwidId:            r.market.liqwidId,
      txHash:              r.txHash,
      outputIndex:         r.outputIndex,
      marketStateLovelace: r.lovelace,
      state:               r.state,
      apy: apyMap?.get(r.market.liqwidId.toUpperCase()) ?? null,
    });
  }

  return { markets, apySourceFailed: apyMap === null };
}

// ── PriceAdapter shape ───────────────────────────────────────────────

async function getPrice(pair: string): Promise<AttestationQuote> {
  if (!SUPPORTED_PAIRS.has(pair)) {
    throw new Error(`liqwid: pair '${pair}' not supported (LIQWID-POOLS only)`);
  }
  const network = resolveLiqwidNetwork();
  const r = await fetchAllMarkets(network);

  return {
    kind: 'attestation',
    sourceName: SOURCE_NAME,
    pair,
    value: r.markets.length,
    unit: 'count',
    timestamp: Date.now(),
    rawPayload: {
      network,
      marketCount: r.markets.length,
      apySourceFailed: r.apySourceFailed,
      apySource: 'liqwid-api',
      markets: r.markets.map(m => {
        // Empirical APR/APY from interestIndex deltas. First call per process
        // returns null (no baseline yet); subsequent calls ≥ 60s apart derive
        // the rate. GraphQL APY remains the canonical short-term value;
        // observedBorrowAPR is the on-chain-verifiable fallback.
        const derived: DerivedRates | null = recordAndDerive(
          m.symbol, m.state.interestIndex, m.state.lastInterestUpdateMs,
        );
        const util = utilizationFraction(m.state);
        return {
          symbol:    m.symbol,
          liqwidId:  m.liqwidId,
          txHash:    m.txHash,
          outputIndex: m.outputIndex,
          // Decimals are uniform-6 across in-scope markets — divide downstream.
          supplyRaw:           m.state.supplyRaw.toString(),
          principalRaw:        m.state.principalRaw.toString(),
          reserveRaw:          m.state.reserveRaw.toString(),
          totalSuppliedRaw:    totalSuppliedRaw(m.state).toString(),
          qTokenSupplyRaw:     m.state.qTokenSupplyRaw.toString(),
          qTokenRate:          qTokenRate(m.state),
          utilization:         util,
          lastInterestUpdateMs: m.state.lastInterestUpdateMs,
          nextBatchDeadlineMs:  m.state.nextBatchDeadlineMs,
          apy: m.apy && {
            supplyAPY:   m.apy.supplyAPY,
            borrowAPY:   m.apy.borrowAPY,
            lqSupplyAPY: m.apy.lqSupplyAPY,
            updatedAt:   m.apy.updatedAt,
          },
          observed: derived && {
            borrowAPR:       derived.borrowAPR,
            borrowAPY:       derived.borrowAPY,
            supplyAPY:       deriveSupplyAPY(derived.borrowAPY, util),
            observedDeltaMs: derived.observedDeltaMs,
            baselineAtMs:    derived.baselineAtMs,
          },
        };
      }),
    },
  };
}

function supportsPair(pair: string): boolean {
  return SUPPORTED_PAIRS.has(pair);
}

const adapter: PriceAdapter = { sourceName: SOURCE_NAME, getPrice, supportsPair };
assertIsAdapter(adapter, 'liqwid');

const exported = {
  ...adapter,
  // Side-door for getLiqwidHealth + tests:
  _fetchAllMarkets: fetchAllMarkets,
  _PAIR_POOLS: PAIR_POOLS,
};

export = exported;
