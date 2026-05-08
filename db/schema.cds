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
  // Range in practice ±1000 bps; Decimal(10,2) leaves headroom for depeg events.
  pegDeviationBps : Decimal(10,2) null;
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

// Audit trail for paid x402 reads. Written by `srv/x402/process.ts` and
// `srv/x402/verify-confirmed.ts` after settlement. NOT a user-facing
// entity — internal record only.
entity FeedReads : cuid {
  feedKind          : String(50);
  feedRef           : String(100);
  consumerWallet    : String(120);
  amountPaidUSDM    : Decimal(20,6);
  paymentTxHash     : String(64);
  servedAt          : Timestamp;
  responsePayload   : LargeString;
}

entity X402PaymentNonces {
  key txHash       : String(64);
  claimedAt        : Timestamp;
  route            : String(200);
  consumerAddr     : String(120);
  amountUnits      : String(20);
  network          : String(20);
}

// Webhook subscriptions for peg-break alerts. The worker
// `srv/workers/peg-monitor.ts` polls active subscriptions every minute,
// computes current peg-deviation, and fires HMAC-signed webhooks when
// the deviation crosses the subscriber's threshold (with hysteresis +
// cooldown — see srv/lib/alert-detector.ts).
entity AlertSubscriptions : cuid, managed {
  // Cardano address of the consumer who created the subscription.
  // Required for `cancelSubscription` ownership checks; not currently
  // signature-verified (Sprint 4 ADR).
  ownerAddr        : String(120);
  pair             : String(20);                     // e.g. 'ADA-USDM'
  thresholdBps     : Decimal(10,2);                  // fire when |pegDeviationBps| ≥ this
  webhookUrl       : String(500);
  // HMAC-SHA256 secret used to sign outgoing webhook bodies. Returned
  // ONCE in the subscribe response — consumers MUST persist it. Not
  // recoverable later; subscriptions whose consumer lost the secret
  // must be cancelled and re-created.
  hmacSecretHex    : String(64);
  validUntil       : Timestamp;
  status           : String(20) default 'active';    // 'active' | 'cancelled' | 'expired'
  // Cooldown bookkeeping (set by the worker). Prevents alert-storm when
  // a stable oscillates around the threshold.
  lastFiredAt      : Timestamp null;
  lastBpsAtFire    : Decimal(10,2) null;
  fireCount        : Integer default 0;
  // Optional: x402 payment proof. Today the action records but does not
  // verify; Sprint 4 ties this into the existing nonces.claim path so
  // subscribers can be charged for monthly windows on-chain.
  paymentTxHash    : String(64) null;
}
