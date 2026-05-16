/**
 * PriceService implementation.
 *
 * Pipeline per `getBestPrice`:
 *   1. Validate the requested pair against the registered sources.
 *   2. Fan out to every supporting source (cached, with stale-while-revalidate).
 *   3. Run the aggregation engine over the surviving quotes.
 *   4. Persist an `AggregatedPrices` row + audit `PriceSources` (Phase 2.8 TWAP).
 *   5. Return the canonical `AggregatedPriceResult` shape.
 *
 * Multi-source by default. If the fanout collapses to a single survivor
 * (e.g. Charli3-only pairs like NIGHT-ADA), the aggregator caps the
 * reported confidence at `SINGLE_SOURCE_CONFIDENCE_CAP` so consumers can
 * tell a degraded response apart from a verified one. New adapters slot in
 * via `srv/adapters/registry.ts`; this handler does not change.
 *
 * x402 payment gating is wired in `init()` below via `@odatano/x402`'s
 * `gateService(this, …)`. The gate verifies payment before a gated
 * handler runs and stashes the claim on `req.payment`; handlers trust it
 * if set but do not require it (CAP-internal calls bypass the gating).
 */

import cds from '@sap/cds';
import { fanout, sourcesForPair, fanoutDexOnly, dexSourcesForPair, attestationFanout, getRegistryStatus } from './adapters/registry';
import { aggregate, pegDeviationBps, twap, type AggregatedResult } from './aggregation';
import { metadataForPair, metadataForSymbol, STABLE_METADATA } from './lib/stable-metadata';
import { computeConvergenceMatrix } from './lib/stable-convergence';
import {
  gateService,
  buildPaymentRequirements,
  flatRequirements,
  buildUnsignedPaymentTx,
  verifyConfirmedPayment,
} from '@odatano/x402';
import { resolveX402Config } from './x402-config';
import { GATED_ROUTE_PRICING, priceUnitsForAction, resourcePathForAction } from './x402-routes';
import { fetchStableSupply } from './lib/stable-supply';
import { executableDepthForToken } from './lib/liquidity-depth';
import { computeStableHealth } from './lib/stable-health';
import { computeFluidHealth } from './lib/fluidtokens-health';
import fluidtokens from './adapters/fluidtokens';
import { resolveFluidNetwork } from './lib/fluidtokens-config';
import liqwid from './adapters/liqwid';
import { resolveLiqwidNetwork } from './lib/liqwid-config';
import { totalSuppliedRaw, utilizationFraction, qTokenRate } from './lib/liqwid-decoder';
import { recordAndDerive, deriveSupplyAPY } from './lib/liqwid-finance';
import {
  bucketSamples, intervalToMs, maxLookbackMsForInterval, isValidInterval,
  type Interval as OhlcvInterval,
} from './lib/ohlcv';
import { buildAuditPack, type AuditPackQuote, type AuditPackSource } from './lib/audit-pack';
import { generateHmacSecret, validateWebhookUrl } from './lib/alert-detector';
import { encryptSecret } from './lib/secret-crypto';
import { priceForSubscription, USDM_DECIMALS } from './lib/peg-pricing';
import type { PriceQuote } from './adapters/types';

const log = cds.log('price-service');

const AGGREGATED_PRICES   = 'chainfeed.AggregatedPrices';
const PRICE_SOURCES       = 'chainfeed.PriceSources';
const ALERT_SUBSCRIPTIONS = 'chainfeed.AlertSubscriptions';

const SUBSCRIPTION_MIN_THRESHOLD_BPS = 10;       // ≥ 0.10 %
const SUBSCRIPTION_MAX_THRESHOLD_BPS = 10_000;   // ≤ 100 %
const SUBSCRIPTION_MIN_VALID_HOURS   = 1;
const SUBSCRIPTION_MAX_VALID_HOURS   = 24 * 365; // 1 year

/**
 * Persist the aggregated result + per-source audit rows. Best-effort:
 * failures here log a warning but do not fail the response — the canonical
 * record of payment + service is the on-chain tx and the FeedReads row.
 *
 * Returns the AggregatedPrices.ID for cross-reference; callers may stash it
 * on the response if useful (currently we don't surface it on the wire).
 */
async function persistResult(
  pair: string,
  agg: AggregatedResult,
  quotes: PriceQuote[],
  pegDevBps: number | null,
): Promise<string | null> {
  try {
    const validFromMs = quotes.reduce((m, q) => Math.min(m, q.timestamp ?? Date.now()), Date.now());
    const validUntilMs = quotes.reduce(
      (m, q) => Math.max(m, q.validUntil ?? q.timestamp ?? Date.now()),
      0,
    );

    const row = await cds.run(
      INSERT.into(AGGREGATED_PRICES).entries({
        pair,
        price:           agg.price,
        sourcesUsed:     agg.sourcesUsed,
        confidence:      agg.confidence,
        deviationPct:    agg.deviationPct,
        pegDeviationBps: pegDevBps,
        validFrom:       new Date(validFromMs).toISOString(),
        validUntil:      new Date(validUntilMs || Date.now()).toISOString(),
      }),
    );
    // CAP returns the inserted entity (or its ID) depending on driver; the
    // `INSERT.into.entries` style yields the inserted row's keys via cds.run.
    const aggregatedId: string | undefined = Array.isArray(row)
      ? (row[0] as { ID?: string })?.ID
      : (row as { ID?: string })?.ID;

    if (aggregatedId) {
      await cds.run(
        INSERT.into(PRICE_SOURCES).entries(
          quotes.map(q => ({
            aggregated_ID: aggregatedId,
            sourceName:    q.sourceName,
            price:         q.price,
            txHash:        q.txHash ?? '',
            fetchedAt:     new Date(q.timestamp ?? Date.now()).toISOString(),
            rawPayload:    JSON.stringify(q.rawPayload ?? null),
          })),
        ),
      );
    }
    return aggregatedId ?? null;
  } catch (err) {
    log.warn(`persist failed for ${pair} (non-fatal):`, (err as Error)?.message ?? err);
    return null;
  }
}

export = cds.service.impl(async function () {

  // ── x402 payment gating ────────────────────────────────────────────
  // `@odatano/x402`'s CAP gate registers a `before('*')` handler that
  // 402s any event listed in GATED_ROUTE_PRICING until a valid
  // PAYMENT-SIGNATURE is presented. Unmapped events (the free
  // public-dashboard surface, plus subscribePegAlert / buildPaymentTx
  // which do their own x402 handling) pass through untouched.
  //
  // When x402 env is unset (dev mode) we skip the gate entirely — the
  // service still serves every route for free.
  const x402 = resolveX402Config();
  if (x402.enabled) {
    gateService(this, {
      payTo:        x402.payTo,
      network:      x402.network,
      asset:        x402.asset,
      routePricing: { ...GATED_ROUTE_PRICING },
      description:  'CHAINFEED aggregated oracle price (mock-USDM on preprod)',
      // Audit trail — best-effort, never blocks serving the response.
      onAccepted: async (claim, req) => {
        try {
          await cds.run(
            INSERT.into('chainfeed.FeedReads').entries({
              feedKind:        'aggregated',
              feedRef:         String(claim.resourceUrl ?? req.event ?? '').slice(0, 100),
              consumerWallet:  String(claim.payerAddr ?? ''),
              amountPaidUSDM:  Number(claim.amountUnits) / 10 ** x402.usdmDecimals,
              paymentTxHash:   claim.txHash,
              servedAt:        new Date().toISOString(),
              responsePayload: '',
            }),
          );
        } catch (err) {
          log.warn('FeedReads insert failed (non-fatal):', (err as Error)?.message ?? err);
        }
      },
    });
    log.info(`x402 gate active on PriceService (network=${x402.network}, payTo=${x402.payTo.slice(0, 16)}…)`);
  } else {
    log.warn('x402 disabled: set X402_PAY_TO + X402_USDM_POLICY to enable payment gating.');
  }

  this.on('getArbitrageOpportunities', async (req) => {
    const pair = (req.data as { pair?: string })?.pair;
    if (!pair) return req.error(400, 'pair is required');

    const venues = dexSourcesForPair(pair);
    if (venues.length < 2) {
      return req.error(400, `arbitrage needs ≥ 2 DEX venues for '${pair}', have ${venues.length}`);
    }

    const { quotes, errors } = await fanoutDexOnly(pair);
    if (quotes.length < 2) {
      const detail = errors.map(e => `${e.source}: ${e.error}`).join('; ');
      log.warn(`getArbitrageOpportunities('${pair}') only got ${quotes.length} quotes (${detail})`);
      return req.error(502, `not enough live DEX quotes for ${pair} (got ${quotes.length}, need ≥ 2)`);
    }

    const sorted = [...quotes].sort((a, b) => a.price - b.price);
    const cheapest = sorted[0]!;
    const dearest  = sorted[sorted.length - 1]!;
    const spreadPct = ((dearest.price - cheapest.price) / cheapest.price) * 100;

    return {
      pair,
      bestBuy:    { source: cheapest.sourceName, price: cheapest.price },
      bestSell:   { source: dearest.sourceName,  price: dearest.price  },
      spreadPct,
      profitable: spreadPct > 0.5,   // arbitrary threshold; revisit per pair
      venues:     sorted.map(q => ({ source: q.sourceName, price: q.price })),
    };
  });

  this.on('getServiceStatus', async () => {
    return {
      serviceUrl:  process.env.CHAINFEED_PUBLIC_URL ?? 'unknown',
      generatedAt: new Date().toISOString(),
      adapters:    getRegistryStatus().map(s => ({
        sourceName:      s.sourceName,
        ttlMs:           s.ttlMs,
        cachedPairCount: s.cachedPairCount,
        pairs:           s.pairs.map(p => ({
          pair:               p.pair,
          fetchedAtIso:       p.fetchedAtIso,
          ageSeconds:         p.ageSeconds,
          hasInflightRefresh: p.hasInflightRefresh,
          lastErrorMessage:   p.lastError?.message ?? null,
          lastErrorAtIso:     p.lastError?.at ?? null,
        })),
      })),
    };
  });

  this.on('subscribePegAlert', async (req) => {
    const data = req.data as {
      pair?: string; thresholdBps?: number | string; webhookUrl?: string;
      ownerAddr?: string; validUntilHours?: number | string; paymentTxHash?: string;
    };

    // Input validation — fail fast with 400s for bad shapes.
    const pair = data?.pair;
    if (!pair) return req.error(400, 'pair is required');
    const meta = metadataForPair(pair);
    if (!meta) return req.error(400, `pair '${pair}' is not a registered stable pair (peg-break alerts only meaningful for stables)`);
    if (meta.peg !== 'USD') return req.error(501, `peg ${meta.peg} alerts not yet supported`);

    const thresholdBps = Number(data?.thresholdBps);
    if (!Number.isFinite(thresholdBps) || thresholdBps < SUBSCRIPTION_MIN_THRESHOLD_BPS || thresholdBps > SUBSCRIPTION_MAX_THRESHOLD_BPS) {
      return req.error(400, `thresholdBps must be ${SUBSCRIPTION_MIN_THRESHOLD_BPS}–${SUBSCRIPTION_MAX_THRESHOLD_BPS}`);
    }

    let webhookUrl: string;
    try { webhookUrl = validateWebhookUrl(String(data?.webhookUrl ?? '')); }
    catch (e) { return req.error(400, `webhookUrl: ${(e as Error).message}`); }

    const ownerAddr = String(data?.ownerAddr ?? '').trim();
    if (!ownerAddr) return req.error(400, 'ownerAddr is required (Cardano address of the subscriber)');

    const validUntilHours = Number(data?.validUntilHours);
    if (!Number.isFinite(validUntilHours) || validUntilHours < SUBSCRIPTION_MIN_VALID_HOURS || validUntilHours > SUBSCRIPTION_MAX_VALID_HOURS) {
      return req.error(400, `validUntilHours must be ${SUBSCRIPTION_MIN_VALID_HOURS}–${SUBSCRIPTION_MAX_VALID_HOURS}`);
    }

    // ── x402 payment enforcement ───────────────────────────────────
    // When x402 is configured, the buyer must present a paymentTxHash
    // that's already confirmed on-chain and pays ≥ priceForSubscription()
    // to our wallet. `@odatano/x402`'s v2 verifyConfirmedPayment does NOT
    // claim a nonce — replay defence for this confirmed-payment flow is
    // CHAINFEED's job. We enforce it with a uniqueness check on
    // AlertSubscriptions.paymentTxHash (backed by @assert.unique in
    // db/schema.cds; the explicit pre-check below gives a clean 402).
    const x402 = resolveX402Config();
    const paymentTxHash = String(data?.paymentTxHash ?? '').trim();

    let priceUnits: bigint = 0n;
    if (x402.enabled) {
      try {
        priceUnits = priceForSubscription(thresholdBps, validUntilHours);
      } catch (err) {
        return req.error(400, `pricing failed: ${(err as Error).message}`);
      }
      if (!paymentTxHash) {
        const usdmCost = Number(priceUnits) / 10 ** USDM_DECIMALS;
        return req.error(402, `payment required: ${usdmCost.toFixed(6)} USDM (${priceUnits} raw units). Submit a tx paying that amount to ${x402.payTo} of asset ${x402.asset}, then call subscribePegAlert with paymentTxHash=<your-tx-hash>.`);
      }
      // Replay defence: this tx must not already back another subscription.
      const existing = await cds.run(
        SELECT.one.from(ALERT_SUBSCRIPTIONS).columns('ID').where({ paymentTxHash }),
      );
      if (existing) {
        return req.error(402, `x402: replay_detected — payment tx ${paymentTxHash} has already been redeemed for subscription ${(existing as { ID?: string }).ID}`);
      }
      const verification = await verifyConfirmedPayment({
        txHash:         paymentTxHash,
        requiredAmount: priceUnits.toString(),
        asset:          x402.asset,
        payTo:          x402.payTo,
        network:        x402.network,
      });
      if (!verification.ok) {
        return req.error(402, `x402: ${verification.code} — ${verification.reason}`);
      }
      log.info(`subscribePegAlert: x402 verified — paid=${verification.amountUnits} required=${priceUnits} pair=${pair} owner=${ownerAddr}`);
    } else {
      log.warn('subscribePegAlert: x402 disabled (set X402_PAY_TO + X402_USDM_POLICY to enable). Subscription created without payment.');
    }

    const hmacSecretHex = generateHmacSecret();
    // Encrypt at rest. Returns the plaintext unchanged in dev (no KEK
    // configured); production boot is gated by `assertEncryptionConfigured`
    // in server.ts so we never reach this line without a key in prod.
    const storedSecret = encryptSecret(hmacSecretHex);
    const validUntilMs = Date.now() + validUntilHours * 60 * 60 * 1000;

    let inserted: unknown;
    try {
      inserted = await cds.run(
        INSERT.into(ALERT_SUBSCRIPTIONS).entries({
          ownerAddr,
          pair,
          thresholdBps,
          webhookUrl,
          hmacSecretHex: storedSecret,
          validUntil:    new Date(validUntilMs).toISOString(),
          status:        'active',
          fireCount:     0,
          paymentTxHash: paymentTxHash || null,
        }),
      );
    } catch (err) {
      // @assert.unique on paymentTxHash — a replay race the pre-check missed.
      const msg = (err as Error)?.message ?? String(err);
      if (paymentTxHash && /unique/i.test(msg)) {
        return req.error(402, `x402: replay_detected — payment tx ${paymentTxHash} has already been redeemed for a subscription`);
      }
      throw err;
    }
    const subscriptionId: string | undefined = Array.isArray(inserted)
      ? (inserted[0] as { ID?: string })?.ID
      : (inserted as { ID?: string })?.ID;
    if (!subscriptionId) {
      log.error(`subscribePegAlert: INSERT did not return ID for pair=${pair} owner=${ownerAddr}`);
      return req.error(500, 'subscription persist failed');
    }

    return {
      subscriptionId,
      // Plaintext secret — returned ONCE; consumer must persist immediately.
      // Storage is encrypted; this response is the only place the cleartext
      // is visible after the call.
      hmacSecretHex,
      pair,
      thresholdBps,
      webhookUrl,
      validUntil:    new Date(validUntilMs).toISOString(),
    };
  });

  this.on('listSubscriptions', async (req) => {
    const ownerAddr = String((req.data as { ownerAddr?: string })?.ownerAddr ?? '').trim();
    if (!ownerAddr) return req.error(400, 'ownerAddr is required');

    const rows = await cds.run(
      SELECT.from(ALERT_SUBSCRIPTIONS)
        .columns('ID', 'pair', 'thresholdBps', 'webhookUrl', 'validUntil',
                 'status', 'lastFiredAt', 'fireCount', 'createdAt')
        .where({ ownerAddr }),
    ) as Array<Record<string, unknown>>;

    return rows ?? [];
  });

  this.on('cancelSubscription', async (req) => {
    const data = req.data as { subscriptionId?: string; ownerAddr?: string };
    const subscriptionId = String(data?.subscriptionId ?? '').trim();
    const ownerAddr      = String(data?.ownerAddr ?? '').trim();
    if (!subscriptionId) return req.error(400, 'subscriptionId is required');
    if (!ownerAddr)      return req.error(400, 'ownerAddr is required');

    // Ownership check first — return 404 to avoid leaking existence.
    const existing = await cds.run(
      SELECT.from(ALERT_SUBSCRIPTIONS)
        .columns('ID', 'ownerAddr', 'status')
        .where({ ID: subscriptionId }),
    ) as Array<{ ID: string; ownerAddr: string; status: string }>;
    if (!existing || existing.length === 0 || existing[0]!.ownerAddr !== ownerAddr) {
      return req.error(404, 'subscription not found');
    }
    if (existing[0]!.status !== 'active') {
      // Idempotent: already cancelled / expired — treat as success so the
      // caller doesn't infer "subscription exists but in some other state"
      // from a `false` return (information leak).
      return true;
    }

    await cds.run(
      UPDATE(ALERT_SUBSCRIPTIONS)
        .set({ status: 'cancelled' })
        .where({ ID: subscriptionId }),
    );
    return true;
  });

  this.on('getAuditPack', async (req) => {
    const quoteId = (req.data as { quoteId?: string })?.quoteId;
    if (!quoteId) return req.error(400, 'quoteId is required');

    // 1. Fetch the AggregatedPrices row.
    const quoteRows = await cds.run(
      SELECT.from(AGGREGATED_PRICES)
        .columns('ID', 'pair', 'price', 'sourcesUsed', 'confidence',
                 'deviationPct', 'pegDeviationBps', 'validFrom', 'validUntil', 'createdAt')
        .where({ ID: quoteId }),
    ) as Array<AuditPackQuote>;
    if (!quoteRows || quoteRows.length === 0) {
      return req.error(404, `quoteId '${quoteId}' not found`);
    }
    const quote = quoteRows[0]!;

    // 2. Fetch the per-source rows.
    const sourceRows = await cds.run(
      SELECT.from(PRICE_SOURCES)
        .columns('ID', 'sourceName', 'price', 'txHash', 'fetchedAt', 'rawPayload')
        .where({ aggregated_ID: quoteId }),
    ) as Array<AuditPackSource>;

    // 3. Build the envelope. Pure-fn — heavy lifting in srv/lib/audit-pack.ts.
    const envelope = buildAuditPack(quote, sourceRows ?? [], {
      serviceUrl:  process.env.CHAINFEED_PUBLIC_URL ?? 'unknown',
      generatedAt: new Date().toISOString(),
    });

    // Return as a JSON string. Pretty-printed for human inspection — the
    // pack is meant to be human-eyeballable. sha256 checksums of file
    // BODIES are stable regardless of envelope-level whitespace; verifier
    // hashes the body strings, not the surrounding JSON.
    return JSON.stringify(envelope, null, 2);
  });

  this.on('getOhlcv', async (req) => {
    const data = req.data as { pair?: string; interval?: string; lookbackHours?: number | string };
    const pair = data?.pair;
    const interval = data?.interval;
    const lookbackHoursRaw = Number(data?.lookbackHours);

    if (!pair) return req.error(400, 'pair is required');
    if (!interval || !isValidInterval(interval)) {
      return req.error(400, "interval must be one of '1m', '5m', '15m', '1h', '4h', '1d'");
    }
    if (!Number.isFinite(lookbackHoursRaw) || lookbackHoursRaw <= 0) {
      return req.error(400, 'lookbackHours must be a positive number');
    }

    const intervalMs = intervalToMs(interval as OhlcvInterval);
    const maxLookbackMs = maxLookbackMsForInterval(interval as OhlcvInterval);
    const requestedMs = lookbackHoursRaw * 60 * 60 * 1000;
    // Clamp lookback to the per-interval cap (protects DB; documented in CDS).
    const lookbackMs = Math.min(requestedMs, maxLookbackMs);
    const windowEnd   = Date.now();
    const windowStart = windowEnd - lookbackMs;

    const rows = await cds.run(
      SELECT.from(AGGREGATED_PRICES)
        .columns('createdAt', 'price')
        .where({ pair, createdAt: { '>=': new Date(windowStart).toISOString() } }),
    ) as Array<{ createdAt: string; price: number | string }>;

    const samples = rows.map(r => ({
      ts:    new Date(r.createdAt).getTime(),
      price: Number(r.price),
    }));

    const candles = bucketSamples(samples, windowStart, windowEnd, intervalMs);

    return {
      pair,
      interval,
      windowStart:   new Date(windowStart).toISOString(),
      windowEnd:     new Date(windowEnd).toISOString(),
      candles:       candles.map(c => ({
        ts:          new Date(c.ts).toISOString(),
        open:        c.open,
        high:        c.high,
        low:         c.low,
        close:       c.close,
        sampleCount: c.sampleCount,
      })),
      lookbackHours: lookbackMs / (60 * 60 * 1000),  // echo back post-clamp
    };
  });

  this.on('getTWAP', async (req) => {
    const data = req.data as { pair?: string; windowMinutes?: number | string };
    const pair = data?.pair;
    const windowMinutes = Number(data?.windowMinutes);
    if (!pair) return req.error(400, 'pair is required');
    if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) {
      return req.error(400, 'windowMinutes must be a positive number');
    }
    if (windowMinutes > 24 * 60) {
      return req.error(400, 'windowMinutes capped at 1440 (24 hours)');
    }

    const windowEnd   = Date.now();
    const windowStart = windowEnd - windowMinutes * 60_000;

    const rows = await cds.run(
      SELECT.from(AGGREGATED_PRICES)
        .columns('createdAt', 'price')
        .where({ pair, createdAt: { '>=': new Date(windowStart).toISOString() } }),
    ) as Array<{ createdAt: string; price: number | string }>;

    const samples = rows.map(r => ({
      ts:    new Date(r.createdAt).getTime(),
      price: Number(r.price),
    }));

    const result = twap(samples, windowStart, windowEnd);

    return {
      pair,
      windowMinutes,
      twap:        result.twap ?? 0,
      samples:     result.count,
      windowStart: new Date(windowStart).toISOString(),
      windowEnd:   new Date(windowEnd).toISOString(),
    };
  });

  this.on('getStableHealth', async (req) => {
    const symbol = (req.data as { symbol?: string })?.symbol;
    if (!symbol) return req.error(400, 'symbol is required');

    const meta = metadataForSymbol(symbol);
    if (!meta) return req.error(400, `symbol '${symbol}' is not a registered stable (see STABLE_METADATA)`);

    // Sprint 2 supports only USD-pegged stables. EUR/XAU pivot in when their
    // reference fanouts are available (see roadmap).
    if (meta.peg !== 'USD') {
      return req.error(501, `peg ${meta.peg} not yet supported by getStableHealth — USD only in Sprint 2`);
    }

    // Pure orchestration lives in srv/lib/stable-health.ts so it can be
    // exercised in tests without booting CDS, and reused by future
    // non-HTTP callers (Sprint 3 webhook trigger, CLI, etc).
    return computeStableHealth(meta, {
      fanout,
      attestationFanout,
      fetchSupply: fetchStableSupply,
      // Liquidity probe runs in parallel with the other sub-fetches. It
      // calls the price-registry fanout once and simulates a merged-pool
      // constant-product swap at each notional — much lighter than the
      // pre-2026-05-03 DexHunter-routed implementation. Promise.allSettled
      // in the orchestrator still degrades the liquidity block to nulls
      // gracefully if every adapter fails.
      fetchLiquidityDepth: (tokenId) => executableDepthForToken(tokenId),
      log: (level, msg) => log[level]?.(`getStableHealth(${symbol}): ${msg}`),
    });
  });

  this.on('getStableConvergence', async () => {
    // Snapshot ADA-X for every USD-pegged stable in the registry. Run all
    // fanouts in parallel — each adapter's withCache layer ensures we don't
    // hammer upstream venues even if every page in the dashboard refreshes
    // simultaneously.
    const usdStables = Object.values(STABLE_METADATA).filter(m => m.peg === 'USD');

    const snapshots = await Promise.all(
      usdStables.map(async (meta) => {
        try {
          const { quotes } = await fanout(meta.pegPair);
          if (quotes.length === 0) return null;
          const agg = aggregate(quotes);
          return { symbol: meta.symbol, adaPrice: agg.price };
        } catch (err) {
          log.warn?.(`getStableConvergence: ${meta.pegPair} fanout failed: ${(err as Error)?.message ?? err}`);
          return null;
        }
      }),
    );

    const adaPrices: Record<string, number> = {};
    const adaPricesArr: Array<{ symbol: string; adaPrice: number }> = [];
    for (const s of snapshots) {
      if (!s) continue;
      adaPrices[s.symbol] = s.adaPrice;
      adaPricesArr.push({ symbol: s.symbol, adaPrice: s.adaPrice });
    }

    const matrix = computeConvergenceMatrix({ adaPrices });

    // Flatten the NxN matrix into a list of directed cross-rates for CDS.
    const rates: Array<{
      fromSymbol: string;
      toSymbol: string;
      impliedRate: number;
      deviationPct: number;
    }> = [];
    for (const A of matrix.symbols) {
      const row = matrix.matrix[A];
      if (!row) continue;
      for (const B of matrix.symbols) {
        if (A === B) continue;
        const entry = row[B];
        if (!entry) continue;
        rates.push({
          fromSymbol:   A,
          toSymbol:     B,
          impliedRate:  entry.impliedRate,
          deviationPct: entry.deviationPct,
        });
      }
    }

    return {
      symbols:          matrix.symbols,
      rates,
      convergenceScore: matrix.convergenceScore,
      maxDeviationPct:  matrix.maxDeviationPct,
      outliers:         matrix.outliers,
      adaPrices:        adaPricesArr,
      computedAt:       new Date().toISOString(),
    };
  });

  this.on('buildPaymentTx', async (req) => {
    const data = req.data as { buyerAddrBech32?: string; gatedAction?: string };
    const buyer = data?.buyerAddrBech32?.trim();
    const action = data?.gatedAction?.trim();
    if (!buyer)  return req.error(400, 'buyerAddrBech32 is required');
    if (!action) return req.error(400, 'gatedAction is required');

    const x402 = resolveX402Config();
    if (!x402.enabled) {
      return req.error(503, 'x402 not configured (set X402_PAY_TO + X402_USDM_POLICY)');
    }

    let priceUnits: string;
    try {
      priceUnits = priceUnitsForAction(action);
    } catch (err) {
      return req.error(400, (err as Error).message);
    }

    // Build the same v2 requirements entry the x402 gate will emit on a
    // 402 — the buyer's signed tx must satisfy this exact shape.
    let requirements;
    try {
      const requirementsBody = buildPaymentRequirements({
        amount:  priceUnits,
        asset:   x402.asset,
        payTo:   x402.payTo,
        network: x402.network,
        resource: {
          url:         resourcePathForAction(action),
          description: `Browser-buyer payment for ${action}`,
          mimeType:    'application/json',
        },
      });
      requirements = flatRequirements(requirementsBody);
    } catch (err) {
      return req.error(503, `x402 misconfigured: ${(err as Error).message}`);
    }

    let unsigned;
    try {
      unsigned = await buildUnsignedPaymentTx({ buyerBech32: buyer, requirements });
    } catch (err) {
      return req.error(400, (err as Error).message);
    }

    return {
      unsignedTxCborHex: unsigned.unsignedTxCborHex,
      txHashHex:         unsigned.txHashHex,
      requiredSignerHex: unsigned.requiredSignerHex,
      // v2 UTxO-ref nonce — the browser puts this in payload.nonce.
      nonceRef:          unsigned.nonceRef,
      ttlSlot:           unsigned.ttlSlot,
      requirements: {
        scheme:      requirements.scheme,
        network:     requirements.network,
        amount:      requirements.amount,
        asset:       requirements.asset,
        payTo:       requirements.payTo,
        resource:    requirements.resource.url,
        description: requirements.resource.description,
      },
      inputs: unsigned.inputs,
    };
  });

  this.on('getBestPrice', async (req) => {
    const pair = (req.data as { pair?: string })?.pair;
    if (!pair) return req.error(400, 'pair is required');

    const candidates = sourcesForPair(pair);
    if (candidates.length === 0) {
      return req.error(400, `pair '${pair}' is not supported by any configured source`);
    }

    const { quotes, errors } = await fanout(pair);
    if (quotes.length === 0) {
      const detail = errors.map(e => `${e.source}: ${e.error}`).join('; ') || 'no sources returned a quote';
      log.warn(`getBestPrice('${pair}') failed: ${detail}`);
      return req.error(502, `no oracle source returned a quote for ${pair} (${detail})`);
    }

    const agg = aggregate(quotes);

    // Peg-deviation: only meaningful for ADA-X pairs where X is a registered
    // USD-pegged stable. We do an internal `fanout('ADA-USD')` to get the
    // reference scale; both fanouts go through the cache layer so the cost
    // is dominated by the user's pair fetch, not duplicated chain reads.
    let pegDevBps: number | null = null;
    const meta = metadataForPair(pair);
    if (meta && meta.peg === 'USD') {
      try {
        const usdResult = await fanout('ADA-USD');
        if (usdResult.quotes.length > 0) {
          const usdAgg = aggregate(usdResult.quotes);
          pegDevBps = pegDeviationBps(agg.price, usdAgg.price);
        } else {
          log.warn(`pegDeviationBps for ${pair}: ADA-USD fanout returned no quotes`);
        }
      } catch (err) {
        // Don't fail the user's request if the peg-reference fetch breaks.
        log.warn(`pegDeviationBps for ${pair}: ${(err as Error)?.message ?? err}`);
      }
    }

    await persistResult(pair, agg, quotes, pegDevBps);

    return {
      pair,
      price:           agg.price,
      confidence:      agg.confidence,
      sourcesUsed:     agg.sourcesUsed,
      deviationPct:    agg.deviationPct,
      pegDeviationBps: pegDevBps,
      validUntil:      new Date(
        quotes.reduce((m, q) => Math.max(m, q.validUntil ?? q.timestamp ?? Date.now()), 0) || Date.now(),
      ).toISOString(),
      auditTxHashes:   quotes.map(q => q.txHash).filter(Boolean),
    };
  });

  // ── FluidTokens v3 lending ──────────────────────────────────────────
  // Thin handlers — delegate to the adapter's side-door fetchers
  // (`_fetchAllPools` / `_fetchAllLoans`) and shape into the CDS view types.
  // The composite endpoint reuses both via `computeFluidHealth`.

  this.on('getFluidtokensPools', async (req) => {
    const filterAsset = (req.data as { asset?: string | null })?.asset;
    let network: string;
    try { network = resolveFluidNetwork(); }
    catch (err) { return req.error(503, (err as Error).message); }

    const r = await fluidtokens._fetchAllPools();
    const pools = r.pools
      .filter(p => {
        if (!filterAsset) return true;
        const key = p.datum.commonData.principalAsset.policyId === ''
          ? 'ADA' : (p.datum.commonData.principalAsset.policyId + p.datum.commonData.principalAsset.assetNameHex).toLowerCase();
        return key === filterAsset.toLowerCase();
      })
      .map(p => {
        const lm = p.datum.commonData.liquidationMode;
        const rm = p.datum.commonData.repaymentMode;
        return {
          poolIdHex:             p.poolIdHex,
          txHash:                p.txHash,
          outputIndex:           p.outputIndex,
          lovelace:              p.lovelace.toString(),
          availablePrincipalRaw: p.availablePrincipalRaw.toString(),
          principalAsset:        p.datum.commonData.principalAsset,
          interestRate:          p.datum.commonData.interestRate,
          repaymentModeKind:     rm.kind,
          apyIncreaseLinearCoefficient: rm.kind === 'perpetual' ? rm.apyIncreaseLinearCoefficient : null,
          liquidationModeKind:   lm.kind,
          liquidationLtv:        lm.kind === 'liquidation' ? lm.ltv : null,
          liquidationPenaltyPerMille: lm.kind === 'liquidation' ? lm.penaltyPerMille : null,
          installmentPeriod:     p.datum.commonData.installmentPeriod,
          totalInstallments:     p.datum.commonData.totalInstallments,
          isPermissioned:        p.datum.isPermissioned,
          collateralOptions:     p.datum.collateralOptions.map(c => c.asset),
        };
      });
    return {
      network,
      poolCount:  pools.length,
      pools,
      computedAt: new Date().toISOString(),
    };
  });

  this.on('getFluidtokensLoans', async (req) => {
    const filterAsset = (req.data as { asset?: string | null })?.asset;
    let network: string;
    try { network = resolveFluidNetwork(); }
    catch (err) { return req.error(503, (err as Error).message); }

    const r = await fluidtokens._fetchAllLoans();
    const loans = r.loans
      .filter(l => {
        if (!filterAsset) return true;
        const key = l.datum.principalAsset.policyId === ''
          ? 'ADA' : (l.datum.principalAsset.policyId + l.datum.principalAsset.assetNameHex).toLowerCase();
        return key === filterAsset.toLowerCase();
      })
      .map(l => ({
        loanIdHex:             l.loanIdHex,
        txHash:                l.txHash,
        outputIndex:           l.outputIndex,
        poolIdHex:             l.poolIdHex,
        collateralLovelace:    l.collateralLovelace.toString(),
        principal:             l.datum.principal.toString(),
        principalAsset:        l.datum.principalAsset,
        interestRate:          l.datum.interestRate,
        lendDateMs:            l.datum.lendDateMs,
        repaidInstallments:    l.datum.repaidInstallments,
        installmentPeriod:     l.datum.installmentPeriod,
        totalInstallments:     l.datum.totalInstallments,
        repaymentModeKind:     l.datum.repaymentMode.kind,
        liquidationModeKind:   l.datum.liquidationMode.kind,
      }));
    return {
      network,
      loanCount: loans.length,
      loans,
      computedAt: new Date().toISOString(),
    };
  });

  this.on('getFluidtokensHealth', async (req) => {
    let network: string;
    try { network = resolveFluidNetwork(); }
    catch (err) { return req.error(503, (err as Error).message); }

    // ADA-USD reference for LTV computation. Best-effort — if the price
    // fanout can't satisfy ADA-USD we skip LTV and flag in alerts.
    let adaUsd: number | null = null;
    try {
      const { quotes } = await fanout('ADA-USD');
      if (quotes.length > 0) {
        const agg = aggregate(quotes);
        if (Number.isFinite(agg.price) && agg.price > 0) adaUsd = agg.price;
      }
    } catch (err) {
      log.warn?.(`getFluidtokensHealth: ADA-USD fanout failed: ${(err as Error)?.message ?? err}`);
    }

    // Build a (policyId|assetNameHex) → StableMetadata index so we only call
    // an asset a "USD-pegged stable" when it actually matches a registered
    // entry. Previous version returned `1/adaUsd` for every non-ADA asset,
    // which mis-priced SNEK/HOSKY/BTC/NIGHT/etc. and produced false-positive
    // liquidations across the long-tail principals.
    const stableByPolicyAsset = new Map<string, typeof STABLE_METADATA[keyof typeof STABLE_METADATA]>();
    for (const m of Object.values(STABLE_METADATA)) {
      stableByPolicyAsset.set(`${m.policyId}|${m.assetNameHex}`, m);
    }

    const assetToLovelaceRate = (asset: { policyId: string; assetNameHex: string }): number | null => {
      // ADA — raw unit IS lovelace.
      if (!asset || (asset.policyId === '' && asset.assetNameHex === '')) return 1;
      const meta = stableByPolicyAsset.get(`${asset.policyId}|${asset.assetNameHex}`);
      if (meta && meta.peg === 'USD') {
        // 6-decimal USD-stable at peg ≈ 1 raw = 1e-6 USD = (1/adaUsd) lovelace.
        // Decimals enforced via the registry — every current entry is 6-dec.
        if (adaUsd === null || meta.decimals !== 6) return null;
        return 1 / adaUsd;
      }
      // Long-tail (BTC, NIGHT, SNEK, HOSKY, …) — no fixed-symbol price feed
      // wired here. Returning null causes computeFluidHealth to skip the
      // loan and report it under `liquidationSkippedUnpriceable` instead of
      // silently mis-pricing it.
      return null;
    };

    const result = await computeFluidHealth({
      fetchAllPools: fluidtokens._fetchAllPools,
      fetchAllLoans: fluidtokens._fetchAllLoans,
      assetToLovelaceRate,
      log: (level, msg) => log[level]?.(`getFluidtokensHealth: ${msg}`),
    });

    const alerts = [...result.alerts];
    if (adaUsd === null) alerts.push('fluidtokens-ada-usd-reference-missing');

    return {
      network,
      computedAt: new Date(result.computedAtMs).toISOString(),
      poolsTotal: result.poolsTotal,
      loansTotal: result.loansTotal,
      perAsset:   result.perAsset.map(r => ({
        assetKey:               r.key,
        principalAsset:         r.principalAsset,
        poolCount:              r.pools.count,
        poolsAvailableRaw:      r.pools.availableRaw,
        poolsLovelace:          r.pools.lovelace,
        loanCount:              r.loans.count,
        outstandingPrincipalRaw: r.loans.outstandingPrincipalRaw,
        currentDebtRaw:          r.loans.currentDebtRaw,
        collateralLovelace:      r.loans.collateralLovelace,
        liquidatable:                  r.loans.liquidatable,
        liquidationSkippedUnpriceable: r.loans.liquidationSkippedUnpriceable,
        late:                          r.loans.late,
        permissionedPoolCount:         r.pools.permissionedCount,
      })),
      alerts,
    };
  });

  this.on('getLiqwidHealth', async (req) => {
    let network: string;
    try { network = resolveLiqwidNetwork(); }
    catch (err) { return req.error(503, (err as Error).message); }

    const r = await liqwid._fetchAllMarkets();

    const alerts: string[] = [];
    if (r.apySourceFailed) alerts.push('liqwid-apy-source-down');
    if (r.markets.length === 0) alerts.push('liqwid-no-markets-found');

    return {
      network,
      computedAt: new Date().toISOString(),
      marketCount: r.markets.length,
      apySource: r.apySourceFailed ? 'unavailable' : 'liqwid-api',
      perMarket: r.markets.map(m => {
        // Note: the adapter's _fetchAllMarkets already called recordAndDerive
        // for getPrice. We call again here so the health endpoint also gets
        // the derivation; module-state is shared, so the second call sees the
        // same prev-snapshot and may return rates with Δt = 0 since the first
        // call refreshed the snapshot. Acceptable: the timestamp diff is
        // sub-millisecond and recordAndDerive returns null for Δt < 60s, so
        // the health endpoint inherits whatever the adapter already exposed.
        const derived = recordAndDerive(
          m.symbol, m.state.interestIndex, m.state.lastInterestUpdateMs,
        );
        const util = utilizationFraction(m.state);
        return {
          symbol:   m.symbol,
          liqwidId: m.liqwidId,
          txHash:   m.txHash,
          outputIndex: m.outputIndex,
          decimals: 6,
          supplyRaw:        m.state.supplyRaw.toString(),
          principalRaw:     m.state.principalRaw.toString(),
          reserveRaw:       m.state.reserveRaw.toString(),
          totalSuppliedRaw: totalSuppliedRaw(m.state).toString(),
          qTokenSupplyRaw:  m.state.qTokenSupplyRaw.toString(),
          qTokenRate:       qTokenRate(m.state),
          utilization:      util,
          supplyAPY:    m.apy?.supplyAPY   ?? null,
          borrowAPY:    m.apy?.borrowAPY   ?? null,
          lqSupplyAPY:  m.apy?.lqSupplyAPY ?? null,
          apyUpdatedAt: m.apy?.updatedAt   ?? null,
          observedBorrowAPR: derived?.borrowAPR ?? null,
          observedBorrowAPY: derived?.borrowAPY ?? null,
          observedSupplyAPY: derived ? deriveSupplyAPY(derived.borrowAPY, util) : null,
          observedDeltaMs:   derived?.observedDeltaMs ?? null,
          lastInterestUpdateMs: m.state.lastInterestUpdateMs,
          nextBatchDeadlineMs:  m.state.nextBatchDeadlineMs,
        };
      }),
      alerts,
    };
  });

});
