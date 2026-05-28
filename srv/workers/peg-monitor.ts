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
import { randomUUID } from 'node:crypto';
import {
  shouldFireAlert, signWebhook, isRearmingSample,
  HMAC_SIGNATURE_HEADER, HMAC_TIMESTAMP_HEADER, ALERT_PAYLOAD_VERSION,
  type AlertWebhookPayload,
} from '../lib/alert-detector';
import { decryptSecret } from '../lib/secret-crypto';
import { assertPublicEgress } from '../lib/webhook-egress';
import { fanout } from '../adapters/registry';
import { aggregate, pegDeviationBps } from '../aggregation';
import { metadataForPair } from '../lib/stable-metadata';

const ALERT_SUBSCRIPTIONS = 'chainfeed.AlertSubscriptions';
const WORKER_LEASES       = 'chainfeed.WorkerLeases';
const LEASE_NAME          = 'peg-monitor';

const POLL_INTERVAL_MS    = 60_000;     // every minute
const WEBHOOK_TIMEOUT_MS  = 10_000;
const SHUTDOWN_GRACE_MS   = 5_000;
// Lease TTL is 2× the poll interval so a single missed cycle (slow fanout,
// brief GC pause) doesn't yield the lease. Worker renews on every cycle.
const LEASE_TTL_MS        = 2 * POLL_INTERVAL_MS;

// Per-process identity. Used as the CAS guard on lease renewals so we can
// distinguish "we still hold it" from "another worker grabbed it after our
// last renewal expired".
const workerId = randomUUID();

const log = cds.log('peg-monitor');

interface SubscriptionRow {
  ID:             string;
  ownerAddr:      string;
  pair:           string;
  thresholdBps:   number;
  webhookUrl:     string;
  /** Encrypted envelope OR legacy plaintext hex — decrypt via `decryptSecret`. */
  hmacSecretHex:  string;
  validUntil:     string;
  status:         string;
  lastFiredAt:    string | null;
  lastBpsAtFire:  number | null;
  /** SQLite stores Boolean as 0/1; CDS read returns boolean. Null = "never fired". */
  armedSinceFire: boolean | number | null;
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

/**
 * Returns `true` iff the recipient acknowledged delivery (HTTP 2xx). On 4xx,
 * 5xx, network failure, or timeout returns `false` — caller leaves cooldown
 * fields unchanged so the breach is retried on the next poll cycle. Without
 * this gate, a recipient hiccup would record the alert as fired-and-cooled
 * and silently drop the breach.
 */
async function fireWebhook(sub: SubscriptionRow, bps: number, price: number, confidence: number): Promise<boolean> {
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
  // DNS-rebind recheck: the URL passed validateWebhookUrl at subscribe time,
  // but a public name can resolve to a private IP now. Re-verify before we
  // send — fail closed (skip + retry) rather than POST into the private net.
  const egress = await assertPublicEgress(new URL(sub.webhookUrl).hostname);
  if (!egress.ok) {
    log.warn(`webhook ${sub.ID} → ${sub.webhookUrl}: blocked egress — ${egress.reason}`);
    return false;
  }

  // Decrypt at the latest possible moment; secret stays in memory only for
  // the lifetime of this signWebhook call.
  const plainSecret = decryptSecret(sub.hmacSecretHex);
  const { body, timestamp, signatureHex } = signWebhook(plainSecret, payload);

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
      log.warn(`webhook ${sub.ID} → ${sub.webhookUrl}: HTTP ${res.status} — will retry next cycle`);
      return false;
    }
    log.info(`webhook ${sub.ID} → ${sub.webhookUrl}: 2xx (bps=${bps.toFixed(2)})`);
    return true;
  } catch (err) {
    log.warn(`webhook ${sub.ID} → ${sub.webhookUrl}: ${(err as Error)?.message ?? err} — will retry next cycle`);
    return false;
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

      // Promote a stored 0/1 (SQLite Boolean column) or string to a clean
      // tri-state: true | false | null.
      const armed: boolean | null =
        sub.armedSinceFire === null || sub.armedSinceFire === undefined
          ? null
          : !!sub.armedSinceFire;

      // Rearm observation: if this sample is below threshold × 0.5 AND
      // the subscription previously fired, flip the gate back to armed.
      // Persist the flip immediately so a worker crash mid-cycle doesn't
      // lose the rearm.
      if (armed === false && isRearmingSample(sub.thresholdBps, dev.bps)) {
        await cds.run(
          UPDATE(ALERT_SUBSCRIPTIONS)
            .set({ armedSinceFire: true })
            .where({ ID: sub.ID }),
        );
        sub.armedSinceFire = true;
      }

      const decision = shouldFireAlert(
        {
          thresholdBps:   sub.thresholdBps,
          lastFiredAt:    sub.lastFiredAt ? new Date(sub.lastFiredAt).getTime() : null,
          lastBpsAtFire:  sub.lastBpsAtFire,
          armedSinceFire:
            sub.armedSinceFire === null || sub.armedSinceFire === undefined
              ? null : !!sub.armedSinceFire,
        },
        dev.bps,
        now,
      );

      if (decision.fire) {
        const delivered = await fireWebhook(sub, dev.bps, dev.price, dev.confidence);
        if (delivered) {
          // Anchor cooldown to the actual fire time so a slow `fireWebhook`
          // doesn't shrink the window. 5xx/network errors return `false`
          // and leave `lastFiredAt` untouched — the breach is retried on
          // the next poll instead of silently dropped.
          await cds.run(
            UPDATE(ALERT_SUBSCRIPTIONS)
              .set({
                lastFiredAt:    new Date(Date.now()).toISOString(),
                lastBpsAtFire:  dev.bps,
                armedSinceFire: false,
                fireCount:      (sub.fireCount ?? 0) + 1,
              })
              .where({ ID: sub.ID }),
          );
        }
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

/**
 * Try to acquire (or renew) the worker lease. Returns true when this
 * process owns the lease and may proceed with a poll cycle; false when
 * another worker holds it and is still within its TTL.
 *
 * Not strictly atomic — between the SELECT and the UPDATE another worker
 * could observe the same state. The CAS guard `WHERE leaseHolder = <observed>`
 * narrows the window to "the lease was last seen as held by X and is
 * still held by X". For two operators-started-two-workers (the realistic
 * failure mode) this is sufficient; both workers converge to whichever
 * INSERT/UPDATE wins.
 */
async function acquireOrRenewLease(): Promise<boolean> {
  const now = Date.now();
  const leaseUntilIso = new Date(now + LEASE_TTL_MS).toISOString();

  const existing = await cds.run(
    SELECT.one.from(WORKER_LEASES).where({ name: LEASE_NAME }),
  ) as { leaseHolder: string; leaseUntil: string } | null | undefined;

  if (!existing) {
    // No row yet — first worker. INSERT may race with a sibling worker;
    // the loser falls through to the UPDATE path on the next call.
    try {
      await cds.run(INSERT.into(WORKER_LEASES).entries({
        name: LEASE_NAME, leaseHolder: workerId, leaseUntil: leaseUntilIso,
      }));
      return true;
    } catch {
      return false;
    }
  }

  const heldByUs       = existing.leaseHolder === workerId;
  const leaseExpiredMs = new Date(existing.leaseUntil).getTime();
  const expired        = Number.isFinite(leaseExpiredMs) && leaseExpiredMs < now;
  if (!heldByUs && !expired) return false;

  // CAS: only update if the holder hasn't changed since we read it.
  const affected = await cds.run(
    UPDATE(WORKER_LEASES)
      .set({ leaseHolder: workerId, leaseUntil: leaseUntilIso })
      .where({ name: LEASE_NAME, leaseHolder: existing.leaseHolder }),
  );
  return Number(affected ?? 0) > 0;
}

/**
 * Release the lease on clean shutdown. Best-effort — if the write fails
 * we'd otherwise wait LEASE_TTL_MS before another worker could take over.
 * On crash (no clean shutdown) the lease is reclaimed naturally via TTL.
 */
async function releaseLease(): Promise<void> {
  try {
    await cds.run(
      UPDATE(WORKER_LEASES)
        .set({ leaseUntil: new Date(0).toISOString() })
        .where({ name: LEASE_NAME, leaseHolder: workerId }),
    );
  } catch (err) {
    log.warn(`releaseLease failed (next worker waits up to ${LEASE_TTL_MS}ms):`, (err as Error)?.message ?? err);
  }
}

let stopping = false;
async function loop() {
  while (!stopping) {
    try {
      const owned = await acquireOrRenewLease();
      if (!owned) {
        log.info(`peg-monitor: lease held by another worker — sleeping ${POLL_INTERVAL_MS / 1000}s`);
      } else {
        await pollOnce();
      }
    }
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
  await releaseLease();
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
export { pollOnce, pegDeviationForPair, fireWebhook, acquireOrRenewLease, releaseLease };
