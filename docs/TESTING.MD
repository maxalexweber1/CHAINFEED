# TESTING 

## Running the tests

```bash
npx tsx scripts/test-x402-validate.ts          # 10/10
npx tsx scripts/test-x402-decode.ts            #  8/8
npx tsx scripts/test-x402-integration.ts       #  5/5
npx tsx scripts/test-orcfax-decode.ts          #  7/7
npx tsx scripts/test-orcfax-integration.ts     #  5/5
npx tsx scripts/test-charli3-decode.ts         # 15/15
npx tsx scripts/test-charli3-integration.ts    #  9/9
npx tsx scripts/test-aggregation.ts            # 35/35
npx tsx scripts/test-cache.ts                  #  8/8
```

Total: **102 unit + integration tests**, all passing.

`npm run typecheck` (`tsc --noEmit`) is also expected to be clean before any commit. The lock-down for the TS-only policy is `npm run check-no-js`, which fails if any tracked `srv/**/*.js` or `scripts/**/*.js` slips back in.

For live network checks (require BLOCKFROST_API_KEY in env):

```bash
npx tsx scripts/smoke-odatano.ts                # ODATANO bridge connection
npx tsx scripts/smoke-dex-adapters.ts           # Live ping of Minswap + SundaeSwap + DexHunter
npx tsx scripts/smoke-charli3.ts                # Verify Charli3 oracle feeds on the configured network
                                                # (NETWORK=mainnet|preprod, optional pair filter args)
```

## Live e2e on chain

`scripts/buyer-pay-and-fetch.ts` is the buyer half of the x402 flow. It uses the same dev wallet as the receiver — buyer == seller is fine for proving wire compatibility, since the middleware only inspects what's on-chain.

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
