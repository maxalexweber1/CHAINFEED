# TESTING

## Running the tests

All tests are TypeScript under `scripts/test-*.ts`, executed via `tsx`.
Each file is self-contained with a tiny inline runner (`ok` / `FAIL` per
case, exit code 0/1).

```bash
# x402 payment-flow + wire compatibility
npx tsx scripts/test-x402-validate.ts          # 10/10 (validation rules)
npx tsx scripts/test-x402-decode.ts            #  8/8  (header decoding)
npx tsx scripts/test-x402-integration.ts       #  5/5  (settle + claim flow)
npx tsx scripts/test-verify-confirmed.ts       # 17/17 (post-confirmed-tx-hash + subscription pricing)
npx tsx scripts/test-response-signing.ts       # 19/19 (Ed25519 sign+verify, canonical-json, replay)

# Oracle adapters
npx tsx scripts/test-orcfax-decode.ts          #  7/7
npx tsx scripts/test-orcfax-integration.ts     #  5/5

# DEX adapters (direct pool reads, no aggregator)
npx tsx scripts/test-minswap-v2.ts             # 14/14 (paginated Koios, asset-name disambig, sanity band)
npx tsx scripts/test-wingriders-stableswap.ts  # 15/15 (stable-stable reserve-ratio adapter)

# Reserve / collateral attestation adapters
npx tsx scripts/test-djed-reserves.ts          # 11/11 (mock bridge + fetch, CIP-68 pre-mint math)
npx tsx scripts/test-indigo-cdp.ts             # 17/17 (CDP datum decoder + multi-iAsset)
npx tsx scripts/test-circle-usdc-attestation.ts # 12/12 (URL discovery, PDF magic-bytes, sha256)

# Aggregation + caching + service composition
npx tsx scripts/test-aggregation.ts            # 41/41 (median, confidence, deviation, twap, pegDeviationBps)
npx tsx scripts/test-cache.ts                  # 11/11 (stale-while-revalidate, in-flight dedup)
npx tsx scripts/test-stable-metadata.ts        # 17/17 (registry shape + lookups)
npx tsx scripts/test-stable-risk-score.ts      # 37/37 (pure-fn weighted composite)
npx tsx scripts/test-stable-health.ts          # 12/12 (orchestration + graceful degradation)
npx tsx scripts/test-liquidity-depth.ts        # 20/20 (merged-pool constant-product, multi-pool merge, fee-band)
npx tsx scripts/test-stable-convergence.ts     # 14/14 (NxN cross-rate matrix, outlier detection)

# Composite endpoints
npx tsx scripts/test-ohlcv.ts                  # 17/17 (interval bucketing, candle math)
npx tsx scripts/test-audit-pack.ts             # 21/21 (envelope shape, sha256 round-trip, tamper-detect)
npx tsx scripts/test-alert-detector.ts         # 22/22 (hysteresis, HMAC sign+verify, replay)
```

Total: **376 unit + integration tests across 24 files**, all passing.

`npm run typecheck` (`tsc --noEmit`) is also expected to be clean before
any commit. The lock-down for the TS-only policy is `npm run check-no-js`,
which fails if any tracked `srv/**/*.js` or `scripts/**/*.js` slips back in.

## Live smokes

These hit real upstream services and require network access. Most also
require `BLOCKFROST_API_KEY` in env (sourced from `.env.local`).

```bash
# HTTP-only — no chain reads
npx tsx scripts/smoke-dex-adapters.ts          # Minswap + Minswap V2 + SundaeSwap + WingRiders live (22 tests)
npx tsx scripts/smoke-circle-attestation.ts    # Circle USDC monthly PDF: HTML scrape + fetch + sha256
npx tsx scripts/smoke-liquidity-depth.ts       # Direct-pool merged-CP sweep across all 5 stables (mainnet)
npx tsx scripts/smoke-wingriders-stableswap.ts # Stable-stable reserve-ratio cross-rates

# Chain-dependent — need bridge configured
npx tsx scripts/smoke-odatano.ts               # ODATANO bridge connection ping
npx tsx scripts/smoke-djed-reserves.ts         # Coti DJED reserve script: ADA collateral + coverage ratio (mainnet)
npx tsx scripts/smoke-indigo-cdp.ts            # Indigo CDP aggregator: ~500 CDPs via Koios (mainnet)
npx tsx scripts/smoke-minswap-v2.ts            # Minswap V2 direct pool reads (paginated Koios, mainnet)

# Run everything
npm run smoke                                  # all live smokes
                                               # SKIP_CHAIN_SMOKES=1 / SKIP_HTTP_SMOKES=1 to scope
```

### Mainnet-only smokes — temporary package.json patch

DJED reserves, Indigo CDP, and Minswap V2 read mainnet on-chain state.
The bridge resolves network from `cds.requires["odatano-core"]` in
`package.json`, and `process.env.NETWORK` does NOT override it (CAP
config precedence). For mainnet smoke runs:

```bash
# 1. Patch package.json: "network" → "mainnet", add "koios" to backends
# 2. Run the smoke
# 3. Revert the patch
```

Minswap V2 + Indigo CDP + liquidity-depth all use bridge-backed
credential queries which are **Koios-only** in @odatano/core 1.7.6 —
`koios` must be in `backends`.

## Live e2e on chain

`scripts/buyer-pay-and-fetch.ts` is the buyer half of the x402 flow. It
uses the same dev wallet as the receiver — buyer == seller is fine for
proving wire compatibility, since the middleware only inspects what's
on-chain.

```
[1/4] POST http://127.0.0.1:4004/odata/v4/price/getBestPrice  (no X-PAYMENT)
      → 402, requirements:
        asset:   <mock-USDM policy>
        amount:  10000  (= 0.01 USDM)
        payTo:   addr_test1q…
        network: cardano-preprod
[2/4] building + signing payment tx via ODATANO bridge ...
      → tx hash: d56478b6109b902cef5e0629a2e317fbfc478994daf4dcb4d5571288152bffab
[3/4] POST  (with X-PAYMENT, 816B)
[4/4] assert response
      status: 200
      X-PAYMENT-RESPONSE: {"success":true,"network":"cardano-preprod","transaction":"d56478b6…"}
      response body:
        {"pair":"ADA-USDM",
         "price":0.24432192018223264,
         "confidence":0.986964527684575,
         "sourcesUsed":2,
         "deviationPct":1.8434941740413004,
         "auditTxHashes":[]}
```

`sourcesUsed` varies by pair and configured network — on mainnet
ADA-USDM aggregates over orcfax + sundae + minswap-v2 + wingriders
(4 sources), on preprod the orcfax on-chain oracle dominates since
most DEXes are mainnet-only.
