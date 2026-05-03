using chainfeed from '../db/schema';

@path: '/odata/v4/price'
service PriceService {

  @readonly
  entity Prices  as projection on chainfeed.AggregatedPrices;

  @readonly
  entity Sources as projection on chainfeed.PriceSources;

  type AggregatedPriceResult {
    pair            : String;
    price           : Decimal(20,10);
    confidence      : Decimal(5,4);
    sourcesUsed     : Integer;
    deviationPct    : Decimal(8,4);
    // Distance from peg in basis points (positive = above peg, negative = below).
    // Null when the requested pair is not a registered USD-stable
    // (e.g. BTC-ADA, NIGHT-ADA, ADA-USD itself).
    pegDeviationBps : Decimal(10,2) null;
    validUntil      : Timestamp;
    auditTxHashes   : array of String;
  }

  action getBestPrice(pair : String) returns AggregatedPriceResult;

  type TWAPResult {
    pair          : String;
    windowMinutes : Integer;
    twap          : Decimal(20,10);
    samples       : Integer;
    windowStart   : Timestamp;
    windowEnd     : Timestamp;
  }

  action getTWAP(pair : String, windowMinutes : Integer) returns TWAPResult;

  type ArbitrageVenue {
    source : String;
    price  : Decimal(20,10);
  }

  type ArbitrageResult {
    pair       : String;
    bestBuy    : ArbitrageVenue;
    bestSell   : ArbitrageVenue;
    spreadPct  : Decimal(8,4);
    profitable : Boolean;
    venues     : array of ArbitrageVenue;
  }

  action getArbitrageOpportunities(pair : String) returns ArbitrageResult;

  // ── Stable health: composite per-stable dashboard ──────────────────
  // One call per symbol returns price + peg-deviation + reserves + supply
  // + risk-score + alerts. Sub-fetches are parallel and any one of them
  // failing degrades that section to null/false rather than failing the
  // whole call — consumers see partial data + an alert flagging it.

  type StableMetadataView {
    symbol             : String;
    peg                : String;
    backing            : String;
    issuerName         : String;
    issuerJurisdiction : String null;
    issuerCustodian    : String null;
    policyId           : String;
    assetNameHex       : String;
    decimals           : Integer;
    liveSince          : String;
  }

  type StableHealthPriceBlock {
    available     : Boolean;
    value         : Decimal(20,10) null;
    sourcesUsed   : Integer null;
    confidence    : Decimal(5,4)  null;
    deviationPct  : Decimal(8,4)  null;
  }

  type StableHealthReservesBlock {
    available    : Boolean;
    // Where did the reserves number come from. One of:
    // 'on-chain-attestation' (e.g. USDM-RESERVES via Charli3 ODV),
    // 'on-chain-collateral-aggregate' (DJED reserve script, Indigo CDPs),
    // 'off-chain-pdf' (Sprint 2 Day 9-10 — Circle / BitGo reports),
    // 'none' (no reserves source for this stable yet).
    source       : String null;
    // For attestation paths: USD bank-balance value.
    // For collateral-aggregate paths: ratio percent (>= 100 typically).
    value        : Decimal(20,4) null;
    unit         : String null;     // 'usd' | 'ratio_pct'
    healthBucket : String null;     // 'healthy' | 'warning' | 'alert' | 'critical'
    txHash       : String null;     // for on-chain sources only
    ageMs        : Integer null;
  }

  type StableHealthSupplyBlock {
    available         : Boolean;
    totalSupply       : Decimal(30,6) null;
    circulatingSupply : Decimal(30,6) null;
  }

  type StableHealthLiquidityBlock {
    available         : Boolean;
    // Best (max) effective price observed across successful probes — used as the mid proxy.
    midPrice          : Decimal(20,10) null;
    // Notional (in ADA) swappable at-or-below targetSlippagePct (conservative: largest
    // amount where THIS probe AND all smaller probes stayed within target).
    depthAda          : Decimal(20,2)  null;
    // True when ALL probes stayed within target — depth is AT LEAST depthAda.
    depthAtMaxProbed  : Boolean null;
    // True when slippage was monotonically non-decreasing across probes.
    // Always true under the post-2026-05-03 merged-pool constant-product
    // model unless a probe failed (no reserves available). Retained for
    // shape-compat with consumers that branch on it.
    routingMonotone   : Boolean null;
    targetSlippagePct : Decimal(5,2)   null;
    probedPointsCount : Integer null;
  }

  type StableHealthRiskComponent {
    value     : Decimal(5,4);   // [0, 1]
    weight    : Decimal(5,4);
    effective : Decimal(5,4);
  }

  type StableHealthRiskBlock {
    score                : Decimal(5,4);
    pegConfidence        : StableHealthRiskComponent;
    reserveAdequacy      : StableHealthRiskComponent;
    attestationFreshness : StableHealthRiskComponent;
    sourceConfidence     : StableHealthRiskComponent;
  }

  type StableHealthResult {
    symbol          : String;
    metadata        : StableMetadataView;
    price           : StableHealthPriceBlock;
    pegDeviationBps : Decimal(10,2) null;
    reserves        : StableHealthReservesBlock;
    supply          : StableHealthSupplyBlock;
    liquidity       : StableHealthLiquidityBlock;
    risk            : StableHealthRiskBlock;
    alerts          : array of String;
    computedAt      : Timestamp;
  }

  action getStableHealth(symbol : String) returns StableHealthResult;

  // ── Cross-stable convergence ────────────────────────────────────────
  // NxN matrix of implied stable-vs-stable cross-rates derived through
  // ADA pivot. Outlier flagging + scalar convergenceScore in [0,1].
  // Free endpoint — powers the public dashboard's compare view.

  type ConvergenceCrossRate {
    fromSymbol   : String;
    toSymbol     : String;
    /** Implied "toSymbol per 1 fromSymbol", derived through ADA pivot. */
    impliedRate  : Decimal(20,10);
    /** Distance from 1.0 in percent. Positive = fromSymbol dearer than toSymbol. */
    deviationPct : Decimal(8,4);
  }

  type ConvergenceResult {
    /** Stables included in the snapshot (those with usable live prices). */
    symbols          : array of String;
    /** All directed cross-rates. N × (N-1) entries for N symbols. */
    rates            : array of ConvergenceCrossRate;
    /** [0, 1]: 1.0 = perfect parity across the basket; 0 = chaotic spread. */
    convergenceScore : Decimal(5,4);
    /** Max |deviationPct| observed across the matrix. */
    maxDeviationPct  : Decimal(8,4);
    /** Symbols whose median |deviation| against the basket exceeded the warning band. */
    outliers         : array of String;
    /** Snapshot ADA-X price per symbol — exposed so consumers can sanity-check the math. */
    adaPrices        : array of {
      symbol   : String;
      adaPrice : Decimal(20,10);
    };
    computedAt       : Timestamp;
  }

  action getStableConvergence() returns ConvergenceResult;

  // ── Browser-buyer x402 helper ────────────────────────────────────────
  // Free endpoint that builds an unsigned Cardano tx for a browser-side
  // buyer. The buyer connects via CIP-30 (Lace, Eternl, ...), passes
  // their hex address, picks which gated endpoint they want to call,
  // and gets back an unsigned tx that pays the right USDM amount to the
  // CHAINFEED receiver. The wallet signs in-browser; the buyer wraps the
  // signed tx in X-PAYMENT and POSTs the gated endpoint normally.

  type UnsignedPaymentTx {
    /** Unsigned tx CBOR (hex). Pass to CIP-30 `signTx(cbor, false)`. */
    unsignedTxCborHex : String;
    /** Tx hash the wallet will display when prompting the user to sign. */
    txHashHex         : String;
    /** Buyer's payment-cred VKey hash — useful for UI to confirm match. */
    requiredSignerHex : String;
    /** Echo of the requirements the tx satisfies. */
    requirements      : {
      scheme            : String;
      network           : String;
      maxAmountRequired : String;
      asset             : String;
      assetNameHex      : String;
      decimals          : Integer;
      payTo             : String;
      resource          : String;
      description       : String;
    };
    /** Selected input UTxOs (so the UI can show "spends these"). */
    inputs            : array of {
      txHash      : String;
      outputIndex : Integer;
      lovelace    : String;
    };
  }

  /**
   * Build an unsigned x402 payment tx for `buyerAddrBech32` covering
   * `gatedAction`. Free — the buyer pays for the gated endpoint, not
   * for this builder. `gatedAction` must be one of the gated routes
   * configured in the x402 middleware (see srv/server.ts).
   */
  action buildPaymentTx(
    buyerAddrBech32 : String,
    gatedAction     : String,
  ) returns UnsignedPaymentTx;

  // ── OHLCV: candle history derived from AggregatedPrices stream ──────
  // CHAINFEED is an oracle aggregator, not a trading venue — `sampleCount`
  // is the count of oracle observations in the bucket, NOT traded volume.
  // Use a DEX-specific source for traded volume.

  type OhlcvCandle {
    ts          : Timestamp;
    open        : Decimal(20,10);
    high        : Decimal(20,10);
    low         : Decimal(20,10);
    close       : Decimal(20,10);
    sampleCount : Integer;
  }

  type OhlcvResult {
    pair         : String;
    interval     : String;       // '1m', '5m', '15m', '1h', '4h', '1d'
    windowStart  : Timestamp;
    windowEnd    : Timestamp;
    candles      : array of OhlcvCandle;
    /** Echo of the lookback the caller requested (after server-side clamping). */
    lookbackHours : Decimal(8,2);
  }

  /**
   * Aggregate AggregatedPrices for `pair` into OHLCV candles at `interval`.
   * `lookbackHours` is the time window ending now. Each interval has a
   * server-side cap (1m: 2h, 5m: 24h, 15m: 3d, 1h: 14d, 4h: 60d, 1d: 365d)
   * so a 1m-candles-for-1-year request gets clamped to 1m-for-2h.
   * Empty buckets (no oracle reads in that interval) are NOT forward-filled.
   */
  action getOhlcv(
    pair          : String,
    interval      : String,
    lookbackHours : Decimal(8,2),
  ) returns OhlcvResult;

  /**
   * Audit-pack: self-contained JSON envelope for one quote, with
   * per-file sha256 checksums + on-chain tx-hash references for offline
   * verification. Returned as a JSON string (LargeString) so consumers
   * can save-to-file or pipe to a verifier without unzipping.
   * See `srv/lib/audit-pack.ts` for the envelope schema and verification
   * recipe (also embedded in the README.md inside every pack).
   */
  action getAuditPack(quoteId : String) returns LargeString;

  // ── Peg-break alert subscriptions ──────────────────────────────────
  // Consumers register a webhook + threshold; the peg-monitor worker
  // (`srv/workers/peg-monitor.ts`) polls every minute, computes
  // pegDeviationBps for each subscribed pair, fires HMAC-signed POSTs
  // to the webhook URL when the deviation crosses the threshold (with
  // 15-min cooldown + 0.5×-threshold rearm hysteresis).

  type SubscribePegAlertResult {
    subscriptionId : UUID;
    /** HMAC secret returned ONCE — persist immediately, can't be recovered. */
    hmacSecretHex  : String;
    pair           : String;
    thresholdBps   : Decimal(10,2);
    webhookUrl     : String;
    validUntil     : Timestamp;
  }

  action subscribePegAlert(
    pair         : String,
    thresholdBps : Decimal(10,2),
    webhookUrl   : String,
    ownerAddr    : String,
    validUntilHours : Decimal(8,2),
    paymentTxHash : String null,
  ) returns SubscribePegAlertResult;

  type SubscriptionView {
    ID            : UUID;
    pair          : String;
    thresholdBps  : Decimal(10,2);
    webhookUrl    : String;
    validUntil    : Timestamp;
    status        : String;
    lastFiredAt   : Timestamp null;
    fireCount     : Integer;
    createdAt     : Timestamp;
  }

  action listSubscriptions(ownerAddr : String) returns array of SubscriptionView;

  action cancelSubscription(subscriptionId : UUID, ownerAddr : String) returns Boolean;

  // ── Operations status endpoint ──────────────────────────────────────
  // Per-adapter cache snapshot for ops dashboards / liveness probes. Pure
  // read of in-memory state — never triggers a fetch. Use to detect
  // degraded sources ("orcfax: last fetched 8 hours ago, lastError set").

  type AdapterPairStatus {
    pair               : String;
    fetchedAtIso       : Timestamp null;
    ageSeconds         : Integer null;
    hasInflightRefresh : Boolean;
    lastErrorMessage   : String null;
    lastErrorAtIso     : Timestamp null;
  }

  type AdapterStatus {
    sourceName       : String;
    ttlMs            : Integer;
    cachedPairCount  : Integer;
    pairs            : array of AdapterPairStatus;
  }

  type ServiceStatus {
    serviceUrl     : String;
    generatedAt    : Timestamp;
    adapters       : array of AdapterStatus;
  }

  action getServiceStatus() returns ServiceStatus;
}
