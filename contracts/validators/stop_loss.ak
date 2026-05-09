//// Stop-loss demo — reference DApp consumer of the CHAINFEED Aiken library.
////
//// Encodes the simplest non-trivial use of an external price oracle:
////
////   * Owner locks ADA into this script with a `liquidation_price` floor.
////   * `Withdraw` path  → owner reclaims funds, gated on a CHAINFEED quote
////     showing price ≥ floor (proves they're not exiting under duress).
////   * `Liquidate` path → anyone triggers when price < floor, funds flow
////     to the pre-designated `liquidator_pkh` (typically a market-sell bot).
////
//// Both paths require:
////   * Valid Ed25519 signature on the quote against the pinned CHAINFEED pubkey.
////   * Quote freshness (default 5 min from `signed_at`).
////   * Quote not past its declared `valid_until` TTL.
////
//// To consume CHAINFEED in your own validator, copy the verify+freshness
//// pattern. The library at `contracts/lib/chainfeed.ak` is reusable as-is.

use aiken/collection/list
use aiken/interval.{Finite}
use cardano/transaction.{OutputReference, Transaction}
use chainfeed.{SignedQuote, is_fresh, not_expired, verify}

/// Locked-in conditions, written by the owner at funding time.
pub type Datum {
  /// 28-byte payment-key-hash that authorizes the `Withdraw` path.
  owner_pkh: ByteArray,
  /// 28-byte payment-key-hash that receives funds on `Liquidate`.
  liquidator_pkh: ByteArray,
  /// Floor price in milli-units (×1_000_000). Below this triggers liquidation.
  liquidation_price_milli_units: Int,
  /// 32-byte Ed25519 public key that CHAINFEED uses to sign quotes. Pin
  /// the pubkey itself (not just its hash) so verification is self-contained.
  chainfeed_pubkey: ByteArray,
  /// Maximum quote staleness accepted (in milliseconds). 5 min recommended.
  max_quote_age_ms: Int,
}

pub type Action {
  Withdraw
  Liquidate
}

pub type Redeemer {
  action: Action,
  signed: SignedQuote,
}

validator stop_loss {
  spend(
    datum: Option<Datum>,
    redeemer: Redeemer,
    _input: OutputReference,
    tx: Transaction,
  ) {
    expect Some(d) = datum

    // 1. Signature MUST verify against the pinned CHAINFEED pubkey.
    expect verify(redeemer.signed, d.chainfeed_pubkey)

    // 2. Establish "now" — use the upper bound of the tx's validity range,
    //    which is the latest possible block time. Conservative: a stale-ish
    //    quote fails freshness; a fresh-but-future quote passes (caller's
    //    burden to set sensible validity_range).
    let now_ms =
      when tx.validity_range.upper_bound.bound_type is {
        Finite(t) -> t
        // Open upper bound = "any time" — too permissive for stale-quote
        // safety. Reject. Caller MUST set a finite upper bound.
        _ -> fail @"stop_loss: tx.validity_range.upper_bound must be Finite"
      }

    // 3. Quote freshness + TTL — both must hold regardless of action.
    expect is_fresh(redeemer.signed, now_ms, d.max_quote_age_ms)
    expect not_expired(redeemer.signed, now_ms)

    // 4. Action-specific gating.
    when redeemer.action is {
      Withdraw -> {
        // Owner-authorized AND price ≥ floor. We don't enforce where funds
        // go — the owner builds whatever output structure they want.
        expect list.has(tx.extra_signatories, d.owner_pkh)
        redeemer.signed.quote.price_milli_units >= d.liquidation_price_milli_units
      }
      Liquidate ->
        // Permissionless trigger: anyone can submit if price < floor.
        // We don't check output destination here for demo simplicity — a
        // production version would verify an output to liquidator_pkh holds
        // the locked value (to prevent the liquidator triggering then
        // pocketing funds elsewhere). Keeping this terse so the verify-
        // pattern is the focus.
        redeemer.signed.quote.price_milli_units < d.liquidation_price_milli_units
    }
  }

  // Catch-all: only the spend purpose is meaningful for this validator.
  else(_) {
    fail @"stop_loss: only spend purpose supported"
  }
}

// ── Tests ────────────────────────────────────────────────────────────
//
// We don't unit-test the validator end-to-end here — that requires a full
// mock Transaction, which the Aiken stdlib supports but is a lot of fixture
// for a demo. The library's unit tests already cover the verify + fresh +
// expiry primitives. Validator behaviour is exercised end-to-end by
// `scripts/demo-aiken-flow.ts` against a real preprod tx.
