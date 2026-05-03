/**
 * Ed25519 response-signing pure-fn tests.
 * Run: npx tsx scripts/test-response-signing.ts
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  signResponse, verifySignedResponse, maybeSignResponse,
  publicKeyHexFromPrivate, canonicalizeJson, SIGNATURE_VERSION,
} from '../srv/lib/response-signing';

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

const PRIV_HEX  = randomBytes(32).toString('hex');
const PUB_HEX   = publicKeyHexFromPrivate(PRIV_HEX);
const OTHER_PUB = publicKeyHexFromPrivate(randomBytes(32).toString('hex'));

console.log('response-signing ────────────────────────────────────────');

// ── canonicalization ────────────────────────────────────────────────
t('canonicalizeJson: keys sorted alphabetically (recursive)', () => {
  const a = { b: 1, a: 2, c: { z: 9, y: 8, x: 7 } };
  const b = { a: 2, c: { x: 7, y: 8, z: 9 }, b: 1 };
  assert.equal(canonicalizeJson(a), canonicalizeJson(b));
  assert.equal(canonicalizeJson(a), '{"a":2,"b":1,"c":{"x":7,"y":8,"z":9}}');
});

t('canonicalizeJson: arrays preserve order', () => {
  assert.equal(canonicalizeJson([3, 1, 2]), '[3,1,2]');
  assert.notEqual(canonicalizeJson([1, 2, 3]), canonicalizeJson([3, 2, 1]));
});

t('canonicalizeJson: handles primitives + null', () => {
  assert.equal(canonicalizeJson(null),    'null');
  assert.equal(canonicalizeJson('hello'), '"hello"');
  assert.equal(canonicalizeJson(42),      '42');
  assert.equal(canonicalizeJson(true),    'true');
});

// ── publicKeyHexFromPrivate ─────────────────────────────────────────
t('publicKeyHexFromPrivate: returns 32-byte hex', () => {
  assert.equal(PUB_HEX.length, 64);
  assert.match(PUB_HEX, /^[0-9a-f]{64}$/);
});

t('publicKeyHexFromPrivate: deterministic (same priv → same pub)', () => {
  const priv = randomBytes(32).toString('hex');
  assert.equal(publicKeyHexFromPrivate(priv), publicKeyHexFromPrivate(priv));
});

t('publicKeyHexFromPrivate: rejects bad seed', () => {
  assert.throws(() => publicKeyHexFromPrivate('too-short'), /must be 32-byte hex/);
  assert.throws(() => publicKeyHexFromPrivate('zz'.repeat(32)), /must be 32-byte hex/);
});

// ── signResponse / verifySignedResponse round-trip ─────────────────
t('round-trip: sign + verify with correct key → ok', () => {
  const payload = { pair: 'ADA-USDM', price: 0.247, sources: 3 };
  const signed = signResponse(payload, PRIV_HEX);
  assert.equal(signed.signature.version, SIGNATURE_VERSION);
  assert.equal(signed.signature.signedHex.length, 128);  // 64 bytes hex
  assert.equal(signed.signature.keyId, PUB_HEX.slice(0, 16));
  const v = verifySignedResponse(signed, PUB_HEX);
  assert.equal(v.ok, true);
});

t('verify: wrong public key → fails with keyId-mismatch', () => {
  const signed = signResponse({ x: 1 }, PRIV_HEX);
  const v = verifySignedResponse(signed, OTHER_PUB);
  assert.equal(v.ok, false);
  if (!v.ok) assert.match(v.reason, /keyId mismatch/);
});

t('verify: tampered payload → signature verification fails', () => {
  const signed = signResponse({ price: 0.247 }, PRIV_HEX);
  // Tamper after signing
  (signed.payload as { price: number }).price = 0.999;
  const v = verifySignedResponse(signed, PUB_HEX);
  assert.equal(v.ok, false);
  if (!v.ok) assert.match(v.reason, /signature verification failed/);
});

t('verify: tampered signedAt → fails (signature covers timestamp)', () => {
  const signed = signResponse({ x: 1 }, PRIV_HEX);
  signed.signature.signedAt = new Date(Date.parse(signed.signature.signedAt) + 60_000).toISOString();
  const v = verifySignedResponse(signed, PUB_HEX);
  assert.equal(v.ok, false);
});

t('verify: clock-skew rejection (replay defense)', () => {
  const oldTs = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const signed = signResponse({ x: 1 }, PRIV_HEX, oldTs);
  // Use 5-min default window; 10-min-old signature should fail.
  const v = verifySignedResponse(signed, PUB_HEX);
  assert.equal(v.ok, false);
  if (!v.ok) assert.match(v.reason, /clock skew/);
});

t('verify: clock-skew window respected (within 5 min default)', () => {
  const recentTs = new Date(Date.now() - 60 * 1000).toISOString();
  const signed = signResponse({ x: 1 }, PRIV_HEX, recentTs);
  const v = verifySignedResponse(signed, PUB_HEX);
  assert.equal(v.ok, true);
});

t('verify: malformed signedHex → fails fast', () => {
  const signed = signResponse({ x: 1 }, PRIV_HEX);
  signed.signature.signedHex = 'not-hex';
  const v = verifySignedResponse(signed, PUB_HEX);
  assert.equal(v.ok, false);
  if (!v.ok) assert.match(v.reason, /malformed signedHex/);
});

t('verify: malformed signedAt → fails fast', () => {
  const signed = signResponse({ x: 1 }, PRIV_HEX);
  signed.signature.signedAt = 'yesterday';
  const v = verifySignedResponse(signed, PUB_HEX);
  assert.equal(v.ok, false);
});

t('verify: unsupported version → fails', () => {
  const signed = signResponse({ x: 1 }, PRIV_HEX);
  signed.signature.version = 'ed25519-v999' as never;
  const v = verifySignedResponse(signed, PUB_HEX);
  assert.equal(v.ok, false);
});

t('verify: order-insensitive payload (canonical bytes)', () => {
  const payload = { b: 2, a: 1, c: { y: 'y', x: 'x' } };
  const signed = signResponse(payload, PRIV_HEX);
  // Reorder keys client-side (e.g., after JSON.parse + manual restructure)
  const reordered: typeof payload = { a: 1, c: { x: 'x', y: 'y' }, b: 2 };
  signed.payload = reordered;
  const v = verifySignedResponse(signed, PUB_HEX);
  assert.equal(v.ok, true);
});

// ── maybeSignResponse env-gating ────────────────────────────────────
t('maybeSignResponse: returns signature=null when env not set', () => {
  const orig = process.env.CHAINFEED_SIGNING_PRIVATE_KEY_HEX;
  delete process.env.CHAINFEED_SIGNING_PRIVATE_KEY_HEX;
  const r = maybeSignResponse({ x: 1 });
  assert.equal(r.signature, null);
  if (orig !== undefined) process.env.CHAINFEED_SIGNING_PRIVATE_KEY_HEX = orig;
});

t('maybeSignResponse: signs when env is set', () => {
  process.env.CHAINFEED_SIGNING_PRIVATE_KEY_HEX = PRIV_HEX;
  const r = maybeSignResponse({ x: 1 });
  assert.notEqual(r.signature, null);
  if (r.signature) assert.equal(r.signature.version, SIGNATURE_VERSION);
  delete process.env.CHAINFEED_SIGNING_PRIVATE_KEY_HEX;
});

t('maybeSignResponse: graceful null on bad env', () => {
  process.env.CHAINFEED_SIGNING_PRIVATE_KEY_HEX = 'not-a-valid-key';
  const r = maybeSignResponse({ x: 1 });
  assert.equal(r.signature, null);
  delete process.env.CHAINFEED_SIGNING_PRIVATE_KEY_HEX;
});

console.log(`\n${n - fails}/${n} passed`);
process.exit(fails ? 1 : 0);
