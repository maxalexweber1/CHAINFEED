/**
 * Single source of truth for CHAINFEED's x402 gated-route prices.
 *
 * Used by:
 *   1. The `@odatano/x402` `gateService(this, { routePricing })` mount in
 *      `srv/price-service.ts` — gates inbound CAP events at each route's
 *      price. Keys are CAP event names (entity name for CRUD, action name
 *      for actions); events absent from the map pass through free.
 *   2. The browser-buyer `buildPaymentTx` action — looks up the price for
 *      the action the buyer wants to call, builds an unsigned tx for that
 *      amount.
 *
 * Keeping both consumers reading from this map prevents the two from
 * drifting (e.g. gate says 10000, builder says 50000 — would 402-loop).
 *
 * This is CHAINFEED domain config — `@odatano/x402` is asset- and
 * route-agnostic; the price list lives here, not in the plugin.
 * (Renamed from the old `srv/x402/pricing.ts` during the v2 migration.)
 */

/**
 * Map of gated CAP event name → raw asset units. Free routes
 * (getStableHealth, getOhlcv, getServiceStatus, getStableConvergence,
 * buildPaymentTx, subscribePegAlert, listSubscriptions, cancelSubscription,
 * getFluidtokens*, getLiqwidHealth) are intentionally absent.
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
 * Build the resource URL the way the x402 gate sees it. Used by the
 * browser-buyer helper so the requirements `resource.url` matches what
 * the gate emits on the eventual paid call.
 */
export function resourcePathForAction(action: string, baseUrl?: string): string {
  const path = `/odata/v4/price/${action}`;
  return baseUrl ? `${baseUrl.replace(/\/$/, '')}${path}` : path;
}
