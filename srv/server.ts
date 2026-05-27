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
import path from 'node:path';
import { assertNetworkConsistency } from './x402-config';
import { assertEncryptionConfigured } from './lib/secret-crypto';
import { buildHealthReport, defaultReadHeartbeat } from './lib/health';
import { getRegistryStatus } from './adapters/registry';
import {
  globalLimiter,
  expensiveLimiter,
  subscriptionLimiter,
  EXPENSIVE_ACTION_PATHS,
  SUBSCRIPTION_ACTION_PATHS,
} from './lib/rate-limit';

const log = cds.log('chainfeed');

// Package version — read once at boot so /health doesn't touch disk per call.
const PKG_VERSION: string = (() => {
  try { return (require('../package.json') as { version: string }).version; }
  catch { return 'unknown'; }
})();

// Heartbeat path defaults to the same dev location the watcher writes to.
// Production sets WATCHER_HEARTBEAT_FILE=/data/watcher-heartbeat.json via env.
const HEARTBEAT_FILE = process.env.WATCHER_HEARTBEAT_FILE
  ?? path.resolve('agents/watcher/heartbeat.json');

// ── Boot-time safety gates ───────────────────────────────────────────
// Run BEFORE watch wiring so a misconfigured network OR a missing KEK
// fails the boot rather than silently going live with the wrong chain
// or cleartext webhook secrets at rest.
(cds as unknown as { on(ev: string, handler: () => void | Promise<void>): void })
  .on('served', () => {
    assertNetworkConsistency(log);
    assertEncryptionConfigured(log);
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

// ── Bootstrap-time middleware: trust-proxy + rate-limiting + /health ──
// `cds.on('bootstrap')` runs BEFORE CAP mounts the service routes, so any
// `app.use()` calls here apply ahead of /odata/* handlers — meaning the
// rate-limiter rejects floods before they reach a fanout-heavy action.
//
// Order matters:
//   1. trust proxy   → express reads X-Forwarded-For from Caddy so per-IP
//                      limits key on the real client, not the proxy.
//   2. expensiveLim. → tight 10/min/IP on fanout-heavy actions.
//   3. subscriptLim. → 5/min/IP on DB-write actions (peg alert subscribe).
//   4. globalLim.    → 60/min/IP catch-all for the rest of /odata/*.
//   5. /health       → registered AFTER limiters so its `skip()` doesn't
//                      need to compete for ordering. Verified by integration
//                      smoke that /health stays unlimited.
(cds as unknown as { on(ev: string, handler: (app: import('express').Express) => void): void })
  .on('bootstrap', (app) => {
    // One hop ahead (Caddy) — trust X-Forwarded-For from exactly one proxy.
    app.set('trust proxy', 1);

    for (const p of EXPENSIVE_ACTION_PATHS)    app.use(p, expensiveLimiter);
    for (const p of SUBSCRIPTION_ACTION_PATHS) app.use(p, subscriptionLimiter);
    app.use('/odata',                                 globalLimiter);

    app.get('/health', async (_req, res) => {
      try {
        const report = await buildHealthReport({
          pingDb: async () => {
            const t0 = Date.now();
            const db = await cds.connect.to('db') as { run: (q: string) => Promise<unknown> };
            // Raw SELECT 1 — works on SQLite + Postgres without entity knowledge.
            await db.run('SELECT 1 AS ping');
            return Date.now() - t0;
          },
          getAdapterStatuses: getRegistryStatus,
          readHeartbeat:      () => defaultReadHeartbeat(HEARTBEAT_FILE),
          now:                () => new Date(),
          uptimeSec:          () => process.uptime(),
          version:            PKG_VERSION,
        });
        res.status(report.status === 'critical' ? 503 : 200).json(report);
      } catch (e) {
        // Should never hit — buildHealthReport catches its own deps. Belt+suspenders.
        log.error(`/health crashed: ${(e as Error)?.message ?? e}`);
        res.status(500).json({ status: 'critical', error: 'health endpoint crashed' });
      }
    });
  });
// (closing wraps both the /health handler AND the rate-limit `app.use()` calls
// above — they're all inside the same single `on('bootstrap', app => { ... })`.)
