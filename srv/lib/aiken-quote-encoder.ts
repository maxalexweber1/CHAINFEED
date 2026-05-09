/**
 * Off-chain producer of CHAINFEED-signed quotes for on-chain consumption.
 *
 * Pairs with the Aiken library at `contracts/lib/chainfeed.ak`. Produces
 * **bytewise-identical canonical Plutus CBOR** for the quote payload,
 * Ed25519-signs those bytes, and assembles the `SignedQuote` PlutusData
 * that DApps embed in their redeemer.
 *
 * Why a separate signing flow from `srv/lib/response-signing.ts`:
 *   - That one signs canonical JSON (good for off-chain HTTP consumers).
 *   - This one signs canonical CBOR (required for Aiken's `cbor.serialise`).
 *   - DApps verify with `verify_ed25519_signature(pubkey, cbor_bytes, sig)`.
 *
 * Field order in `buildQuotePlutusData` MUST match the field order in the
 * Aiken `ChainfeedQuote` type definition. If you reorder one, reorder both
 * in the same commit. The unit test in `scripts/test-aiken-quote-encoder.ts`
 * pins a golden-bytes regression so divergence is caught immediately.
 */

import * as CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { sign, createPrivateKey, createPublicKey } from 'node:crypto';

// ── Quote types (TS-side mirror of Aiken's ChainfeedQuote) ──────────────────

export interface ChainfeedQuote {
  /** Pair label as ASCII string. Encoded as bytes on chain. e.g. 'ADA-USD'. */
  pair: string;
  /** Price × 1_000_000. Fixed-point — no Plutus floats. */
  priceMilliUnits: bigint;
  /** POSIX milliseconds when the quote stops being valid. */
  validUntilMs: bigint;
  /** POSIX milliseconds of signing. Verifier checks freshness against `now`. */
  signedAtMs: bigint;
}

export interface SignedQuote {
  quote: ChainfeedQuote;
  /** 64-byte raw Ed25519 signature, hex-encoded. */
  signatureHex: string;
}

// ── PlutusData builders ─────────────────────────────────────────────────────

/**
 * Build the canonical PlutusData for a quote. Result encodes as
 * `Constr 0 [pair_bytes, price_int, valid_until_int, signed_at_int]`.
 *
 * `to_bytes()` on the returned object yields the EXACT bytes that are
 * (a) signed off-chain, and (b) re-produced by `cbor.serialise(quote)`
 * on chain — both sides emit Plutus-canonical CBOR.
 */
export function buildQuotePlutusData(quote: ChainfeedQuote): CSL.PlutusData {
  const fields = CSL.PlutusList.new();
  fields.add(CSL.PlutusData.new_bytes(Buffer.from(quote.pair, 'utf8')));
  fields.add(CSL.PlutusData.new_integer(CSL.BigInt.from_str(quote.priceMilliUnits.toString())));
  fields.add(CSL.PlutusData.new_integer(CSL.BigInt.from_str(quote.validUntilMs.toString())));
  fields.add(CSL.PlutusData.new_integer(CSL.BigInt.from_str(quote.signedAtMs.toString())));
  return CSL.PlutusData.new_constr_plutus_data(
    CSL.ConstrPlutusData.new(CSL.BigNum.from_str('0'), fields),
  );
}

/** Canonical bytes that get Ed25519-signed. Identical to `cbor.serialise(quote)` in Aiken. */
export function canonicalQuoteBytes(quote: ChainfeedQuote): Buffer {
  return Buffer.from(buildQuotePlutusData(quote).to_bytes());
}

/** Build the PlutusData for `SignedQuote { quote, signature }`. */
export function buildSignedQuotePlutusData(signed: SignedQuote): CSL.PlutusData {
  const fields = CSL.PlutusList.new();
  fields.add(buildQuotePlutusData(signed.quote));
  fields.add(CSL.PlutusData.new_bytes(Buffer.from(signed.signatureHex, 'hex')));
  return CSL.PlutusData.new_constr_plutus_data(
    CSL.ConstrPlutusData.new(CSL.BigNum.from_str('0'), fields),
  );
}

// ── Signing ─────────────────────────────────────────────────────────────────

/**
 * Convert a 32-byte hex Ed25519 seed into a Node KeyObject.
 * Same DER prefix scheme as `srv/lib/response-signing.ts`.
 */
function privateKeyFromHex(hex: string): ReturnType<typeof createPrivateKey> {
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error('private key hex must be 32-byte hex (64 chars)');
  }
  const prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
  const seed   = Buffer.from(hex, 'hex');
  return createPrivateKey({ key: Buffer.concat([prefix, seed]), format: 'der', type: 'pkcs8' });
}

/** Derive the 32-byte Ed25519 public key (hex) from a 32-byte seed (hex). */
export function publicKeyHexFromPrivate(privHex: string): string {
  const priv = privateKeyFromHex(privHex);
  const pub  = createPublicKey(priv);
  const der  = pub.export({ format: 'der', type: 'spki' });
  // SPKI for Ed25519 is 44 bytes total; the raw 32-byte key is the tail.
  return Buffer.from(der.slice(-32)).toString('hex');
}

/**
 * Sign a quote and return the wrapped `SignedQuote`. Verifier on chain:
 *   `verify_ed25519_signature(<pinned chainfeed pubkey>, cbor_bytes, sig)`.
 */
export function signQuote(quote: ChainfeedQuote, privKeyHex: string): SignedQuote {
  const priv = privateKeyFromHex(privKeyHex);
  const msg  = canonicalQuoteBytes(quote);
  const sig  = sign(null, msg, priv);
  return { quote, signatureHex: Buffer.from(sig).toString('hex') };
}

// ── stop_loss demo redeemer helpers ────────────────────────────────────────
//
// These are convenience wrappers for the demo validator at
// `contracts/validators/stop_loss.ak`. Other DApps build their own redeemer
// shape — they only need `buildSignedQuotePlutusData` from the library.

/** Aiken `Action` enum: Constr 0 = Withdraw, Constr 1 = Liquidate. */
export type StopLossAction = 'withdraw' | 'liquidate';

function actionPlutusData(action: StopLossAction): CSL.PlutusData {
  const altIdx = action === 'withdraw' ? '0' : '1';
  return CSL.PlutusData.new_constr_plutus_data(
    CSL.ConstrPlutusData.new(CSL.BigNum.from_str(altIdx), CSL.PlutusList.new()),
  );
}

/** Build the PlutusData for `Redeemer { action, signed }` of stop_loss. */
export function buildStopLossRedeemer(action: StopLossAction, signed: SignedQuote): CSL.PlutusData {
  const fields = CSL.PlutusList.new();
  fields.add(actionPlutusData(action));
  fields.add(buildSignedQuotePlutusData(signed));
  return CSL.PlutusData.new_constr_plutus_data(
    CSL.ConstrPlutusData.new(CSL.BigNum.from_str('0'), fields),
  );
}

/**
 * Build the PlutusData for stop_loss's `Datum`. Lives here for demo-flow
 * convenience — production DApps will define their own datum shape.
 */
export interface StopLossDatum {
  ownerPkhHex: string;          // 28-byte hex (payment key hash)
  liquidatorPkhHex: string;     // 28-byte hex
  liquidationPriceMilliUnits: bigint;
  chainfeedPubkeyHex: string;   // 32-byte hex (raw Ed25519 pubkey)
  maxQuoteAgeMs: bigint;
}

export function buildStopLossDatumPlutusData(d: StopLossDatum): CSL.PlutusData {
  const fields = CSL.PlutusList.new();
  fields.add(CSL.PlutusData.new_bytes(Buffer.from(d.ownerPkhHex, 'hex')));
  fields.add(CSL.PlutusData.new_bytes(Buffer.from(d.liquidatorPkhHex, 'hex')));
  fields.add(CSL.PlutusData.new_integer(CSL.BigInt.from_str(d.liquidationPriceMilliUnits.toString())));
  fields.add(CSL.PlutusData.new_bytes(Buffer.from(d.chainfeedPubkeyHex, 'hex')));
  fields.add(CSL.PlutusData.new_integer(CSL.BigInt.from_str(d.maxQuoteAgeMs.toString())));
  return CSL.PlutusData.new_constr_plutus_data(
    CSL.ConstrPlutusData.new(CSL.BigNum.from_str('0'), fields),
  );
}
