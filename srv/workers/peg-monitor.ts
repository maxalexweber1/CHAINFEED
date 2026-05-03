/**
 * Peg-monitor worker — polls active alert-subscriptions every minute,
 * computes current pegDeviationBps for each subscribed pair, fires
 * HMAC-signed webhooks at threshold-cross.
 *
 * **Operational note:** this worker runs as a SEPARATE process. It is
 * NOT auto-started by `cds run` because production deployments may
 * want to:
 *   - run multiple webserver instances + a single monitor process
 *   - schedule the monitor via cron / k8s CronJob instead of in-process
 *   - run the monitor in a node with broader outbound network egress
 *     (webhooks may target arbitrary recipient URLs)
 *
 * Start manually:
 *   npx tsx srv/workers/peg-monitor.ts
 *
 * The worker exits cleanly on SIGINT/SIGTERM. State (last-fired-at,
 * fire-count) lives in the DB so multiple invocations are idempotent.
 */

import cds from '@sap/cds';
import {
  shouldFireAlert, signWebhook,
  HMAC_SIGNATURE_HEADER, HMAC_TIMESTAMP_HEADER, ALERT_PAYLOAD_VERSION,
  type AlertWebhookPayload,
} from '../lib/alert-detector';
import { fanout } from '../adapters/registry';
import { aggregate, pegDeviationBps } from '../aggregation';
import { metadataForPair } from '../lib/stable-metadata';

const ALERT_SUBSCRIPTIONS = 'chainfeed.AlertSubscriptions';

const POLL_INTERVAL_MS    = 60_000;     // every minute
const WEBHOOK_TIMEOUT_MS  = 10_000;
const SHUTDOWN_GRACE_MS   = 5_000;

const log = cds.log('peg-monitor');

interface SubscriptionRow {
  ID:             string;
  ownerAddr:      string;
  pair:           string;
  thresholdBps:   number;
  webhookUrl:     string;
  hmacSecretHex:  string;
  validUntil:     string;
  status:         string;
  lastFiredAt:    string | null;
  lastBpsAtFire:  number | null;
  fireCount:      number;
}

/**
 * Compute peg-deviation for one pair using the same fanout path the
 * synchronous price endpoint uses. Returns null when data unavailable.
 */
async function pegDeviationForPair(pair: string): Promise<{
  bps: number; price: number; confidence: number;
} | null> {
  const meta = metadataForPair(pair);
  if (!meta || meta.peg !== 'USD') return null;
  const [pairResult, usdResult] = await Promise.all([
    fanout(pair),
    fanout('ADA-USD'),
  ]);
  if (pairResult.quotes.length === 0 || usdResult.quotes.length === 0) return null;
  const pairAgg = aggregate(pairResult.quotes);
  const usdAgg  = aggregate(usdResult.quotes);
  try {
    return {
      bps:        pegDeviationBps(pairAgg.price, usdAgg.price),
      price:      pairAgg.price,
      confidence: pairAgg.confidence,
    };
  } catch { return null; }
}

async function fireWebhook(sub: SubscriptionRow, bps: number, price: number, confidence: number): Promise<void> {
  const payload: AlertWebhookPayload = {
    version:               ALERT_PAYLOAD_VERSION,
    subscriptionId:        sub.ID,
    pair:                  sub.pair,
    thresholdBps:          sub.thresholdBps,
    currentBps:            bps,
    pegDeviationDirection: bps >= 0 ? 'above' : 'below',
    price,
    confidence,
    detectedAt:            new Date().toISOString(),
    serviceUrl:            process.env.CHAINFEED_PUBLIC_URL ?? 'unknown',
  };
  const { body, timestamp, signatureHex } = signWebhook(sub.hmacSecretHex, payload);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const res = await fetch(sub.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type':            'application/json',
        [HMAC_SIGNATURE_HEADER]:   signatureHex,
        [HMAC_TIMESTAMP_HEADER]:   timestamp,
      },
      body,
      signal: ac.signal,
    });
    if (!res.ok) {
      log.warn(`webhook ${sub.ID} → ${sub.webhookUrl}: HTTP ${res.status}`);
    } else {
      log.info(`webhook ${sub.ID} → ${sub.webhookUrl}: 2xx (bps=${bps.toFixed(2)})`);
    }
  } catch (err) {
    log.warn(`webhook ${sub.ID} → ${sub.webhookUrl}: ${(err as Error)?.message ?? err}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One poll cycle. Pure orchestration — easily callable from tests with a
 * mocked `cds.run`-like layer if we ever do an integration test.
 */
async function pollOnce(): Promise<void> {
  const now = Date.now();

  // Pull active subscriptions whose validUntil is in the future.
  const subs = await cds.run(
    SELECT.from(ALERT_SUBSCRIPTIONS)
      .where({ status: 'active', validUntil: { '>=': new Date(now).toISOString() } }),
  ) as SubscriptionRow[];

  if (!subs || subs.length === 0) return;

  // Group by pair to avoid duplicate fanouts when many subscribers watch
  // the same pair (the common case).
  const byPair = new Map<string, SubscriptionRow[]>();
  for (const s of subs) {
    const arr = byPair.get(s.pair) ?? [];
    arr.push(s);
    byPair.set(s.pair, arr);
  }

  // Lazy-expire subscriptions whose window passed since the last poll.
  const expiredIds: string[] = [];

  for (const [pair, group] of byPair.entries()) {
    const dev = await pegDeviationForPair(pair);
    if (!dev) {
      log.warn(`peg-monitor: no peg-deviation available for ${pair} — skipping ${group.length} subs this cycle`);
      continue;
    }

    for (const sub of group) {
      // Defensive expiry check — even though the SQL filtered, an unknown
      // edge could let through. Cheap to re-check here.
      if (new Date(sub.validUntil).getTime() < now) {
        expiredIds.push(sub.ID);
        continue;
      }

      const decision = shouldFireAlert(
        {
          thresholdBps:  sub.thresholdBps,
          lastFiredAt:   sub.lastFiredAt ? new Date(sub.lastFiredAt).getTime() : null,
          lastBpsAtFire: sub.lastBpsAtFire,
        },
        dev.bps,
        now,
      );

      if (decision.fire) {
        await fireWebhook(sub, dev.bps, dev.price, dev.confidence);
        await cds.run(
          UPDATE(ALERT_SUBSCRIPTIONS)
            .set({
              lastFiredAt:   new Date(now).toISOString(),
              lastBpsAtFire: dev.bps,
              fireCount:     (sub.fireCount ?? 0) + 1,
            })
            .where({ ID: sub.ID }),
        );
      }
    }
  }

  if (expiredIds.length > 0) {
    await cds.run(
      UPDATE(ALERT_SUBSCRIPTIONS)
        .set({ status: 'expired' })
        .where({ ID: { in: expiredIds } }),
    );
    log.info(`peg-monitor: expired ${expiredIds.length} subscriptions`);
  }
}

let stopping = false;
async function loop() {
  while (!stopping) {
    try { await pollOnce(); }
    catch (err) { log.error('poll cycle failed:', (err as Error)?.stack ?? err); }
    if (stopping) break;
    await new Promise<void>(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}

async function main() {
  log.info('peg-monitor starting');
  await cds.connect.to('db');     // ensure DB is reachable
  const stop = () => {
    log.info('peg-monitor stopping (signal received)');
    stopping = true;
  };
  process.on('SIGINT',  stop);
  process.on('SIGTERM', stop);
  await loop();
  await new Promise<void>(r => setTimeout(r, SHUTDOWN_GRACE_MS));
  log.info('peg-monitor stopped');
  process.exit(0);
}

if (require.main === module) {
  main().catch(err => {
    log.error('peg-monitor crashed:', err?.stack ?? err);
    process.exit(2);
  });
}

// Exported for tests
export { pollOnce, pegDeviationForPair, fireWebhook };
