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
 * The x402 middleware in `srv/middleware/x402.ts` already verified payment
 * before this handler ran. We trust `req.payment` if set, but do not require
 * it (CAP-internal calls bypass the gating).
 */

import cds from '@sap/cds';
import { fanout, sourcesForPair, fanoutDexOnly, dexSourcesForPair } from './adapters/registry';
import { aggregate, twap, type AggregatedResult } from './aggregation';
import type { PriceQuote } from './adapters/types';

const log = cds.log('price-service');

const AGGREGATED_PRICES = 'chainfeed.AggregatedPrices';
const PRICE_SOURCES     = 'chainfeed.PriceSources';

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
        price:        agg.price,
        sourcesUsed:  agg.sourcesUsed,
        confidence:   agg.confidence,
        deviationPct: agg.deviationPct,
        validFrom:    new Date(validFromMs).toISOString(),
        validUntil:   new Date(validUntilMs || Date.now()).toISOString(),
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
    await persistResult(pair, agg, quotes);

    return {
      pair,
      price:        agg.price,
      confidence:   agg.confidence,
      sourcesUsed:  agg.sourcesUsed,
      deviationPct: agg.deviationPct,
      validUntil:   new Date(
        quotes.reduce((m, q) => Math.max(m, q.validUntil ?? q.timestamp ?? Date.now()), 0) || Date.now(),
      ).toISOString(),
      auditTxHashes: quotes.map(q => q.txHash).filter(Boolean),
    };
  });

});
