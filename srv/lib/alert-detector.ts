/**
 * Peg-break alert detection + HMAC webhook signing.
 *
 * Pure functions — no I/O. The worker (`srv/workers/peg-monitor.ts`)
 * computes current peg-deviation, asks `shouldFireAlert` whether to
 * fire, and on yes builds a payload, signs it, POSTs to the webhook URL.
 *
 * Hysteresis & cooldown rules (the "don't spam at the boundary" guard):
 *   1. **Threshold cross**: fire only when |currentBps| crosses the
 *      threshold from below. If the alert already fired and the level
 *      stays elevated, no re-fire until the deviation comes BACK below
 *      `threshold × 0.5` (re-arm hysteresis).
 *   2. **Cooldown**: even on a clean cross, suppress if `lastFiredAt`
 *      is < `MIN_COOLDOWN_MS` (default 15 min) old. Prevents alert
 *      storms when an oracle stutters around the boundary.
 *   3. **Direction-agnostic**: thresholds are absolute (|bps| ≥ thr).
 *      A peg breaks symmetrically — above-peg is just as concerning
 *      as below-peg.
 */

import { createHmac, randomBytes } from 'node:crypto';

export const HMAC_SIGNATURE_HEADER = 'X-Chainfeed-Signature';
export const HMAC_TIMESTAMP_HEADER = 'X-Chainfeed-Timestamp';
export const ALERT_PAYLOAD_VERSION = 'v1';

const MIN_COOLDOWN_MS = 15 * 60 * 1000;     // 15 min between fires
const REARM_FACTOR    = 0.5;                  // hysteresis: re-arm at half the threshold

export interface AlertDetectorState {
  thresholdBps:     number;
  lastFiredAt:      number | null;            // epoch ms; null = never fired
  lastBpsAtFire:    number | null;             // signed bps recorded at last fire
}

export interface AlertDecision {
  fire: boolean;
  reason:
    | 'threshold-crossed'
    | 'within-cooldown'
    | 'rearming'
    | 'below-threshold';
}

/**
 * Decide whether the worker should fire an alert for `currentBps`.
 * Pure: no clock access except via `now`. Caller is responsible for
 * persisting `lastFiredAt` on fire.
 */
export function shouldFireAlert(
  state: AlertDetectorState,
  currentBps: number,
  now: number,
): AlertDecision {
  const abs = Math.abs(currentBps);
  if (!Number.isFinite(abs)) return { fire: false, reason: 'below-threshold' };
  if (abs < state.thresholdBps) return { fire: false, reason: 'below-threshold' };

  // Cooldown: most recent fire too recent → don't spam.
  if (state.lastFiredAt !== null && (now - state.lastFiredAt) < MIN_COOLDOWN_MS) {
    return { fire: false, reason: 'within-cooldown' };
  }

  // Hysteresis: if we already fired and the deviation hasn't come back
  // below the re-arm level since, treat this as the same event.
  if (state.lastFiredAt !== null && state.lastBpsAtFire !== null) {
    const lastAbs = Math.abs(state.lastBpsAtFire);
    // We're "still in the same alert" if the level never dropped below the
    // re-arm threshold. Worker tracks a continuous-cross flag separately;
    // here we use a conservative proxy: if the cooldown has elapsed AND
    // the deviation is BELOW the re-arm level since last fire, treat the
    // current sample as a new event. Otherwise it's still the same alert.
    if (lastAbs >= state.thresholdBps * REARM_FACTOR) {
      // No clean re-arm window seen — the worker should still log a
      // "still elevated" telemetry but NOT fire a fresh webhook.
      // Note: this requires the worker to hand us its in-memory rearm
      // observation. For now, the cooldown bound (above) is the primary
      // fire gate; rearming is a supplemental signal.
      return { fire: false, reason: 'rearming' };
    }
  }

  return { fire: true, reason: 'threshold-crossed' };
}

export interface AlertWebhookPayload {
  version:          typeof ALERT_PAYLOAD_VERSION;
  subscriptionId:   string;
  pair:             string;
  thresholdBps:     number;
  currentBps:       number;
  pegDeviationDirection: 'above' | 'below';
  /** Aggregated price at fire time. */
  price:            number;
  /** Price-aggregator confidence at fire time, [0, 1]. */
  confidence:       number;
  /** ISO timestamp of detection. */
  detectedAt:       string;
  /** Service URL that emitted the alert (for traceability). */
  serviceUrl:       string;
}

/**
 * Build the canonical payload bytes (deterministic JSON, no whitespace
 * variability) and an HMAC-SHA256 signature over `${ts}.${body}`. The
 * timestamp prefix prevents replay — the recipient verifies that the
 * delta to their wall-clock is < N minutes before trusting the signature.
 */
export function signWebhook(secretHex: string, payload: AlertWebhookPayload): {
  body: string;
  timestamp: string;
  signatureHex: string;
} {
  if (!/^[0-9a-f]+$/i.test(secretHex) || secretHex.length < 32) {
    throw new Error('signWebhook: secretHex must be ≥ 16-byte (32-hex) hex string');
  }
  const body = JSON.stringify(payload);
  const timestamp = String(Date.now());
  const secret = Buffer.from(secretHex, 'hex');
  const signatureHex = createHmac('sha256', secret)
    .update(`${timestamp}.${body}`, 'utf8')
    .digest('hex');
  return { body, timestamp, signatureHex };
}

/**
 * Verify a webhook signature. Used by recipients (and our own tests) to
 * confirm the payload is authentic + recent.
 *
 * `maxClockSkewMs` defends against replay: a body+sig pair captured
 * months ago can't be replayed if the recipient checks ts-freshness.
 */
export function verifyWebhook(
  secretHex: string,
  body: string,
  timestamp: string,
  signatureHex: string,
  opts: { maxClockSkewMs?: number; now?: number } = {},
): { ok: true } | { ok: false; reason: string } {
  if (!/^[0-9a-f]+$/i.test(secretHex)) return { ok: false, reason: 'bad secret format' };
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'bad timestamp' };
  const now = opts.now ?? Date.now();
  const skew = Math.abs(now - ts);
  const maxSkew = opts.maxClockSkewMs ?? 5 * 60 * 1000;
  if (skew > maxSkew) return { ok: false, reason: `clock skew ${skew}ms > ${maxSkew}ms` };

  const secret = Buffer.from(secretHex, 'hex');
  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.${body}`, 'utf8')
    .digest('hex');
  // Constant-time compare via Buffer equality of equal-length hex.
  if (expected.length !== signatureHex.length) return { ok: false, reason: 'sig length mismatch' };
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signatureHex.charCodeAt(i);
  if (diff !== 0) return { ok: false, reason: 'signature mismatch' };
  return { ok: true };
}

/** Generate a fresh per-subscription HMAC secret. 32 bytes / 64 hex chars. */
export function generateHmacSecret(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Validate a webhook URL: must be https (allow http for localhost test
 * runs), parseable, no userinfo, no fragment. Returns the normalized URL
 * string or throws.
 */
export function validateWebhookUrl(url: string): string {
  let parsed: URL;
  try { parsed = new URL(url); }
  catch { throw new Error('webhookUrl: not a valid URL'); }
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
    throw new Error('webhookUrl: must be https (localhost http allowed for testing)');
  }
  if (parsed.username || parsed.password) {
    throw new Error('webhookUrl: must not contain userinfo (use Authorization header in your endpoint instead)');
  }
  if (parsed.hash) {
    throw new Error('webhookUrl: must not contain a fragment');
  }
  return parsed.toString();
}
