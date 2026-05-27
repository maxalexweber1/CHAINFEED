/**
 * Per-IP rate limiting for the public-facing OData surface.
 *
 * Threat model: a single attacker can hammer a free endpoint (assess_stable,
 * getStableHealth, …) which fans out to Blockfrost + Koios + DEX GraphQL.
 * Cold-cache requests cost ~40 seconds + several adapter-API calls each.
 * Unrate-limited, a few req/sec from one IP can drain our Blockfrost quota
 * for the day. This module rejects bursts before they reach the adapters.
 *
 * Wiring is in `srv/server.ts` via `cds.on('bootstrap', app => ...)`. The
 * bootstrap hook fires before CAP mounts service routes, so `app.use()` here
 * runs ahead of the OData handlers — early rejection, no fanout cost.
 *
 * Production behind Caddy: Caddy adds `X-Forwarded-For` with the original
 * client IP. `srv/server.ts` sets `app.set('trust proxy', 1)` so express's
 * `req.ip` resolves to the real client and the limiter keys on that.
 *
 * Limits chosen pragmatically — tuned for "single legitimate user issues a
 * batch of follow-up questions in 10 seconds" vs "one IP making a script
 * call every 100ms". Adjust per-deploy by editing this file.
 *
 * Disabled (effectively no-op high limit) when `NODE_ENV !== 'production'`
 * so local dev with `npm run smoke` or the dashboard doesn't hit the wall.
 */

import rateLimit, { type RateLimitRequestHandler } from 'express-rate-limit';

const isProduction = process.env.NODE_ENV === 'production';

/** Standard knobs shared across all our limiters. */
const COMMON = {
  windowMs:       60 * 1000,
  standardHeaders: true as const,   // RateLimit-* response headers (RFC draft)
  legacyHeaders:   false as const,  // skip the old X-RateLimit-* headers
  // Skip /health entirely — uptime monitors need unfettered access.
  skip: (req: { path: string }) => req.path === '/health' || req.path === '/healthz',
};

/**
 * Catches obvious flooding. Applies to the entire OData surface (read +
 * action routes). 60/min in prod = ~1/sec sustained, generous burst.
 */
export const globalLimiter: RateLimitRequestHandler = rateLimit({
  ...COMMON,
  max:     isProduction ? 60 : 1000,
  message: { error: 'rate-limited: too many requests' },
});

/**
 * Heavyweight read endpoints — every call triggers fanout to all sources
 * for the relevant pair/stable. 10/min/IP in prod is plenty for a real
 * dashboard or chat-Q&A session while being too tight for cache-warming
 * scrape attacks.
 */
export const expensiveLimiter: RateLimitRequestHandler = rateLimit({
  ...COMMON,
  max:     isProduction ? 10 : 1000,
  message: { error: 'rate-limited: this endpoint is heavyweight; back off' },
});

/**
 * Endpoints that create DB rows or send outbound webhooks. Subscriptions are
 * the obvious one — abuse fills the AlertSubscriptions table. 5/min/IP is
 * already very generous for a human; bots have to wait.
 */
export const subscriptionLimiter: RateLimitRequestHandler = rateLimit({
  ...COMMON,
  max:     isProduction ? 5 : 1000,
  message: { error: 'rate-limited: subscription writes are throttled' },
});

/** OData action paths that should use the expensive limiter. */
export const EXPENSIVE_ACTION_PATHS = [
  '/odata/v4/price/assessStable',
  '/odata/v4/price/getStableHealth',
  '/odata/v4/price/getStableConvergence',
  '/odata/v4/price/getBestPrice',
  '/odata/v4/price/getArbitrageOpportunities',
  '/odata/v4/price/getOhlcv',
  '/odata/v4/price/getTWAP',
  '/odata/v4/price/getAuditPack',
  '/odata/v4/price/getFluidtokensPools',
  '/odata/v4/price/getFluidtokensLoans',
  '/odata/v4/price/getFluidtokensHealth',
  '/odata/v4/price/getLiqwidHealth',
] as const;

/** OData action paths that touch the DB / send webhooks. */
export const SUBSCRIPTION_ACTION_PATHS = [
  '/odata/v4/price/subscribePegAlert',
] as const;
