# `chainfeed-aiken` — On-chain consumer library

Reusable Aiken library for verifying CHAINFEED-signed price quotes. Plus a reference `stop_loss` validator showing how to use the library end-to-end.

## What this gives you

Three things any DApp consuming CHAINFEED on-chain needs:

1. **Ed25519 signature verification** of CHAINFEED's signed price quotes
2. **Quote freshness check** (max-age window, default ~5 min)
3. **TTL expiry check** (CHAINFEED-set `valid_until_ms`)

All three are pure functions in `lib/chainfeed.ak`. Library footprint is ~50 LoC, no transitive deps beyond `aiken-lang/stdlib`.

## Usage

In your DApp's `aiken.toml`:

```toml
[[dependencies]]
name = "chainfeed-cardano/chainfeed-aiken"
version = "0.0.0"  # or git-pinned
source = "github"
```

In your validator:

```aiken
use aiken/interval.{Finite}
use cardano/transaction.{Transaction}
use chainfeed.{SignedQuote, verify, is_fresh, not_expired}

pub type Datum {
  // Pin CHAINFEED's 32-byte Ed25519 pubkey in your datum so verification
  // is self-contained — no on-chain key registry to trust.
  chainfeed_pubkey: ByteArray,
  // Your DApp-specific fields ...
}

validator your_dapp {
  spend(datum: Option<Datum>, signed: SignedQuote, _input, tx: Transaction) {
    expect Some(d) = datum
    expect verify(signed, d.chainfeed_pubkey)

    let now_ms =
      when tx.validity_range.upper_bound.bound_type is {
        Finite(t) -> t
        _ -> fail @"need finite upper bound on validity range"
      }
    expect is_fresh(signed, now_ms, 5 * 60 * 1000)
    expect not_expired(signed, now_ms)

    // Now safe to use signed.quote.price_milli_units, etc.
    your_business_logic(d, signed.quote)
  }
}
```

## What's in this repo

```
contracts/
├── lib/chainfeed.ak           Library — ChainfeedQuote, SignedQuote,
│                              verify, is_fresh, not_expired
├── validators/stop_loss.ak    Reference DApp using the library —
│                              owner withdraw + permissionless liquidation
└── plutus.json                Compiled blueprint (committed)
```

The `stop_loss` validator is a reference, not a production contract. Concrete use cases that fit the library:

- Stop-loss / take-profit orders
- Conditional escrows (release on price condition)
- Liquidation triggers for lending protocols
- Streaming-payment release gates

## Off-chain producer

CHAINFEED's TypeScript producer for these quotes lives in `srv/lib/aiken-quote-encoder.ts`. It produces canonical Plutus CBOR matching `cbor.serialise` on chain, signs with Ed25519, and assembles the `SignedQuote` PlutusData.

End-to-end demo (lock + spend on preprod): `scripts/demo-aiken-flow.ts`. Run `npx tsx scripts/demo-aiken-flow.ts derive` to inspect the script address + datum/redeemer JSON without submitting any tx.

## Build + test

```bash
cd contracts
aiken check        # run the unit tests (6 currently)
aiken build        # produce plutus.json
```

Tests cover: signature rejection on tampered bytes, freshness windowing, TTL boundary, and basic verify primitive.

## Versioning

Field order in `ChainfeedQuote` is the canonical signing payload. Any change is a **breaking change** for off-chain producers — signatures over the old layout don't verify against the new layout. Bump version + document migration when updating.

## License

Apache-2.0
