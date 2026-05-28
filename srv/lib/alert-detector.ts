/**
 * Peg-break alert detection + HMAC webhook signing.
 *
 * Pure functions — no I/O. The worker (`srv/workers/peg-monitor.ts`)
 * computes current peg-deviation, asks `shouldFireAlert` whether to
 * fire, and on yes builds a payload, signs it, POSTs to the webhook URL.
 *
 * Hysteresis & cooldown rules (the "don't spam at the boundary" guard):
 *   1. **Threshold cross**: fire only when |currentBps| crosses the
 *      threshold from below. After a fire, no re-fire until the worker
 *      has observed a sample where `|bps| < threshold × 0.5` — that
 *      observation flips `armedSinceFire` back to true. The worker
 *      persists this flag, so a restart doesn't break the gate.
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
  /**
   * Re-arm gate. `null` (never fired) and `true` are both "armed" — the
   * next clean cross can fire. After a fire the worker flips this to
   * `false` and only flips it back to `true` when it observes a sample
   * with `|bps| < threshold × REARM_FACTOR`. Without this flag the rearm
   * comparison degenerates to "lastBpsAtFire ≥ threshold × 0.5", which
   * is always true by construction (bps ≥ threshold) — so the second
   * alert would never fire.
   */
  armedSinceFire:   boolean | null;
}

/**
 * Worker helper: returns whether the supplied sample qualifies as
 * "re-armed" — i.e. peg returned far enough toward parity to consider
 * the previous breach resolved. Caller persists the resulting boolean
 * before invoking `shouldFireAlert` on the next cycle.
 */
export function isRearmingSample(thresholdBps: number, currentBps: number): boolean {
  return Math.abs(currentBps) < thresholdBps * REARM_FACTOR;
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

  // Hysteresis: if we already fired and the worker hasn't observed a
  // sample below the re-arm level since, treat this as the same event.
  // `armedSinceFire === null` means "never fired" (first cross) — go.
  if (state.lastFiredAt !== null && state.armedSinceFire === false) {
    return { fire: false, reason: 'rearming' };
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
 * Hostname patterns that resolve to private / loopback / link-local addresses.
 * Used in production to reject SSRF attempts — an attacker could otherwise
 * `subscribePegAlert` with webhookUrl=http://10.0.0.1:4004/odata/v4/... to
 * probe internal services from outside the firewall.
 *
 * This is a literal-hostname check, not a DNS-resolution check (TOCTOU
 * concerns plus latency cost). An attacker who points a public DNS name at a
 * private IP would still pass this check — that's a documented limitation.
 * For full SSRF safety, also restrict outbound network egress at the firewall
 * (we don't today; the watcher worker fetches the webhook directly).
 */
const PRIVATE_HOST_PATTERNS: ReadonlyArray<RegExp> = [
  /^localhost$/i,
  /^127\./,                       // IPv4 loopback           (127.0.0.0/8)
  /^10\./,                        // RFC1918 class A         (10.0.0.0/8)
  /^172\.(1[6-9]|2\d|3[01])\./,   // RFC1918 class B         (172.16.0.0/12)
  /^192\.168\./,                  // RFC1918 class C         (192.168.0.0/16)
  /^169\.254\./,                  // IPv4 link-local         (169.254.0.0/16)
  /^0\.0\.0\.0$/,                 // any-IPv4
  /^\[?::1\]?$/,                  // IPv6 loopback
  /^\[?fc[0-9a-f]{2}:/i,          // IPv6 unique local       (fc00::/7) — first byte fc/fd
  /^\[?fd[0-9a-f]{2}:/i,
  /^\[?fe[89ab][0-9a-f]:/i,       // IPv6 link-local         (fe80::/10)
];

export function isPrivateHostLiteral(hostname: string): boolean {
  // URL parser leaves IPv6 hostnames bracketed — strip for matching.
  const h = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  return PRIVATE_HOST_PATTERNS.some((rx) => rx.test(h));
}

/**
 * Validate a webhook URL: must be https (allow http for localhost test runs),
 * parseable, no userinfo, no fragment. In production (`NODE_ENV=production`)
 * also rejects private/loopback/link-local hosts to prevent SSRF. Returns the
 * normalized URL string or throws.
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
  if (process.env.NODE_ENV === 'production' && isPrivateHostLiteral(parsed.hostname)) {
    // Generic message — don't leak which check tripped, helps fuzzers slightly less.
    throw new Error('webhookUrl: private or internal hosts are not allowed');
  }
  return parsed.toString();
}
