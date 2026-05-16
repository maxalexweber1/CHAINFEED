/**
 * Application-layer encryption for HMAC webhook secrets stored in
 * `AlertSubscriptions.hmacSecretHex`. The worker needs the cleartext at
 * sign-time, so we can't hash; we encrypt with a Key-Encryption-Key (KEK)
 * held only by the server.
 *
 * Threat model: an attacker with read-only DB access (backup leak,
 * SQL-injection in an unrelated entity) can no longer forge webhook
 * payloads. A full server compromise still leaks the KEK + the cleartexts
 * — that's the same threat surface as the live signing path, which is
 * unavoidable.
 *
 * Wire form:
 *   - Legacy plain hex: `<64 lower-hex chars>` (subscriptions created
 *     before this change stay readable).
 *   - Encrypted envelope: `enc:v1:<base64url>` where the base64url payload
 *     is `iv(12) || tag(16) || ciphertext(N)`. AES-256-GCM with a 12-byte
 *     IV, 16-byte tag, ciphertext-length == plaintext-length. For a 32-byte
 *     (64-hex) secret the envelope is 4+3+1+(12+16+32 → base64url 80 chars)
 *     = 88 chars total. Schema column is sized to 200 to leave headroom.
 *
 * KEK source: env var `CHAINFEED_SUBSCRIPTION_KEK_HEX` (32-byte / 64-hex
 * value). In production we refuse to start without it; in dev we warn and
 * fall back to plain storage (matching existing dev DBs).
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const KEK_ENV_VAR  = 'CHAINFEED_SUBSCRIPTION_KEK_HEX';
const ENVELOPE_PREFIX = 'enc:v1:';
const IV_BYTES  = 12;
const TAG_BYTES = 16;

/** Reads + caches the KEK on first use. Throws if the env value is malformed. */
let cachedKek: Buffer | null = null;
let kekResolved = false;
function getKek(): Buffer | null {
  if (kekResolved) return cachedKek;
  kekResolved = true;
  const raw = process.env[KEK_ENV_VAR];
  if (!raw) {
    cachedKek = null;
    return null;
  }
  if (!/^[0-9a-f]{64}$/i.test(raw)) {
    throw new Error(`${KEK_ENV_VAR}: expected 64 hex chars (32 bytes), got ${raw.length} chars`);
  }
  cachedKek = Buffer.from(raw, 'hex');
  return cachedKek;
}

/** Reset the cached KEK — exported for tests that rotate env vars between runs. */
export function _resetKekCache(): void {
  cachedKek = null;
  kekResolved = false;
}

/** True when a usable KEK is configured. */
export function isEncryptionKeyConfigured(): boolean {
  return getKek() !== null;
}

/**
 * Boot-time gate. Call from server startup. In production, refuses to boot
 * without a KEK so secrets can't be persisted in cleartext on a real
 * deployment. In dev, just warns.
 */
export function assertEncryptionConfigured(
  log: { warn: (msg: string) => void; error: (msg: string) => void } = console,
): void {
  if (isEncryptionKeyConfigured()) return;
  const msg = `${KEK_ENV_VAR} is not set — webhook HMAC secrets will be stored in cleartext.`;
  if (process.env.NODE_ENV === 'production') {
    log.error(msg);
    throw new Error(msg);
  }
  log.warn(`${msg} OK for dev/test; set it before any non-toy deployment.`);
}

/**
 * Returns true if the stored value is in the encrypted envelope format.
 * Plain 64-hex secrets are detected as `!isEncrypted`.
 */
export function isEncrypted(stored: string): boolean {
  return stored.startsWith(ENVELOPE_PREFIX);
}

/**
 * Encrypt a fresh HMAC secret for at-rest storage. Returns the original
 * cleartext unchanged when no KEK is configured (dev mode).
 */
export function encryptSecret(plainHex: string): string {
  if (!/^[0-9a-f]+$/i.test(plainHex)) {
    throw new Error('encryptSecret: input must be a hex string');
  }
  const kek = getKek();
  if (!kek) return plainHex;

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', kek, iv);
  const plainBytes = Buffer.from(plainHex, 'hex');
  const ct = Buffer.concat([cipher.update(plainBytes), cipher.final()]);
  const tag = cipher.getAuthTag();
  const envelope = Buffer.concat([iv, tag, ct]).toString('base64url');
  return `${ENVELOPE_PREFIX}${envelope}`;
}

/**
 * Decrypt a stored value back to the original hex string. Plain-hex inputs
 * (legacy subscriptions created before encryption was wired) pass through
 * unchanged. Throws on malformed envelopes or authentication failure.
 */
export function decryptSecret(stored: string): string {
  if (!isEncrypted(stored)) {
    if (!/^[0-9a-f]+$/i.test(stored)) {
      throw new Error('decryptSecret: stored value is neither hex nor an envelope');
    }
    return stored;
  }

  const kek = getKek();
  if (!kek) {
    throw new Error(
      `${KEK_ENV_VAR} not set, but a stored secret is encrypted. ` +
      `Refusing to decrypt without the key.`,
    );
  }

  const blob = Buffer.from(stored.slice(ENVELOPE_PREFIX.length), 'base64url');
  if (blob.length < IV_BYTES + TAG_BYTES + 1) {
    throw new Error('decryptSecret: envelope too short to contain iv+tag+ciphertext');
  }
  const iv  = blob.subarray(0, IV_BYTES);
  const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ct  = blob.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', kek, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('hex');
}
