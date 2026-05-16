/**
 * `getStableHealth` orchestration — extracted from the CDS handler so it
 * can be exercised in pure-Node tests (no CAP runtime boot needed) and
 * reused by future non-HTTP callers (Sprint 3 webhook trigger, CLI, etc).
 *
 * The handler in `srv/price-service.ts` is now a thin shell that does:
 *   - input validation
 *   - symbol → StableMetadata lookup
 *   - peg-supported check
 *   - delegate to `computeStableHealth(meta, deps)` for the heavy lifting
 *
 * Dependencies (price + reserves fanouts, supply fetcher) are injected
 * so tests can stub them. Production wiring lives in the handler.
 */

import { aggregate, pegDeviationBps, type AggregatedResult } from '../aggregation';
import { computeRiskScore, type AttestationKind, type Backing } from './stable-risk-score';
import type { StableMetadata } from './stable-metadata';
import type { StableSupply } from './stable-supply';
import type { DepthResult } from './liquidity-depth';
import type { PriceQuote, AttestationQuote } from '../adapters/types';

export interface FanoutLike<Q> {
  quotes: Q[];
  errors: Array<{ source: string; error: string }>;
}

export interface StableHealthDeps {
  fanout: (pair: string) => Promise<FanoutLike<PriceQuote>>;
  attestationFanout: (pair: string) => Promise<FanoutLike<AttestationQuote>>;
  fetchSupply: (meta: Pick<StableMetadata, 'policyId' | 'assetNameHex'>) => Promise<StableSupply>;
  /**
   * Optional liquidity-depth probe. Caller decides whether to inject it —
   * for status/dashboard endpoints we want depth, for high-throughput
   * paths it's heavy (one fanout call + per-pool CP simulation) and may be skipped.
   * Pass `null` to skip; pass an async function to enable.
   */
  fetchLiquidityDepth?: (nonAdaTokenId: string) => Promise<DepthResult>;
  /** Optional logger so callers can route warnings into their telemetry. */
  log?: (level: 'warn' | 'info', msg: string) => void;
  /** Override Date.now for deterministic test snapshots. */
  now?: () => number;
}

export interface StableHealthResult {
  symbol: string;
  metadata: {
    symbol: string;
    peg: string;
    backing: string;
    issuerName: string;
    issuerJurisdiction: string | null;
    issuerCustodian: string | null;
    policyId: string;
    assetNameHex: string;
    decimals: number;
    liveSince: string;
  };
  price: {
    available: boolean;
    value: number | null;
    sourcesUsed: number | null;
    confidence: number | null;
    deviationPct: number | null;
  };
  pegDeviationBps: number | null;
  reserves: {
    available: boolean;
    source: string | null;
    value: number | null;
    unit: string | null;
    healthBucket: string | null;
    txHash: string | null;
    ageMs: number | null;
  };
  supply: {
    available: boolean;
    totalSupply: number | null;
    circulatingSupply: number | null;
  };
  liquidity: {
    available: boolean;
    midPrice: number | null;
    depthAda: number | null;
    depthAtMaxProbed: boolean | null;
    routingMonotone: boolean | null;
    targetSlippagePct: number | null;
    probedPointsCount: number | null;
  };
  risk: {
    score: number;
    pegConfidence:        { value: number; weight: number; effective: number };
    reserveAdequacy:      { value: number; weight: number; effective: number };
    attestationFreshness: { value: number; weight: number; effective: number };
    sourceConfidence:     { value: number; weight: number; effective: number };
  };
  alerts: string[];
  computedAt: string;
}

export async function computeStableHealth(
  meta: StableMetadata,
  deps: StableHealthDeps,
): Promise<StableHealthResult> {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? (() => Date.now());

  // Parallel sub-fetches. allSettled so a single failure doesn't take
  // the whole call down — we surface partial data + alerts instead.
  const reservesFetch = meta.reservesPair
    ? deps.attestationFanout(meta.reservesPair)
    : Promise.resolve(null);

  // Liquidity probe is opt-in — one fanout call + merged-pool CP math.
  // Token ID is the non-ADA-side: policyId + assetNameHex concatenated.
  const liquidityFetch = deps.fetchLiquidityDepth
    ? deps.fetchLiquidityDepth(meta.policyId + meta.assetNameHex)
    : Promise.resolve(null);

  const [pairResult, adaUsdResult, reservesResult, supplyResult, liquidityResult] = await Promise.allSettled([
    deps.fanout(meta.pegPair),
    deps.fanout('ADA-USD'),
    reservesFetch,
    deps.fetchSupply(meta),
    liquidityFetch,
  ]);

  // ── price block ────────────────────────────────────────────────────
  let priceAgg: AggregatedResult | null = null;
  if (pairResult.status === 'fulfilled' && pairResult.value.quotes.length > 0) {
    priceAgg = aggregate(pairResult.value.quotes);
  } else if (pairResult.status === 'rejected') {
    log('warn', `pair fanout failed for ${meta.pegPair}: ${(pairResult.reason as Error)?.message ?? pairResult.reason}`);
  }

  // ── peg deviation ──────────────────────────────────────────────────
  let pegDevBps: number | null = null;
  if (priceAgg !== null
      && adaUsdResult.status === 'fulfilled' && adaUsdResult.value.quotes.length > 0) {
    try {
      const usdAgg = aggregate(adaUsdResult.value.quotes);
      pegDevBps = pegDeviationBps(priceAgg.price, usdAgg.price);
    } catch (err) {
      log('warn', `pegDeviationBps compute failed for ${meta.symbol}: ${(err as Error)?.message ?? err}`);
    }
  } else if (adaUsdResult.status === 'rejected') {
    log('warn', `ADA-USD fanout failed for ${meta.symbol} peg-deviation: ${(adaUsdResult.reason as Error)?.message ?? adaUsdResult.reason}`);
  }

  // ── reserves block ─────────────────────────────────────────────────
  let reservesAvailable = false;
  let reservesSource:  string | null = null;
  let reservesValue:   number | null = null;
  let reservesUnit:    string | null = null;
  let reservesBucket:  string | null = null;
  let reservesTxHash:  string | null = null;
  let reservesAgeMs:   number | null = null;
  let reservesKind:    AttestationKind = meta.reservesPair ? 'on-chain-attestation' : 'none';

  if (reservesResult.status === 'fulfilled' && reservesResult.value !== null
      && reservesResult.value.quotes.length > 0) {
    const att = reservesResult.value.quotes[0]!;
    reservesAvailable = true;
    reservesValue     = att.value;
    reservesUnit      = att.unit;
    reservesTxHash    = att.txHash ?? null;
    reservesAgeMs     = att.timestamp ? now() - att.timestamp : null;
    // Map attestation-quote shape → riskscore-side kind enum based on unit.
    // 'ratio_pct' = DJED/iUSD coverage ratio; 'usd' = on-chain bank-balance
    // attestation (USDM); 'attestation-binary' = off-chain PDF where bytes
    // are hash-sealed but content not parsed (Circle, BitGo).
    if (att.unit === 'ratio_pct') {
      reservesKind = 'on-chain-collateral-aggregate';
    } else if (att.unit === 'attestation-binary') {
      reservesKind = 'off-chain-pdf';
    } else {
      reservesKind = 'on-chain-attestation';
    }
    reservesSource = reservesKind;
    const rp = att.rawPayload as { healthBucket?: string } | null | undefined;
    if (rp && typeof rp.healthBucket === 'string') reservesBucket = rp.healthBucket;
  } else if (reservesResult.status === 'rejected') {
    // Fanout threw — degrade to "no source available" so the reserves-source-missing
    // alert can fire (it gates on `reservesKind === 'none'`).
    reservesKind = 'none';
    log('warn', `reserves fanout failed for ${meta.reservesPair}: ${(reservesResult.reason as Error)?.message ?? reservesResult.reason}`);
  } else if (reservesResult.status === 'fulfilled' && reservesResult.value !== null
      && reservesResult.value.quotes.length === 0) {
    // Fanout succeeded but no source returned a quote — same effective state
    // as "none". Without this reset, reservesKind stays at the optimistic
    // 'on-chain-attestation' default and the alert never fires.
    reservesKind = 'none';
    log('warn', `reserves fanout returned 0 quotes for ${meta.reservesPair}`);
  }

  // ── supply block ───────────────────────────────────────────────────
  let supplyTotal: number | null = null;
  let supplyCirc:  number | null = null;
  if (supplyResult.status === 'fulfilled') {
    supplyTotal = supplyResult.value.totalSupply;
    supplyCirc  = supplyResult.value.circulatingSupply;
  } else if (supplyResult.status === 'rejected') {
    log('warn', `supply fetch failed for ${meta.symbol}: ${(supplyResult.reason as Error)?.message ?? supplyResult.reason}`);
  }

  // For USD-peg fiat-custodial reserves, USD-value of supply == circulating
  // (the peg is exactly $1). For overcollateralized stables the ratio
  // already encodes coverage, so we don't pass supply.
  const circulatingSupplyUsd: number | null =
    (meta.backing === 'fiat-custodial' && meta.peg === 'USD' && supplyCirc !== null)
      ? supplyCirc
      : null;

  // ── risk score + alerts ────────────────────────────────────────────
  const risk = computeRiskScore({
    backing:               meta.backing as Backing,
    pegDeviationBps:       pegDevBps,
    priceSourceConfidence: priceAgg?.confidence ?? null,
    priceSourcesUsed:      priceAgg?.sourcesUsed ?? 0,
    reservesKind,
    reservesValue,
    circulatingSupplyUsd,
    attestationAgeMs:      reservesAgeMs,
  });

  return {
    symbol: meta.symbol,
    metadata: {
      symbol:             meta.symbol,
      peg:                meta.peg,
      backing:            meta.backing,
      issuerName:         meta.issuer.name,
      issuerJurisdiction: meta.issuer.jurisdiction ?? null,
      issuerCustodian:    meta.issuer.custodian ?? null,
      policyId:           meta.policyId,
      assetNameHex:       meta.assetNameHex,
      decimals:           meta.decimals,
      liveSince:          meta.liveSince,
    },
    price: {
      available:    priceAgg !== null,
      value:        priceAgg?.price ?? null,
      sourcesUsed:  priceAgg?.sourcesUsed ?? null,
      confidence:   priceAgg?.confidence ?? null,
      deviationPct: priceAgg?.deviationPct ?? null,
    },
    pegDeviationBps: pegDevBps,
    reserves: {
      available:    reservesAvailable,
      source:       reservesSource,
      value:        reservesValue,
      unit:         reservesUnit,
      healthBucket: reservesBucket,
      txHash:       reservesTxHash,
      ageMs:        reservesAgeMs,
    },
    supply: {
      available:         supplyTotal !== null || supplyCirc !== null,
      totalSupply:       supplyTotal,
      circulatingSupply: supplyCirc,
    },
    liquidity: (() => {
      if (liquidityResult.status === 'fulfilled' && liquidityResult.value !== null) {
        const d = liquidityResult.value;
        return {
          available:         d.midPrice !== null,
          midPrice:          d.midPrice,
          depthAda:          d.depthAda,
          depthAtMaxProbed:  d.depthAtMaxProbed,
          routingMonotone:   d.routingMonotone,
          targetSlippagePct: d.targetSlippagePct,
          probedPointsCount: d.probedPoints.length,
        };
      }
      if (liquidityResult.status === 'rejected') {
        log('warn', `liquidity probe failed for ${meta.pegPair}: ${(liquidityResult.reason as Error)?.message ?? liquidityResult.reason}`);
      }
      return {
        available:         false,
        midPrice:          null,
        depthAda:          null,
        depthAtMaxProbed:  null,
        routingMonotone:   null,
        targetSlippagePct: null,
        probedPointsCount: null,
      };
    })(),
    risk: {
      score:                risk.score,
      pegConfidence:        risk.components.pegConfidence,
      reserveAdequacy:      risk.components.reserveAdequacy,
      attestationFreshness: risk.components.attestationFreshness,
      sourceConfidence:     risk.components.sourceConfidence,
    },
    alerts:     risk.alerts,
    computedAt: new Date(now()).toISOString(),
  };
}
