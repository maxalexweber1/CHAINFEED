/**
 * CAP server bootstrap — mount the x402 middleware in front of gated
 * service paths.
 *
 * Mount strategy: gate everything under `/odata/v4/price` (the read-only
 * aggregated-price service). `/odata/v4/marketplace` stays free in v0.1
 * (provider registration is a marketplace primitive, not a paid call).
 *
 * `$metadata` and `$batch` are always exempt — buyers must be able to
 * discover the service surface without paying.
 *
 * If receiver-wallet env vars are missing (no `.env.local` sourced), we
 * skip the mount with a warning rather than crashing — the rest of the
 * service still boots, useful for `cds watch` work that doesn't touch
 * gated paths.
 */

import cds from '@sap/cds';
import type { Express } from 'express';

const log = cds.log('chainfeed');

// `bootstrap` is a CAP runtime event that fires once with the Express app
// instance, before service handlers are registered. The @cap-js/cds-types
// overloads don't list it, so we cast.
(cds as unknown as { on(ev: string, handler: (app: Express) => void): void })
  .on('bootstrap', (app: Express) => {
  if (!process.env.X402_PAY_TO || !process.env.X402_USDM_POLICY) {
    log.warn(
      'x402 disabled: X402_PAY_TO or X402_USDM_POLICY is not set. ' +
      'Source .env.local before `cds watch` to enable payment gating.',
    );
    return;
  }

  // Lazy-require so the middleware module isn't loaded when x402 is disabled.
  const { express: x402 } = require('./middleware/x402') as typeof import('./middleware/x402');
  const { GATED_ROUTE_PRICING } = require('./x402/pricing') as typeof import('./x402/pricing');

  // Paths NOT listed in GATED_ROUTE_PRICING are FREE by default (the
  // middleware passes through any unmapped route under `routePricing`).
  // The free tier is intentionally the public-dashboard surface:
  //   - getStableHealth, getOhlcv, getServiceStatus, getStableConvergence
  //     → power the "Cardano stablecoin health" portal (read-only)
  //   - buildPaymentTx → free helper that returns an unsigned tx for the
  //     browser CIP-30 buyer; the *paid* call comes when the buyer POSTs
  //     the gated route with X-PAYMENT
  //   - listSubscriptions / cancelSubscription → ownership-gated, free
  // The paid tier is the agent / B2B premium surface — see
  // srv/x402/pricing.ts for the canonical price list.
  app.use('/odata/v4/price', x402({
    feedKind:     'aggregated',
    description:  'CHAINFEED aggregated oracle price (mock-USDM on preprod)',
    routePricing: { ...GATED_ROUTE_PRICING },
  }));

    log.info('x402 mounted on /odata/v4/price');
  });

// ── ODATANO-WATCH event subscriptions ────────────────────────────────
// Register on `served` (after CAP has booted every service, including
// the watch plugin's CardanoWatcherAdminService). Failure here logs but
// doesn't crash — the system falls back to TTL-based polling.
(cds as unknown as { on(ev: string, handler: () => void | Promise<void>): void })
  .on('served', async () => {
    try {
      const { registerWatchSubscriptions } =
        require('./external/watch-subscriptions') as typeof import('./external/watch-subscriptions');
      await registerWatchSubscriptions();
    } catch (err) {
      log.warn(`watch subscriptions skipped: ${(err as Error)?.message ?? err}`);
    }
  });
