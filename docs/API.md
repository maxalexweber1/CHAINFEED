# CHAINFEED API

OData V4 service at `/odata/v4/price/`. JSON responses, POST for actions, GET for entity reads.

Free endpoints are public. **Paid endpoints** are gated by [x402](https://www.x402.org) USDM micropayments — see [Payment](#payment) below.

---

## Quick reference

| Endpoint | Type | Cost (raw / whole USDM) |
|---|---|---|
| [`GET /Prices`](#get-prices) | OData entity | 10 000 / 0.01 |
| [`GET /Sources`](#get-sources) | OData entity | 10 000 / 0.01 |
| [`POST /getBestPrice`](#post-getbestprice) | Action | 10 000 / 0.01 |
| [`POST /getTWAP`](#post-gettwap) | Action | 20 000 / 0.02 |
| [`POST /getArbitrageOpportunities`](#post-getarbitrageopportunities) | Action | 50 000 / 0.05 |
| [`POST /getAuditPack`](#post-getauditpack) | Action | 50 000 / 0.05 |
| [`POST /getStableHealth`](#post-getstablehealth) | Action | free |
| [`POST /getStableConvergence`](#post-getstableconvergence) | Action | free |
| [`POST /getOhlcv`](#post-getohlcv) | Action | free |
| [`POST /getFluidtokensPools`](#post-getfluidtokenspools) | Action | free |
| [`POST /getFluidtokensLoans`](#post-getfluidtokensloans) | Action | free |
| [`POST /getFluidtokensHealth`](#post-getfluidtokenshealth) | Action | free |
| [`POST /getLiqwidHealth`](#post-getliqwidhealth) | Action | free |
| [`POST /subscribePegAlert`](#post-subscribepegalert) | Action | priced per threshold/duration |
| [`POST /listSubscriptions`](#post-listsubscriptions) | Action | free |
| [`POST /cancelSubscription`](#post-cancelsubscription) | Action | free |
| [`POST /getServiceStatus`](#post-getservicestatus) | Action | free |
| [`POST /buildPaymentTx`](#post-buildpaymenttx) | Action | free |
| `GET /$metadata` | OData schema | free |

---

## Price aggregation

### `GET /Prices`

Paginated history of every aggregated quote. OData filters supported.

```http
GET /odata/v4/price/Prices?$filter=pair eq 'ADA-USDM'&$top=10&$orderby=validFrom desc
```

Returns `AggregatedPrices` rows with `pair`, `price`, `confidence`, `deviationPct`, `pegDeviationBps`, `validFrom`, `validUntil`.

### `GET /Sources`

Per-source audit rows behind each aggregated quote — `sourceName`, `price`, `txHash`, FK to the parent `AggregatedPrices`.

### `POST /getBestPrice`

Multi-source aggregated quote with peg deviation for stables.

**Body**: `{ "pair": "ADA-USDM" }`

**Returns**:
```json
{
  "pair": "ADA-USDM",
  "price": "0.6234180000",
  "confidence": "0.9821",
  "sourcesUsed": 5,
  "deviationPct": "0.18",
  "pegDeviationBps": "12.50",
  "validUntil": "2026-05-08T13:35:00Z",
  "auditTxHashes": ["…", "…"]
}
```

`pegDeviationBps` is null for non-USD-stable pairs (BTC-ADA, NIGHT-ADA, ADA-USD itself).

### `POST /getTWAP`

Time-weighted average from `AggregatedPrices` history.

**Body**: `{ "pair": "ADA-USDM", "windowMinutes": 60 }`

### `POST /getArbitrageOpportunities`

Best-buy / best-sell DEX with spread%. Oracles excluded — only routable venues.

**Body**: `{ "pair": "ADA-USDM" }`

---

## Stable health

### `POST /getStableHealth`

Composite per-stable: price + reserves + supply + liquidity-depth + risk-score + alerts. Sub-fetches in parallel; one failure degrades that section to null + alert, never 5xx.

**Body**: `{ "symbol": "USDM" }` (`USDM` | `DJED` | `iUSD` | `USDA` | `USDCx`)

Top-level fields: `price`, `pegDeviationBps`, `reserves`, `supply`, `liquidity`, `riskScore` (0..1 with per-component breakdown), `alerts[]` (string-stable IDs).

### `POST /getStableConvergence`

NxN cross-rate matrix across all 5 stables. Surfaces outliers + a `convergenceScore` ∈ [0, 1].

---

## OHLCV history

### `POST /getOhlcv`

Bucketed candles from `AggregatedPrices`. `sampleCount` = oracle observations in bucket (NOT trading volume — CHAINFEED is an aggregator, not a venue).

**Body**: `{ "pair": "ADA-USDM", "interval": "5m", "lookbackHours": 24 }`

Per-interval lookback caps so response ≤ 2000 candles: 1m→2h, 5m→24h, 15m→3d, 1h→14d, 4h→60d, 1d→365d. Empty buckets are NOT forward-filled.

---

## Audit pack

### `POST /getAuditPack`

Self-contained JSON envelope for one quote — per-file sha256 + on-chain tx hashes. Verifiable offline against any Cardano node, no CHAINFEED-specific tooling needed.

**Body**: `{ "quoteId": "<UUID from AggregatedPrices.ID>" }`

Format `chainfeed-audit-pack-v1`. Embedded README documents the consumer-side verification recipe.

---

## Lending markets

### `POST /getFluidtokensPools`

Snapshot every active FluidTokens v3 lender pool. Optional `asset` filter narrows to one principal-asset family.

**Body**: `{ "asset": "ADA" }` or omit for all.

### `POST /getFluidtokensLoans`

Same shape, every active loan.

### `POST /getFluidtokensHealth`

Per-asset rollup: pool count, total available principal, loan count, current debt (interest-accrued via finance.ak math), liquidatable count, late count.

**Body**: `{}` (no args)

### `POST /getLiqwidHealth`

Liqwid v2 stable lending markets (DJED, iUSD, USDM). Hybrid: on-chain MarketState datum reads (verifiable) + Liqwid GraphQL APY (closed-source contracts make rate-curve params opaque).

**Body**: `{}` (no args)

Per-market: `supplyRaw`, `principalRaw`, `reserveRaw`, `totalSuppliedRaw`, `qTokenRate`, `utilization`, `supplyAPY`, `borrowAPY`, `lqSupplyAPY`. `apySource` field tracks GraphQL-vs-onchain provenance.

---

## Peg-break alerts

Webhook subscriptions fire when `pegDeviationBps` crosses a threshold. HMAC-SHA256-signed POSTs over `${timestamp}.${body}`, headers `X-Chainfeed-Signature` + `X-Chainfeed-Timestamp`.

15-min cooldown + 0.5×-threshold rearm hysteresis to prevent storms. Worker (`srv/workers/peg-monitor.ts`) runs separately from the CAP server.

### `POST /subscribePegAlert`

**Body**:
```json
{
  "pair": "ADA-USDM",
  "thresholdBps": 50,
  "webhookUrl": "https://your.host/peg-hook",
  "ownerAddr": "addr1...",
  "validUntilHours": 24,
  "paymentTxHash": "<x402 confirmed tx>"
}
```

**Returns** `subscriptionId` + `hmacSecretHex` — secret returned **ONCE**, persist immediately.

Pricing: `priceForSubscription(thresholdBps, validUntilHours)` — base 0.5 USDM + hourly rate scaling inversely with threshold. 24h@5% = 0.74 USDM, 30d@0.1% = 360 USDM.

### `POST /listSubscriptions`

**Body**: `{ "ownerAddr": "addr1..." }` — all active subscriptions for that wallet.

### `POST /cancelSubscription`

**Body**: `{ "subscriptionId": "<UUID>", "ownerAddr": "addr1..." }` — cancels with ownership check. Returns 404 (not 401) on mismatch to avoid leaking subscription existence.

---

## Operations

### `POST /getServiceStatus`

Per-adapter cache snapshot — sourceName, ttlMs, cachedPairCount, per-pair age, last-error. Pure read of in-memory state; never triggers a fetch. Use for liveness dashboards.

### `POST /buildPaymentTx`

Build an unsigned x402 payment tx for any gated action. Free — buyer pays for the gated endpoint, not for the builder.

**Body**: `{ "buyerAddrBech32": "addr1...", "gatedAction": "getBestPrice" }`

Returns base64 unsigned CBOR + amount + receiver.

---

## Payment

x402 over HTTP. Wire-compatible with the [Masumi `scheme_exact_cardano` spec](https://github.com/masumi-network/x402-cardano/blob/main/specs/schemes/exact/scheme_exact_cardano.md).

### Pre-settle (one-shot calls)

1. `POST` to a gated endpoint without payment → server responds **402** with `accepts[]` listing requirements (amount, receiver, network, asset).
2. Build + sign Cardano tx covering the amount in USDM.
3. Re-`POST` with `X-PAYMENT` header containing base64 JSON wrapping base64 CBOR signed tx.
4. Server validates → settles → executes the gated action.
5. `X-PAYMENT-RESPONSE` header on success: base64 JSON `{success, network, transaction}`.

Replay protection: in-process nonce table (`X402PaymentNonces`, UNIQUE PK on tx hash) + on-chain double-spend rejection.

### Post-confirmed (subscriptions)

Pay first, reference the confirmed tx hash in `paymentTxHash`. Used for `subscribePegAlert`.

### Optional helper: `buildPaymentTx`

If your wallet doesn't construct Cardano txs natively, hit `/buildPaymentTx` with the action you want and the buyer address — get back an unsigned CBOR ready to sign.

---

## Response signing (optional)

When `CHAINFEED_SIGNING_PRIVATE_KEY_HEX` is set, every response is wrapped in an Ed25519 envelope:

```json
{
  "payload": { /* the original response */ },
  "signature": "<hex>",
  "keyId": "<ed25519-keyhash>",
  "signedAt": "2026-05-08T13:35:01Z"
}
```

Canonical-JSON sorting → deterministic signing bytes. Replay defense: `signedAt` is inside the signed payload. Same Ed25519 scheme Cardano stake-keys use.

---

## Coverage

5 USD-pegged Cardano stables (USDM, DJED, iUSD, USDA, USDCx) + ADA majors + Cardano-protocol pairs. Full pair table in [README](../README.md#coverage).

Pair list and source coverage are dynamic — `dexSourcesForPair(pair)` decides per-call. New oracle adapter = registry append.
