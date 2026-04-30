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

  app.use('/odata/v4/price', x402({
    feedKind:    'aggregated',
    description: 'CHAINFEED aggregated oracle price (mock-USDM on preprod)',
    routePricing: {
      // raw asset units (6 decimals → 10000 = 0.01 USDM, 50000 = 0.05 USDM)
      Prices:                  '10000',
      Sources:                 '10000',
      getBestPrice:            '10000',
      getTWAP:                 '20000',
      getArbitrageOpportunities: '50000',
    },
  }));

    log.info('x402 mounted on /odata/v4/price');
  });
