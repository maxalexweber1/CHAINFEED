namespace chainfeed;

using { cuid, managed } from '@sap/cds/common';

entity AggregatedPrices : cuid, managed {
  pair            : String(20);
  price           : Decimal(20,10);
  sourcesUsed     : Integer;
  confidence      : Decimal(5,4);
  deviationPct    : Decimal(8,4);
  // Distance from peg in basis points. Null for non-stable pairs (BTC-ADA,
  // NIGHT-ADA, ADA-USD, …). Positive = above peg, negative = below.
  // Range in practice ±1000 bps; Decimal(14,2) leaves headroom for catastrophic
  // depegs (a 100× misprice = 990 000 bps) without throwing a numeric-overflow
  // error inside `persistResult`'s try/catch (which would silently drop the row).
  pegDeviationBps : Decimal(14,2) null;
  validFrom       : Timestamp;
  validUntil      : Timestamp;
  sources         : Composition of many PriceSources on sources.aggregated = $self;
}

entity PriceSources : cuid {
  aggregated    : Association to AggregatedPrices;
  sourceName    : String(50);
  price         : Decimal(20,10);
  txHash        : String(64);
  fetchedAt     : Timestamp;
  rawPayload    : LargeString;
}

// Audit trail for paid x402 reads. Written by the `@odatano/x402` gate's
// `onAccepted` callback in `srv/price-service.ts` after settlement. NOT a
// user-facing entity — internal record only.
entity FeedReads : cuid {
  feedKind          : String(50);
  feedRef           : String(100);
  consumerWallet    : String(120);
  amountPaidUSDM    : Decimal(20,6);
  paymentTxHash     : String(64);
  servedAt          : Timestamp;
  responsePayload   : LargeString;
}

// NOTE: there is no X402PaymentNonces entity. Cardano-x402-v2 replay
// defence is on-chain — the payment tx consumes a UTxO-ref nonce — so the
// pre-settle (gateService) flow needs no DB table. The confirmed-payment
// flow (subscriptions) defends replay via @assert.unique on
// AlertSubscriptions.paymentTxHash below.

// Webhook subscriptions for peg-break alerts. The worker
// `srv/workers/peg-monitor.ts` polls active subscriptions every minute,
// computes current peg-deviation, and fires HMAC-signed webhooks when
// the deviation crosses the subscriber's threshold (with hysteresis +
// cooldown — see srv/lib/alert-detector.ts).
//
// @assert.unique.paymentTx: a confirmed payment tx redeems exactly one
// subscription (null paymentTxHash — x402-disabled dev mode — is exempt).
@assert.unique.paymentTx: [ paymentTxHash ]
entity AlertSubscriptions : cuid, managed {
  // Cardano address of the consumer who created the subscription.
  // Required for `cancelSubscription` ownership checks; not currently
  // signature-verified (Sprint 4 ADR).
  ownerAddr        : String(120);
  pair             : String(20);                     // e.g. 'ADA-USDM'
  thresholdBps     : Decimal(10,2);                  // fire when |pegDeviationBps| ≥ this
  webhookUrl       : String(500);
  // HMAC-SHA256 secret used to sign outgoing webhook bodies. Returned
  // ONCE (cleartext) in the subscribe response — consumers MUST persist
  // it. Not recoverable later; subscriptions whose consumer lost the
  // secret must be cancelled and re-created.
  //
  // Stored encrypted: AES-256-GCM with the env-held KEK (see
  // `srv/lib/secret-crypto.ts`). Wire form `enc:v1:<base64url>` ≈ 88 chars
  // for a 32-byte secret. Legacy plain-hex rows (created before the
  // encryption wire-up) remain readable — `decryptSecret()` passes them
  // through.
  hmacSecretHex    : String(200);
  validUntil       : Timestamp;
  status           : String(20) default 'active';    // 'active' | 'cancelled' | 'expired'
  // Cooldown bookkeeping (set by the worker). Prevents alert-storm when
  // a stable oscillates around the threshold.
  lastFiredAt      : Timestamp null;
  lastBpsAtFire    : Decimal(10,2) null;
  // Rearm-hysteresis gate. `null` = never fired; `false` = fired and not yet
  // back below threshold × 0.5; `true` = breach resolved, ready to fire again.
  // Without this, `shouldFireAlert`'s rearm comparison degenerates (the
  // recorded `lastBpsAtFire` is always ≥ threshold by construction) and the
  // second alert never fires.
  armedSinceFire   : Boolean null;
  fireCount        : Integer default 0;
  // x402 payment proof for the subscription window. `subscribePegAlert`
  // verifies this tx on-chain via `@odatano/x402`'s verifyConfirmedPayment;
  // the @assert.unique above is the replay defence — v2 has no nonce
  // table, so a confirmed tx redeems exactly one subscription.
  paymentTxHash    : String(64) null;
}

// Single-instance advisory lock for background workers (currently just
// peg-monitor). Two operators accidentally starting two monitor processes
// would otherwise both fire duplicate webhooks and race on lastFiredAt; the
// lease enforces "one worker at a time per logical role".
//
// Algorithm: worker periodically tries to claim the lease via CAS UPDATE
// (only if leaseHolder matches us, or leaseUntil has expired). On lease
// loss, the worker skips pollOnce and retries the claim on the next tick.
entity WorkerLeases {
  // Logical worker role, e.g. 'peg-monitor'. One row per role.
  key name : String(40);
  // Per-process UUID set at boot. Round-trip CAS check uses this to detect
  // takeovers by another worker.
  leaseHolder : String(64);
  // Wall-clock expiry. Worker renews before TTL/2 to keep the lease alive.
  leaseUntil  : Timestamp;
}
