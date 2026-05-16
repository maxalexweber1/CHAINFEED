//// CHAINFEED on-chain consumer library for Aiken validators.
////
//// Allows anyone to verify a CHAINFEED-signed price quote on-chain
//// and gate spend logic on price + freshness conditions.
////
//// Design notes:
////   1. Quote payload is the canonical Plutus-CBOR of `ChainfeedQuote`. The
////      off-chain TypeScript producer (`srv/lib/aiken-quote-encoder.ts`)
////      uses CSL's `PlutusData.to_bytes()` to produce IDENTICAL bytes; both
////      sides implement RFC 8949 deterministic CBOR via `serialiseData`.
////   2. Signature is plain Ed25519 (64 bytes), the same scheme Cardano
////      stake-keys use. CHAINFEED's signing key is published as a hex
////      pubkey; Consumers pin it in their datum so they don't trust an external
////      key registry on-chain.
////   3. All timestamps are POSIX milliseconds (matching CHAINFEED's REST
////      API) - divide by 1000 if you need to compare with `tx.validity_range`
////      seconds.
////
//// Usage: `use chainfeed/chainfeed.{verify, is_fresh, not_expired,
////                                   ChainfeedQuote, SignedQuote}`

use aiken/builtin
use aiken/cbor

/// A price quote as published by CHAINFEED. Field order is the canonical
/// payload — DON'T reorder unless you also bump the off-chain encoder
/// version. The price is fixed-point `value × 1_000_000` to avoid floats
/// (Plutus has no floating-point support).
pub type ChainfeedQuote {
  /// Pair label as ASCII bytes — e.g. `#"ADA-USD"`. Pre-validate length
  /// off-chain; on-chain string-equality on ByteArray is cheap.
  pair: ByteArray,
  /// Price multiplied by 1_000_000. ADA-USD at $0.6234 → 623_400.
  /// Range: ~9.2 × 10¹⁵ (Plutus Int is 64-bit-ish; safe for any peg).
  price_milli_units: Int,
  /// POSIX milliseconds when the quote stops being valid (set by CHAINFEED
  /// based on TTL of the underlying source).
  valid_until_ms: Int,
  /// POSIX milliseconds when CHAINFEED produced the signature. Use with
  /// `is_fresh` to enforce a max-age window from the consumer's perspective.
  signed_at_ms: Int,
}

/// A `ChainfeedQuote` plus its detached Ed25519 signature. This is the
/// shape consumers should embed in their redeemer.
pub type SignedQuote {
  quote: ChainfeedQuote,
  /// 64-byte raw Ed25519 signature over `cbor.serialise(quote)`.
  signature: ByteArray,
}

/// Verify the signature on a `SignedQuote` against the pinned CHAINFEED
/// public key. Returns `True` iff the signature is valid for the canonical
/// CBOR encoding of the quote payload.
///
/// `chainfeed_pubkey` is the 32-byte Ed25519 public key.
/// The off-chain producer publishes both the pubkey and a `keyId` (= the
/// blake2b-224 hash of the pubkey). Pin the pubkey itself in your datum
/// so verification is self-contained.
pub fn verify(signed: SignedQuote, chainfeed_pubkey: ByteArray) -> Bool {
  let payload_bytes = cbor.serialise(signed.quote)
  builtin.verify_ed25519_signature(
    chainfeed_pubkey,
    payload_bytes,
    signed.signature,
  )
}

/// Returns `True` if the quote was signed at most `max_age_ms` before `now_ms`,
/// AND was not signed in the future. Typical `max_age_ms` for stale-tolerant
/// DApps: `5 * 60 * 1000` (5 min).
///
/// Caller derives `now_ms` from `tx.validity_range`. Conservative pattern:
/// use the upper bound (latest possible tx time) so freshness checks are
/// safe against time-skew attacks.
///
/// **Future-quote defence:** the `signed_at_ms <= now_ms` lower bound stops
/// a leaked CHAINFEED signing key from being used to pre-sign quotes for
/// arbitrary future timestamps. Without it, `now_ms - signed_at_ms` goes
/// negative and the `<= max_age_ms` check passes trivially.
pub fn is_fresh(signed: SignedQuote, now_ms: Int, max_age_ms: Int) -> Bool {
  and {
    signed.quote.signed_at_ms <= now_ms,
    now_ms - signed.quote.signed_at_ms <= max_age_ms,
  }
}

/// Returns `True` if the quote's TTL hasn't passed yet (`now_ms <= valid_until_ms`).
pub fn not_expired(signed: SignedQuote, now_ms: Int) -> Bool {
  now_ms <= signed.quote.valid_until_ms
}

// ── Tests ────────────────────────────────────────────────────────────

/// Cross-check: verify a real signature produced by the off-chain TS encoder.
/// Pinned values from `node scripts/debug-aiken-cbor.ts`. If this test
/// fails, the canonical CBOR encoding has drifted between TS and Aiken
/// — investigate before shipping.
test verify_accepts_real_ts_signature() {
  let q =
    ChainfeedQuote {
      pair: #"4144412d555344",
      // "ADA-USD"
      price_milli_units: 500_000,
      valid_until_ms: 1_779_100_600_000,
      signed_at_ms: 1_779_100_000_000,
    }
  let pubkey =
    #"1a9934096fb709a6541cdb1b47be669c0d2a4428b90533b9794b7398d6707a27"
  let sig =
    #"2691345518dd47610c794f12f283b0e023bcab02ce0e05737c6a97d47c86287d6c53e94f5ff672c664e36edf30a54829d642d1413f9f261faab5656a1ea25600"
  verify(SignedQuote { quote: q, signature: sig }, pubkey)
}

test verify_rejects_when_signature_corrupt() {
  let q =
    ChainfeedQuote {
      pair: #"4144412d555344",
      // "ADA-USD"
      price_milli_units: 623_400,
      valid_until_ms: 2_000_000_000_000,
      signed_at_ms: 1_999_999_700_000,
    }
  // 32-byte zero pubkey + 64-byte zero sig — the actual sig over the quote
  // would be 64 nonzero bytes; zero-bytes are guaranteed-invalid.
  let pubkey =
    #"0000000000000000000000000000000000000000000000000000000000000000"
  let sig =
    #"00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
  !verify(SignedQuote { quote: q, signature: sig }, pubkey)
}

test is_fresh_within_window() {
  let q =
    ChainfeedQuote {
      pair: #"",
      price_milli_units: 0,
      valid_until_ms: 0,
      signed_at_ms: 1_000_000,
    }
  let signed = SignedQuote { quote: q, signature: #"" }
  is_fresh(signed, 1_000_100, 1_000)
}

test is_fresh_outside_window() {
  let q =
    ChainfeedQuote {
      pair: #"",
      price_milli_units: 0,
      valid_until_ms: 0,
      signed_at_ms: 1_000_000,
    }
  let signed = SignedQuote { quote: q, signature: #"" }
  !is_fresh(signed, 1_002_000, 1_000)
}

test is_fresh_rejects_future_signed_at() {
  let q =
    ChainfeedQuote {
      pair: #"",
      price_milli_units: 0,
      valid_until_ms: 0,
      // Signed 1 year in the future — leaked-key pre-sign scenario.
      signed_at_ms: 1_000_000 + 365 * 24 * 60 * 60 * 1_000,
    }
  let signed = SignedQuote { quote: q, signature: #"" }
  // Even with an enormous max_age, future-dated quotes must be rejected.
  !is_fresh(signed, 1_000_000, 10 * 365 * 24 * 60 * 60 * 1_000)
}

test not_expired_before_ttl() {
  let q =
    ChainfeedQuote {
      pair: #"",
      price_milli_units: 0,
      valid_until_ms: 5_000,
      signed_at_ms: 0,
    }
  let signed = SignedQuote { quote: q, signature: #"" }
  not_expired(signed, 4_999)
}

test not_expired_at_ttl_is_ok() {
  let q =
    ChainfeedQuote {
      pair: #"",
      price_milli_units: 0,
      valid_until_ms: 5_000,
      signed_at_ms: 0,
    }
  let signed = SignedQuote { quote: q, signature: #"" }
  not_expired(signed, 5_000)
}

test not_expired_past_ttl() {
  let q =
    ChainfeedQuote {
      pair: #"",
      price_milli_units: 0,
      valid_until_ms: 5_000,
      signed_at_ms: 0,
    }
  let signed = SignedQuote { quote: q, signature: #"" }
  !not_expired(signed, 5_001)
}
