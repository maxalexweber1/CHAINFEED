# Quickstart

### Prerequisites

- Node.js 20+ (tested on 22)
- A Blockfrost project ID for the network you want to use ([blockfrost.io](https://blockfrost.io), free tier)

### Install

```bash
git clone https://github.com/<you>/chainfeed.git
cd chainfeed
npm install
```

The codebase is **TypeScript-only** under `srv/` and `scripts/`. CAP is wired to load `.ts` directly via `tsx`; the `npm run dev` / `npm run start` scripts set the right env. See [`CLAUDE.md`](CLAUDE.md).

### Provision a dev wallet (preprod)

```bash
npx tsx scripts/gen-wallet.ts
# → writes the mnemonic + bech32 addresses to .env.local (gitignored)
```

Faucet preprod tADA to the printed address from <https://docs.cardano.org/cardano-testnets/tools/faucet/>. ~5 ADA covers many test calls.

### Configure

Edit `.env.local`:

```bash
# ODATANO — preprod
NETWORK=preprod
BACKENDS=blockfrost
TX_BUILDERS=buildooor
BLOCKFROST_API_KEY=preprod_<YOUR_KEY>

# x402
X402_NETWORK=cardano:preprod
X402_USDM_NAME_HEX=0014df105553444d
# X402_USDM_POLICY filled in by mint-mock-usdm.ts
# X402_PAY_TO filled in by gen-wallet.ts

# Peg-alert webhook secret encryption key (AES-256-GCM, 32 bytes / 64 hex).
# Without this, the server stores webhook HMAC secrets in cleartext in dev
# and refuses to boot in production. Generate with:
#   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
CHAINFEED_SUBSCRIPTION_KEK_HEX=

```

### Mint mock-USDM (one-time, preprod only)

USDM is issued by [Mehen](https://mehen.io) on Cardano mainnet. There's no real preprod USDM, so for dev we mint our own native-script token with the same asset name hex (`0014df105553444d`) and decimals (6). Verifier code is identical; only the policy ID changes.

```bash
set -a && source .env.local && set +a
npx tsx scripts/mint-mock-usdm.ts
# → mints 1 000 000 mock-USDM, writes X402_USDM_POLICY into .env.local
```

### Run

```bash
set -a && source .env.local && set +a
npm run dev          # alias for `cds watch` with TS loader (CDS_TYPESCRIPT=1 + tsx)
```

Then in another terminal:

```bash
# Should return 402 with payment requirements
curl -i http://localhost:4004/odata/v4/price/Prices

# Multi-source aggregated quote (e2e: pays mock-USDM, calls DEXes, returns price)
npx tsx scripts/buyer-pay-and-fetch.ts \
  http://127.0.0.1:4004 /odata/v4/price/getBestPrice POST '{"pair":"ADA-USDM"}'

# Cross-DEX arbitrage opportunity
npx tsx scripts/buyer-pay-and-fetch.ts \
  http://127.0.0.1:4004 /odata/v4/price/getArbitrageOpportunities POST '{"pair":"ADA-USDM"}'
```