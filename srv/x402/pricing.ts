/**
 * Single source of truth for x402 gated-route prices.
 *
 * Used by:
 *   1. The x402 middleware (`srv/middleware/x402.ts`) via `srv/server.ts` —
 *      gates inbound requests at each route's price.
 *   2. The browser-buyer `buildPaymentTx` action — looks up the price for
 *      the action the buyer wants to call, builds an unsigned tx for that
 *      amount.
 *
 * Keeping both consumers reading from this map prevents the two from
 * drifting (e.g. middleware says 10000, builder says 50000 — would 402-loop).
 */

/**
 * Map of gated-action name (last URL segment) → raw asset units. Free
 * routes (getStableHealth, getOhlcv, getServiceStatus, getStableConvergence,
 * buildPaymentTx) are intentionally absent.
 */
export const GATED_ROUTE_PRICING: Readonly<Record<string, string>> = Object.freeze({
  // OData entity reads
  Prices:                    '10000',
  Sources:                   '10000',
  // Quote / aggregator actions
  getBestPrice:              '10000',
  getTWAP:                   '20000',
  getArbitrageOpportunities: '50000',
  // Audit / verifiability
  getAuditPack:              '50000',
});

/**
 * Resolve the price for a named action. Throws when the action isn't
 * gated (caller's bug — they shouldn't be asking for a payment tx for a
 * free route).
 */
export function priceUnitsForAction(action: string): string {
  const v = GATED_ROUTE_PRICING[action];
  if (!v) {
    throw new Error(
      `priceUnitsForAction: '${action}' is not a gated route. Free routes don't need a payment tx.`,
    );
  }
  return v;
}

/**
 * Build the resource path the way the x402 middleware sees it. Used by
 * the browser-buyer helper so the requirements `resource` field matches
 * what the middleware compares against on the eventual paid POST.
 */
export function resourcePathForAction(action: string, baseUrl?: string): string {
  const path = `/odata/v4/price/${action}`;
  return baseUrl ? `${baseUrl.replace(/\/$/, '')}${path}` : path;
}
