/**
 * Alert-detector + webhook signing pure-fn tests.
 *
 * Run: npx tsx scripts/test-alert-detector.ts
 */

import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import {
  shouldFireAlert, signWebhook, verifyWebhook, isRearmingSample,
  generateHmacSecret, validateWebhookUrl,
  HMAC_SIGNATURE_HEADER, HMAC_TIMESTAMP_HEADER, ALERT_PAYLOAD_VERSION,
  type AlertWebhookPayload, type AlertDetectorState,
} from '../srv/lib/alert-detector';

/** Builder for AlertDetectorState test fixtures — defaults to "never fired". */
function state(overrides: Partial<AlertDetectorState> = {}): AlertDetectorState {
  return {
    thresholdBps:   100,
    lastFiredAt:    null,
    lastBpsAtFire:  null,
    armedSinceFire: null,
    ...overrides,
  };
}

let n = 0, fails = 0;
function t(name: string, fn: () => void) {
  n++;
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) {
    fails++;
    const err = e as Error;
    console.log(`FAIL  ${name}\n      ${err.stack || err.message}`);
  }
}

console.log('alert-detector ──────────────────────────────────────────');

const NOW = 1_800_000_000_000;
const SECRET = randomBytes(32).toString('hex');

function payloadFixture(overrides: Partial<AlertWebhookPayload> = {}): AlertWebhookPayload {
  return {
    version:               ALERT_PAYLOAD_VERSION,
    subscriptionId:        'sub-aaa',
    pair:                  'ADA-USDM',
    thresholdBps:          100,
    currentBps:            -250,
    pegDeviationDirection: 'below',
    price:                 0.247,
    confidence:            0.95,
    detectedAt:            new Date(NOW).toISOString(),
    serviceUrl:            'https://chainfeed.example.com',
    ...overrides,
  };
}

// ── shouldFireAlert ──────────────────────────────────────────────────
t('shouldFireAlert: below threshold → no fire', () => {
  const r = shouldFireAlert(state(), 50, NOW);
  assert.equal(r.fire, false);
  assert.equal(r.reason, 'below-threshold');
});

t('shouldFireAlert: clean threshold cross + never-fired → fire', () => {
  const r = shouldFireAlert(state(), -250, NOW);
  assert.equal(r.fire, true);
  assert.equal(r.reason, 'threshold-crossed');
});

t('shouldFireAlert: direction-agnostic (positive bps fires too)', () => {
  const r = shouldFireAlert(state(), 250, NOW);
  assert.equal(r.fire, true);
});

t('shouldFireAlert: cooldown blocks repeat fire within 15 min', () => {
  const tenMinAgo = NOW - 10 * 60 * 1000;
  const r = shouldFireAlert(
    state({ lastFiredAt: tenMinAgo, lastBpsAtFire: -250, armedSinceFire: false }),
    -260, NOW,
  );
  assert.equal(r.fire, false);
  assert.equal(r.reason, 'within-cooldown');
});

t('shouldFireAlert: cooldown elapsed but never re-armed → rearming (no fire)', () => {
  const twentyMinAgo = NOW - 20 * 60 * 1000;
  // Last fired at -250 bps. Current still at -200 bps; armed flag still false
  // because no sample has come back below thresh × 0.5 = 50 yet.
  const r = shouldFireAlert(
    state({ lastFiredAt: twentyMinAgo, lastBpsAtFire: -250, armedSinceFire: false }),
    -200, NOW,
  );
  assert.equal(r.fire, false);
  assert.equal(r.reason, 'rearming');
});

t('shouldFireAlert: cooldown elapsed AND re-armed → fire again (deadlock-fix)', () => {
  const twentyMinAgo = NOW - 20 * 60 * 1000;
  // Worker observed a sub-half sample earlier and flipped armedSinceFire=true.
  // Peg now snapped back beyond the threshold — second alert MUST fire.
  const r = shouldFireAlert(
    state({ lastFiredAt: twentyMinAgo, lastBpsAtFire: -250, armedSinceFire: true }),
    -260, NOW,
  );
  assert.equal(r.fire, true);
  assert.equal(r.reason, 'threshold-crossed');
});

t('isRearmingSample: |bps| < threshold × 0.5 is rearming', () => {
  assert.equal(isRearmingSample(100, 40),  true);   // |40| < 50
  assert.equal(isRearmingSample(100, -40), true);
  assert.equal(isRearmingSample(100, 50),  false);  // boundary — strict <
  assert.equal(isRearmingSample(100, 70),  false);
});

t('shouldFireAlert: NaN currentBps → no fire (degraded data)', () => {
  const r = shouldFireAlert(state(), NaN, NOW);
  assert.equal(r.fire, false);
  assert.equal(r.reason, 'below-threshold');
});

// ── HMAC signing + verification ──────────────────────────────────────
t('signWebhook: produces deterministic body + signature for same inputs', () => {
  const p = payloadFixture();
  const a = signWebhook(SECRET, p);
  // Recompute manually and compare
  const expected = createHmac('sha256', Buffer.from(SECRET, 'hex'))
    .update(`${a.timestamp}.${a.body}`, 'utf8')
    .digest('hex');
  assert.equal(a.signatureHex, expected);
  assert.equal(a.signatureHex.length, 64);
});

t('signWebhook: rejects malformed secret', () => {
  assert.throws(() => signWebhook('not-hex', payloadFixture()), /must be ≥ 16-byte/);
  assert.throws(() => signWebhook('aabb',     payloadFixture()), /must be ≥ 16-byte/);  // too short
});

t('verifyWebhook: round-trip OK', () => {
  const p = payloadFixture();
  const a = signWebhook(SECRET, p);
  const v = verifyWebhook(SECRET, a.body, a.timestamp, a.signatureHex);
  assert.equal(v.ok, true);
});

t('verifyWebhook: tampered body → fail', () => {
  const p = payloadFixture();
  const a = signWebhook(SECRET, p);
  const v = verifyWebhook(SECRET, a.body + ' tampered', a.timestamp, a.signatureHex);
  assert.equal(v.ok, false);
  assert.match((v as { reason: string }).reason, /signature mismatch/);
});

t('verifyWebhook: wrong secret → fail', () => {
  const p = payloadFixture();
  const a = signWebhook(SECRET, p);
  const otherSecret = randomBytes(32).toString('hex');
  const v = verifyWebhook(otherSecret, a.body, a.timestamp, a.signatureHex);
  assert.equal(v.ok, false);
});

t('verifyWebhook: clock-skew rejection (replay defense)', () => {
  const p = payloadFixture();
  const a = signWebhook(SECRET, p);
  // Pretend we received this 10 minutes after it was signed; default skew is 5 min.
  const futureNow = Number(a.timestamp) + 10 * 60 * 1000;
  const v = verifyWebhook(SECRET, a.body, a.timestamp, a.signatureHex, { now: futureNow });
  assert.equal(v.ok, false);
  assert.match((v as { reason: string }).reason, /clock skew/);
});

t('verifyWebhook: clock-skew tolerance respected (within window)', () => {
  const p = payloadFixture();
  const a = signWebhook(SECRET, p);
  const slightlyLater = Number(a.timestamp) + 60 * 1000;   // 1 min, well within 5-min default
  const v = verifyWebhook(SECRET, a.body, a.timestamp, a.signatureHex, { now: slightlyLater });
  assert.equal(v.ok, true);
});

t('verifyWebhook: wrong signature length → fail (constant-time guard)', () => {
  const p = payloadFixture();
  const a = signWebhook(SECRET, p);
  const v = verifyWebhook(SECRET, a.body, a.timestamp, a.signatureHex.slice(0, -2));
  assert.equal(v.ok, false);
  assert.match((v as { reason: string }).reason, /sig length mismatch/);
});

// ── secret generation ───────────────────────────────────────────────
t('generateHmacSecret: produces fresh 32-byte hex (different on each call)', () => {
  const a = generateHmacSecret();
  const b = generateHmacSecret();
  assert.equal(a.length, 64);
  assert.equal(b.length, 64);
  assert.notEqual(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

// ── webhook URL validation ──────────────────────────────────────────
t('validateWebhookUrl: accepts https URLs', () => {
  const ok = validateWebhookUrl('https://example.com/webhook?x=1');
  assert.equal(ok, 'https://example.com/webhook?x=1');
});

t('validateWebhookUrl: accepts localhost http for testing', () => {
  const ok = validateWebhookUrl('http://localhost:3000/hook');
  assert.equal(ok, 'http://localhost:3000/hook');
});

t('validateWebhookUrl: rejects non-https remote', () => {
  assert.throws(() => validateWebhookUrl('http://example.com/'), /must be https/);
});

t('validateWebhookUrl: rejects userinfo (security)', () => {
  assert.throws(() => validateWebhookUrl('https://user:pass@example.com/'), /userinfo/);
});

t('validateWebhookUrl: rejects fragment', () => {
  assert.throws(() => validateWebhookUrl('https://example.com/#hook'), /fragment/);
});

t('validateWebhookUrl: rejects malformed', () => {
  assert.throws(() => validateWebhookUrl('not a url'), /not a valid URL/);
  assert.throws(() => validateWebhookUrl(''),          /not a valid URL/);
});

// ── SSRF prevention (production mode only) ──────────────────────────
// In production, private/loopback/link-local hosts must be rejected to
// prevent an attacker from `subscribePegAlert`-ing a webhook pointed at
// our own internal services (10.x, 127.x, etc.) to probe them from outside.

function withProdEnv(fn: () => void): void {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try { fn(); }
  finally { process.env.NODE_ENV = prev; }
}

t('validateWebhookUrl (prod): rejects localhost http', () => {
  withProdEnv(() => {
    assert.throws(() => validateWebhookUrl('http://localhost:3000/hook'), /private or internal/);
    assert.throws(() => validateWebhookUrl('https://localhost/hook'),     /private or internal/);
  });
});

t('validateWebhookUrl (prod): rejects 127.x loopback', () => {
  withProdEnv(() => {
    assert.throws(() => validateWebhookUrl('https://127.0.0.1/hook'),     /private or internal/);
    assert.throws(() => validateWebhookUrl('https://127.5.6.7:8080/hook'), /private or internal/);
  });
});

t('validateWebhookUrl (prod): rejects RFC1918 ranges (10.x, 172.16-31.x, 192.168.x)', () => {
  withProdEnv(() => {
    assert.throws(() => validateWebhookUrl('https://10.0.0.1/hook'),    /private or internal/);
    assert.throws(() => validateWebhookUrl('https://10.255.255.255/h'), /private or internal/);
    assert.throws(() => validateWebhookUrl('https://172.16.0.1/hook'),  /private or internal/);
    assert.throws(() => validateWebhookUrl('https://172.31.255.255/h'), /private or internal/);
    assert.throws(() => validateWebhookUrl('https://192.168.1.1/hook'), /private or internal/);
  });
});

t('validateWebhookUrl (prod): rejects link-local + any-IPv4', () => {
  withProdEnv(() => {
    assert.throws(() => validateWebhookUrl('https://169.254.169.254/'), /private or internal/);
    assert.throws(() => validateWebhookUrl('https://0.0.0.0/'),         /private or internal/);
  });
});

t('validateWebhookUrl (prod): rejects IPv6 loopback + link-local + ULA', () => {
  withProdEnv(() => {
    assert.throws(() => validateWebhookUrl('https://[::1]/hook'),       /private or internal/);
    assert.throws(() => validateWebhookUrl('https://[fc00::1]/hook'),   /private or internal/);
    assert.throws(() => validateWebhookUrl('https://[fd00::1]/hook'),   /private or internal/);
    assert.throws(() => validateWebhookUrl('https://[fe80::1]/hook'),   /private or internal/);
  });
});

t('validateWebhookUrl (prod): does NOT reject 172.15.x or 172.32.x (outside RFC1918 B range)', () => {
  withProdEnv(() => {
    // These are public IPs that happen to look 172.x — must NOT be blocked.
    assert.equal(validateWebhookUrl('https://172.15.0.1/hook'), 'https://172.15.0.1/hook');
    assert.equal(validateWebhookUrl('https://172.32.0.1/hook'), 'https://172.32.0.1/hook');
  });
});

t('validateWebhookUrl (prod): public hosts still pass', () => {
  withProdEnv(() => {
    assert.equal(validateWebhookUrl('https://example.com/hook'),       'https://example.com/hook');
    assert.equal(validateWebhookUrl('https://api.discord.com/web/123'), 'https://api.discord.com/web/123');
  });
});

t('validateWebhookUrl (dev): localhost still allowed (developer experience)', () => {
  // No NODE_ENV=production set → SSRF check skipped, localhost stays usable.
  assert.equal(validateWebhookUrl('http://localhost:3000/hook'), 'http://localhost:3000/hook');
});

// ── header constants stable ─────────────────────────────────────────
t('header names are stable identifiers', () => {
  assert.equal(HMAC_SIGNATURE_HEADER, 'X-Chainfeed-Signature');
  assert.equal(HMAC_TIMESTAMP_HEADER, 'X-Chainfeed-Timestamp');
  assert.equal(ALERT_PAYLOAD_VERSION, 'v1');
});

console.log(`\n${n - fails}/${n} passed`);
process.exit(fails ? 1 : 0);
