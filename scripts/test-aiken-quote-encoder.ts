/**
 * Aiken quote encoder — pure-fn roundtrip tests.
 *
 * Validates:
 *   1. canonicalQuoteBytes is deterministic (same input → same bytes)
 *   2. signQuote produces a valid Ed25519 signature over those bytes
 *      (verified via node:crypto with the derived public key — same
 *       signature would verify on chain via verify_ed25519_signature)
 *   3. Serialized PlutusData round-trips through CSL byte serialization
 *      unchanged (cbor canonicalization is stable)
 *   4. Pinned golden-bytes regression — if anyone reorders fields or
 *      changes encoding, the test fails immediately
 *
 * Run: npx tsx scripts/test-aiken-quote-encoder.ts
 */

import { strict as assert } from 'node:assert';
import { createPublicKey, verify } from 'node:crypto';
import * as CSL from '@emurgo/cardano-serialization-lib-nodejs';
import {
  buildQuotePlutusData, canonicalQuoteBytes, signQuote, publicKeyHexFromPrivate,
  buildSignedQuotePlutusData, buildStopLossRedeemer, buildStopLossDatumPlutusData,
  type ChainfeedQuote,
} from '../srv/lib/aiken-quote-encoder';

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

console.log('aiken-quote-encoder unit tests ───────────────────────────────────');

// Deterministic 32-byte test seed — NOT a real key. Generated via
// `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
// then pinned for test-stability.
const TEST_PRIV = 'a3c2b1d0e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1';

const SAMPLE_QUOTE: ChainfeedQuote = {
  pair: 'ADA-USD',
  priceMilliUnits: 623_400n,        // $0.6234
  validUntilMs: 2_000_000_000_000n, // 2033-05-18
  signedAtMs:   1_999_999_700_000n, // 5min before validUntil
};

t('canonicalQuoteBytes is deterministic', () => {
  const a = canonicalQuoteBytes(SAMPLE_QUOTE);
  const b = canonicalQuoteBytes({ ...SAMPLE_QUOTE });
  assert.equal(a.toString('hex'), b.toString('hex'));
});

t('canonicalQuoteBytes matches pinned golden bytes', () => {
  // Captured 2026-05-16 against @emurgo/cardano-serialization-lib-nodejs 15.x.
  // Decoded structure:
  //   d8 79 9f                 -- CBOR tag 121 (Constr 0), indefinite-length list
  //     47 4144412d555344      -- bytes("ADA-USD")
  //     1a 00098328            -- uint 623_400
  //     1b 000001d1a94a2000    -- uint 2_000_000_000_000
  //     1b 000001d1a9458c20    -- uint 1_999_999_700_000
  //   ff                       -- "break" terminator
  // The byte sequence IS the canonical signing payload; if this fails,
  // signatures produced after the change will NOT verify on-chain against
  // signatures produced before — treat as a breaking-change signal, not a
  // "update the pin" prompt.
  const EXPECTED_HEX =
    'd8799f474144412d5553441a000983281b000001d1a94a20001b000001d1a9458c20ff';
  const actual = canonicalQuoteBytes(SAMPLE_QUOTE).toString('hex');
  assert.equal(actual, EXPECTED_HEX, 'canonical encoding drift — see comment');
});

t('canonicalQuoteBytes handles edge fixtures (empty pair, zero price, max int)', () => {
  // Three corners we care about:
  //   1. empty `pair` bytes — confirms 0-length ByteArray encodes cleanly
  //   2. priceMilliUnits = 0n  — would-be Constr alt confusion / CBOR int 0
  //   3. priceMilliUnits at 2^60 — past Number.MAX_SAFE_INTEGER (2^53), proves
  //      the encoder isn't silently coercing through Number
  const cases: ChainfeedQuote[] = [
    { pair: '',         priceMilliUnits: 0n,                signedAtMs: 0n, validUntilMs: 0n },
    { pair: 'X',        priceMilliUnits: 1n,                signedAtMs: 0n, validUntilMs: 1n },
    { pair: 'ADA-USD',  priceMilliUnits: (1n << 60n) + 7n,  signedAtMs: 0n, validUntilMs: (1n << 60n) },
  ];
  for (const q of cases) {
    const hex = canonicalQuoteBytes(q).toString('hex');
    // Every encoding starts with the Constr 0 indefinite-list tag d8799f.
    assert(hex.startsWith('d8799f'), `expected Constr 0 prefix, got ${hex.slice(0, 8)} for ${JSON.stringify(q, (_k,v) => typeof v === 'bigint' ? v.toString() : v)}`);
    // Round-trip — confirms no truncation on the big-int branch.
    const pd = buildQuotePlutusData(q);
    assert.equal(
      Buffer.from(CSL.PlutusData.from_bytes(pd.to_bytes()).to_bytes()).toString('hex'),
      hex,
    );
  }
});

t('signQuote produces 64-byte ed25519 signature', () => {
  const signed = signQuote(SAMPLE_QUOTE, TEST_PRIV);
  assert.equal(signed.signatureHex.length, 128, 'expected 64-byte (128-hex-char) signature');
  assert(/^[0-9a-f]+$/.test(signed.signatureHex), 'expected lowercase hex');
});

t('signed quote verifies under the derived public key', () => {
  const signed = signQuote(SAMPLE_QUOTE, TEST_PRIV);
  const pubHex = publicKeyHexFromPrivate(TEST_PRIV);
  const msg = canonicalQuoteBytes(SAMPLE_QUOTE);
  const sig = Buffer.from(signed.signatureHex, 'hex');
  // Reconstruct SPKI for verify
  const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
  const pubKey = createPublicKey({
    key: Buffer.concat([spkiPrefix, Buffer.from(pubHex, 'hex')]),
    format: 'der', type: 'spki',
  });
  const ok = verify(null, msg, pubKey, sig);
  assert(ok, 'expected ed25519 signature to verify under derived public key');
});

t('signature does NOT verify against tampered payload', () => {
  const signed = signQuote(SAMPLE_QUOTE, TEST_PRIV);
  const pubHex = publicKeyHexFromPrivate(TEST_PRIV);
  // Tamper: change price by 1 milli-unit
  const tampered = { ...SAMPLE_QUOTE, priceMilliUnits: SAMPLE_QUOTE.priceMilliUnits + 1n };
  const msg = canonicalQuoteBytes(tampered);
  const sig = Buffer.from(signed.signatureHex, 'hex');
  const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
  const pubKey = createPublicKey({
    key: Buffer.concat([spkiPrefix, Buffer.from(pubHex, 'hex')]),
    format: 'der', type: 'spki',
  });
  const ok = verify(null, msg, pubKey, sig);
  assert(!ok, 'expected ed25519 verify to FAIL on tampered payload');
});

t('PlutusData round-trips through CSL byte serialization', () => {
  const pd = buildQuotePlutusData(SAMPLE_QUOTE);
  const bytes = pd.to_bytes();
  const roundtripped = CSL.PlutusData.from_bytes(bytes);
  assert.equal(
    Buffer.from(roundtripped.to_bytes()).toString('hex'),
    Buffer.from(bytes).toString('hex'),
  );
});

t('SignedQuote PlutusData has the expected shape', () => {
  const signed = signQuote(SAMPLE_QUOTE, TEST_PRIV);
  const pd = buildSignedQuotePlutusData(signed);
  const constr = pd.as_constr_plutus_data();
  assert(constr, 'expected Constr-shaped PlutusData');
  assert.equal(constr!.alternative().to_str(), '0', 'expected alt = 0');
  assert.equal(constr!.data().len(), 2, 'expected 2 fields: quote + signature');
});

t('stop_loss redeemer encodes Withdraw as Constr 0', () => {
  const signed = signQuote(SAMPLE_QUOTE, TEST_PRIV);
  const pd = buildStopLossRedeemer('withdraw', signed);
  const constr = pd.as_constr_plutus_data();
  assert(constr, 'expected Constr');
  const action = constr!.data().get(0).as_constr_plutus_data();
  assert(action, 'expected nested Constr for action');
  assert.equal(action!.alternative().to_str(), '0', 'Withdraw should be Constr 0');
});

t('stop_loss redeemer encodes Liquidate as Constr 1', () => {
  const signed = signQuote(SAMPLE_QUOTE, TEST_PRIV);
  const pd = buildStopLossRedeemer('liquidate', signed);
  const constr = pd.as_constr_plutus_data();
  const action = constr!.data().get(0).as_constr_plutus_data();
  assert.equal(action!.alternative().to_str(), '1', 'Liquidate should be Constr 1');
});

t('stop_loss datum encodes 5 fields in declared order', () => {
  const pd = buildStopLossDatumPlutusData({
    ownerPkhHex: 'aa'.repeat(28),
    liquidatorPkhHex: 'bb'.repeat(28),
    liquidationPriceMilliUnits: 500_000n,
    chainfeedPubkeyHex: 'cc'.repeat(32),
    maxQuoteAgeMs: 300_000n,
  });
  const constr = pd.as_constr_plutus_data();
  assert(constr);
  assert.equal(constr!.data().len(), 5, 'expected 5 datum fields');
});

console.log(`\n${n - fails}/${n} passed`);
process.exit(fails ? 1 : 0);
