/**
 * CAP server bootstrap — CHAINFEED-specific `served` wiring.
 *
 * x402 payment gating is NOT mounted here anymore. Since the migration to
 * `@odatano/x402`, gating is a CAP-level concern: `srv/price-service.ts`
 * calls `gateService(this, …)` in its service init, and the
 * `@odatano/x402` CAP plugin warms up the Cardano bridge on `served`.
 *
 * The only thing left for this file is registering the ODATANO-WATCH
 * event subscriptions once every service (including the watch plugin's
 * admin service) has booted.
 */

import cds from '@sap/cds';

const log = cds.log('chainfeed');

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
