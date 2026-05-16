/**
 * Ed25519 response signing — extends CHAINFEED's trust-chain to API
 * responses, not just the audit-pack-of-record on the underlying quote.
 *
 * Use case: a downstream aggregator-of-aggregators (or simply a
 * caching/proxying intermediary) wants to forward a CHAINFEED response
 * to its own consumers AND let those consumers verify the response was
 * actually produced by CHAINFEED, not modified in transit.
 *
 * Trust model:
 *   - CHAINFEED node holds an Ed25519 private key (env: CHAINFEED_SIGNING_PRIVATE_KEY_HEX)
 *   - Public key published at /odata/v4/price/getServicePublicKey (or
 *     served as static at /.well-known/chainfeed-public-key)
 *   - Each signed response carries: { signature, signedAt, keyId }
 *   - Verifier reconstructs canonical-bytes (deterministic JSON over the
 *     payload minus the signature wrapper) and Ed25519-verifies.
 *
 * Replay defense: `signedAt` (ISO ts) is part of the signed bytes, so a
 * reused signature can be detected by checking the timestamp's freshness
 * (consumer policy — typically reject anything older than N seconds).
 *
 * Why Ed25519 specifically: native to Cardano (stake-key crypto), small
 * keys (32 bytes), small signatures (64 bytes), constant-time signing.
 * Node 18+ has it built in via `node:crypto`. No external dep.
 */

import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

export const SIGNATURE_VERSION = 'ed25519-v1';

export interface SignedResponse<T> {
  payload:   T;
  signature: {
    version:    typeof SIGNATURE_VERSION;
    signedAt:   string;        // ISO timestamp of signing
    keyId:      string;        // short identifier of the key (e.g. first 8 hex of pubkey)
    signedHex:  string;        // 64-byte Ed25519 sig, hex-encoded
  };
}

/**
 * Stable JSON canonicalization for signing. Object keys sorted
 * alphabetically (recursive). Arrays preserve order. No whitespace
 * variability.
 *
 * **Rejected types** — these throw rather than silently coerce, because
 * each one would produce a valid-but-meaningless signed payload:
 *   - `Date` instances stringify to `{}` (no `toJSON` invocation here).
 *   - `BigInt` throws inside `JSON.stringify` (Node default) AFTER
 *     `sortKeys` runs — and the error message is opaque. We throw earlier
 *     with a useful one.
 *   - `NaN` / `Infinity` / `-Infinity` would coerce to JSON `null` and
 *     silently change semantics.
 *
 * Callers must pre-serialise Dates to ISO strings and BigInts to base-10
 * strings (CHAINFEED's CDS Decimal columns already arrive as strings).
 */
export function canonicalizeJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function rejectUnserialisable(v: unknown, path: string): void {
  if (typeof v === 'number' && !Number.isFinite(v)) {
    throw new TypeError(`canonicalizeJson: ${path} is ${v} (NaN/Infinity not signable)`);
  }
  if (typeof v === 'bigint') {
    throw new TypeError(`canonicalizeJson: ${path} is a BigInt — convert to string before signing`);
  }
  if (v instanceof Date) {
    throw new TypeError(`canonicalizeJson: ${path} is a Date — convert to ISO string before signing`);
  }
}

function sortKeys(v: unknown, path = '$'): unknown {
  rejectUnserialisable(v, path);
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((item, i) => sortKeys(item, `${path}[${i}]`));
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v as Record<string, unknown>).sort()) {
    out[k] = sortKeys((v as Record<string, unknown>)[k], `${path}.${k}`);
  }
  return out;
}

/**
 * Convert a 32-byte hex-encoded Ed25519 seed to a Node KeyObject usable
 * by `crypto.sign`. Throws on bad input.
 */
function privateKeyFromHex(hex: string) {
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error('CHAINFEED_SIGNING_PRIVATE_KEY_HEX must be 32-byte hex (64 chars, lowercase)');
  }
  // Ed25519 PKCS8 DER prefix for a 32-byte seed:
  //   30 2e 02 01 00 30 05 06 03 2b 65 70 04 22 04 20 <seed>
  const prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
  const seed   = Buffer.from(hex, 'hex');
  return createPrivateKey({ key: Buffer.concat([prefix, seed]), format: 'der', type: 'pkcs8' });
}

/**
 * Convert a 32-byte hex-encoded Ed25519 public key to a Node KeyObject
 * usable by `crypto.verify`.
 */
function publicKeyFromHex(hex: string) {
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error('publicKey hex must be 32-byte hex (64 chars, lowercase)');
  }
  // Ed25519 SPKI DER prefix for a 32-byte raw public key:
  //   30 2a 30 05 06 03 2b 65 70 03 21 00 <pub>
  const prefix = Buffer.from('302a300506032b6570032100', 'hex');
  const pub    = Buffer.from(hex, 'hex');
  return createPublicKey({ key: Buffer.concat([prefix, pub]), format: 'der', type: 'spki' });
}

/** Derive the public key (32-byte hex) from a private-key hex seed. */
export function publicKeyHexFromPrivate(privHex: string): string {
  const priv = privateKeyFromHex(privHex);
  const pub  = createPublicKey(priv);
  // Export raw 32 bytes via DER → strip prefix.
  const der = pub.export({ format: 'der', type: 'spki' });
  // SPKI prefix is 12 bytes for Ed25519; the raw key is the last 32.
  return Buffer.from(der.slice(-32)).toString('hex');
}

/**
 * Sign a payload. Returns the wrapped envelope. `keyId` is computed as
 * the first 16 hex chars of the public key — short, recognizable in logs.
 */
export function signResponse<T>(payload: T, privKeyHex: string, signedAt = new Date().toISOString()): SignedResponse<T> {
  const priv  = privateKeyFromHex(privKeyHex);
  const pubHex = publicKeyHexFromPrivate(privKeyHex);
  const keyId = pubHex.slice(0, 16);

  // Sign: keyId + signedAt + canonical(payload). Including keyId+ts in the
  // signed bytes prevents timestamp-only or key-confusion replays.
  const message = Buffer.from(`${keyId}.${signedAt}.${canonicalizeJson(payload)}`, 'utf8');
  const sig = sign(null, message, priv);

  return {
    payload,
    signature: {
      version:   SIGNATURE_VERSION,
      signedAt,
      keyId,
      signedHex: sig.toString('hex'),
    },
  };
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Verify a signed response. `pubKeyHex` is the issuer's published
 * 32-byte public key.
 *
 * `maxAgeMs` (default 5 min) sets the freshness window — anything older
 * than that is rejected even if the signature would otherwise verify.
 */
export function verifySignedResponse<T>(
  signed: SignedResponse<T>,
  pubKeyHex: string,
  opts: { maxAgeMs?: number; now?: number } = {},
): VerifyResult {
  if (signed.signature?.version !== SIGNATURE_VERSION) {
    return { ok: false, reason: `unsupported signature version: ${signed.signature?.version}` };
  }
  if (!signed.signature.signedHex || !/^[0-9a-f]+$/i.test(signed.signature.signedHex)) {
    return { ok: false, reason: 'malformed signedHex' };
  }
  if (!signed.signature.signedAt || !signed.signature.signedAt.match(/^\d{4}-\d{2}-\d{2}T/)) {
    return { ok: false, reason: 'malformed signedAt (need ISO 8601)' };
  }

  const ts = Date.parse(signed.signature.signedAt);
  const now = opts.now ?? Date.now();
  const maxAge = opts.maxAgeMs ?? 5 * 60 * 1000;
  if (Math.abs(now - ts) > maxAge) {
    return { ok: false, reason: `clock skew or stale: signedAt is ${Math.abs(now - ts)}ms from now` };
  }

  // Verify keyId matches the supplied pubKey
  const expectedKeyId = pubKeyHex.slice(0, 16);
  if (signed.signature.keyId !== expectedKeyId) {
    return { ok: false, reason: `keyId mismatch — signed by ${signed.signature.keyId}, expected ${expectedKeyId}` };
  }

  let pub;
  try { pub = publicKeyFromHex(pubKeyHex); }
  catch (err) { return { ok: false, reason: `bad pubKeyHex: ${(err as Error).message}` }; }

  const message = Buffer.from(
    `${signed.signature.keyId}.${signed.signature.signedAt}.${canonicalizeJson(signed.payload)}`,
    'utf8',
  );
  const sig = Buffer.from(signed.signature.signedHex, 'hex');
  try {
    if (!verify(null, message, pub, sig)) return { ok: false, reason: 'signature verification failed' };
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `verify threw: ${(err as Error).message}` };
  }
}

/**
 * Optional wrapper used by service handlers. If
 * `CHAINFEED_SIGNING_PRIVATE_KEY_HEX` is set, returns the signed wrapper.
 * If unset, returns the raw payload as `{ payload, signature: null }` so
 * downstream consumers can branch consistently.
 */
export function maybeSignResponse<T>(payload: T): SignedResponse<T> | { payload: T; signature: null } {
  const priv = process.env.CHAINFEED_SIGNING_PRIVATE_KEY_HEX;
  if (!priv) return { payload, signature: null };
  try { return signResponse(payload, priv); }
  catch { return { payload, signature: null }; }
}
