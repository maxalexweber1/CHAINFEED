# CHAINFEED

> Oracle aggregator with x402 payment settlement.
> Built as CAP Service on top of [ODATANO](https://github.com/ODATANO/ODATANO).

> 🚧 Hackathon project — under active development.

---

## What

AI Agends & Modern Buisnesses need fresh & reliable Data. CHAINFEED bundles & aggregates all kind of Oracle Data into a single API where calls can be paid via [x402](https://www.x402.org) micropayments in USDM.    

### Avalible Feeds

All exposed at `/odata/v4/price` via `POST /getBestPrice`. Pairs are routed to whatever source supports them; the response carries `sourcesUsed` and `confidence` so consumers can tell multi-source from single-source.

| Pair       | Sources                                                | Notes |
|---|---|---|
| ADA-USD    | Orcfax + Charli3 + Minswap                             | multi-source median |
| ADA-USDM   | Orcfax + Charli3 + SundaeSwap V3 + DexHunter           | multi-source median; Charli3 inverts on-chain USDM/ADA |
| BTC-ADA    | Charli3 (mainnet)                                      | single-source — confidence capped at 0.5 |
| NIGHT-ADA  | Charli3 (mainnet)                                      | single-source — confidence capped at 0.5 |
| BTC-USD    | Charli3 (preprod)                                      | single-source — confidence capped at 0.5 |
| FACT-ADA, CBLP-ADA, SNEK-ADA, MIN-ADA, IAG-ADA, LQ-ADA, ADA-DJED, ADA-iUSD | Orcfax (mainnet) | single-source — confidence capped at 0.5 |


## Coming Soon

More Feeds and a Marketplace where any wallet can register its own feed and earn USDM directly from each consumer call (90/10 split, no contracts, no API keys, no accounts).

## Why this matters

Cardano oracle data lives on-chain in eUTxOs that require deep blockchain knowledge to consume. CHAINFEED makes that data accessible via standardized HTTP APIs with native pay-per-call billing so *no API keys, no accounts, no contracts* are needed. A cardano wallet plus an HTTP client is the entire stack a consumer needs.

### What works today

**Paid endpoints, all gated by x402 USDM micropayments:**

| OData action / entity | Price (raw) | What it returns |
|---|---|---|
| `GET /Prices` | 10 000 (0.01 USDM) | Aggregated price history (paginated OData) |
| `GET /Sources` | 10 000 (0.01 USDM) | Per-source audit rows (price, txHash, source) |
| `POST /getBestPrice` | 10 000 (0.01 USDM) | Multi-source aggregated price + confidence + deviation |
| `POST /getArbitrageOpportunities` | 50 000 (0.05 USDM) | Best-buy / best-sell DEX, spread%, profitable flag |
| `POST /getTWAP` | 20 000 (0.02 USDM) | Time-weighted average over a window from history |

**Free endpoints (always exempt):**

- `GET /odata/v4/price/$metadata` OData schema to explore possible endpoints

**Wire surface:**

- HTTP 402 + `accepts[]` body wire-compatible with the [Masumi `scheme_exact_cardano` spec](https://github.com/masumi-network/x402-cardano/blob/main/specs/schemes/exact/scheme_exact_cardano.md).
- `X-PAYMENT` header → base64 JSON wrapping a base64 CBOR signed Cardano tx.
- `X-PAYMENT-RESPONSE` header on success → base64 JSON `{success, network, transaction}`.
- Replay protection at two layers: in-process nonce table (`X402PaymentNonces`, UNIQUE PK on tx hash) and on-chain double-spend rejection by Cardano itself.

**Sources active:**

- **Orcfax v1** (on-chain, via ODATANO/Blockfrost) — Plutus `Datum<Statement<Rational>>` decoder. Mainnet/preview/preprod aware.
- **Charli3** (on-chain, via ODATANO/Blockfrost) — handles both contract families: legacy (`OracleFeed` NFT, mainnet) and ODV (`C3AS` NFT, preprod). PlutusMap datum decoder with dynamic `precision` field, expiry-based staleness, automatic pair inversion for `ADA-USDM`. Live-verified end-to-end on 2026-04-30 (see [`docs/research/charli3-feeds.md`](docs/research/charli3-feeds.md) §7.6).
- **Minswap** (REST) — `ADA-USD` via `agg-api.minswap.org/aggregator/ada-price`.
- **SundaeSwap V3** (GraphQL) — `ADA-USDM` via `pools.byPair`, deepest-reserve pool selection, dust-pool filter.
- **DexHunter** (REST) — `ADA-USDM` via `swap/estimate`, multi-DEX routed, optional `X-Partner-Id` env var.

**Confidence semantics:** `aggregate()` returns coefficient-of-variation-derived confidence in `[0, 1]`. When only one source survives the fanout (Charli3-only or Orcfax-only pairs), confidence is capped at `SINGLE_SOURCE_CONFIDENCE_CAP = 0.5` — a degraded fanout is not the same as a verified observation, and consumers should be able to tell the two apart from the response alone.

### Live e2e proofs on preprod

| Action | Tx hash |
|---|---|
| Faucet → wallet | `6b9a421d9cc0117ad71c2bab0b9d9a8d4078de06ae5bd93a7146352a1eca9070` |
| Mock-USDM mint  | `06ca13439891f77d4f4b0a8cc94073e3cd25cf83cd8c8e1e5c824651dfb1b7a6` |
| Paid `/Prices` read | `b03860882b8259561c64c0e2317ca3373be6b4e7ba0c9890df29d51ed7e17001` |
| Paid `/getBestPrice` (2 sources) | `d56478b6109b902cef5e0629a2e317fbfc478994daf4dcb4d5571288152bffab` |
| Paid `/getArbitrageOpportunities` | `193146c744014768381ca6473b0793cc40fe9e3fe28adbdee55f144b2fe0b01b` |

## Architecture

```
                                        ┌──────────────────────────────────────────┐
┌──────────┐ 402 + paymentRequirements  │              CHAINFEED (CAP)             │
│  Buyer   │ ◄──────────────────────────│                                          │
│ (Lace,   │                            │  ┌────────────────────────────────────┐  │
│  agent,  │ X-PAYMENT (signed CBOR)    │  │  srv/middleware/x402.ts            │  │
│  bot…)   │ ─────────────────────────► │  │   decode → validate → settle ──────┼──┼─► Cardano
└──────────┘                            │  │   → claim nonce → audit            │  │  via ODATANO
                                        │  └─────────────┬──────────────────────┘  │  bridge
                                        │                │ next()                  │
                                        │  ┌─────────────▼──────────────────────┐  │
                                        │  │  PriceService                      │  │
                                        │  │   getBestPrice                     │  │
                                        │  │   getArbitrageOpportunities        │  │
                                        │  │   getTWAP                          │  │
                                        │  └────────┬────────────────┬──────────┘  │
                                        │           │                │             │
                                        │  ┌────────▼─────┐ ┌────────▼──────────┐  │
                                        │  │ aggregation  │ │ adapters/registry │  │
                                        │  │  median/conf │ │   ├── orcfax──────┼──┼─► Cardano (Orcfax FS UTxO)
                                        │  │  +1-src cap  │ │   ├── charli3─────┼──┼─► Cardano (Charli3 OracleFeed/C3AS UTxO)
                                        │  │  twap/devPct │ │   ├── minswap─────┼──┼─► api-mainnet-prod.minswap.org
                                        │  └──────────────┘ │   ├── sundaeswap──┼──┼─► api.sundae.fi/graphql
                                        │                   │   └── dexhunter───┼──┼─► api-us.dexhunterv3.app
                                        │                   └───────┬───────────┘  │
                                        │                           │ withCache()  │
                                        │                   ┌───────▼──────────┐   │
                                        │                   │ srv/lib/cache.ts │   │
                                        │                   │ stale-while-     │   │
                                        │                   │ revalidate, dedup│   │
                                        │                   └──────────────────┘   │
                                        └──────────────────────────────────────────┘
```

## STACK

- **CAP** ([SAP Cloud Application Programming Model](https://cap.cloud.sap)) provides the OData V4 + REST surface, the CDS data model, and the Express middleware integration point.
- **ODATANO** ([@odatano/core](https://www.npmjs.com/package/@odatano/core)) is the Cardano integration layer — Blockfrost/Koios/Ogmios with circuit-breaker failover and CSL bindings. CHAINFEED uses ODATANO's *programmatic* API (`initialize` + `getCardanoClient`) rather than its CDS services, since we're an in-process consumer (see [`docs/research/odatano-capabilities.md`](docs/research/odatano-capabilities.md)).
- **x402** is implemented in-process: no external facilitator. Wire-compatible with the Masumi spec for forward swap. See [`docs/adr/0001-x402-impl.md`](docs/adr/0001-x402-impl.md).
- **Aggregation** is pure functional — `median(values)`, `confidence(values)` from coefficient-of-variation, `deviationPct(values)` as max-min spread, `twap(samples, start, end)` with per-sample weighting.
- **Cache** is internal (no `node-cache` dep), stale-while-revalidate with in-flight Promise dedup so a hot pair never produces concurrent upstream calls.

## License

Apache-2.0 See [`LICENSE`](LICENSE)


