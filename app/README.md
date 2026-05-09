# CHAINFEED frontend

Public Cardano-stablecoin transparency portal. Next.js 15 App Router, RSC
server-fetches the CHAINFEED CAP service for live data.

## Setup

```bash
cd app
npm install
```

Point at the running CAP service:

```bash
# default — assumes CAP server at the same host
export NEXT_PUBLIC_CHAINFEED_BASE_URL=http://localhost:4004

# or for prod / staging
export NEXT_PUBLIC_CHAINFEED_BASE_URL=https://chainfeed.example.com
```

## Run

```bash
# dev with hot reload
npm run dev

# typecheck
npm run typecheck

# production build
npm run build && npm start
```

The CAP server (`npm run dev` from the repo root) must be running at
`NEXT_PUBLIC_CHAINFEED_BASE_URL` for the dashboard to load data.

## Pages

| Route | What it shows |
|---|---|
| `/` | Home — 5-stable health overview grid |
| `/[symbol]` | Per-stable detail — price, reserves, OHLCV chart, supply, liquidity, risk components, paid actions |
| `/developers` | API catalog + x402 buyer flow |
| `/agents` | Agentic patterns (treasury risk, allocation bot, audit agent) + tool-use snippet |
| `/trust` | Verification model — on-chain provenance, audit-pack recipe, response signing |

## Data fetching

All pages are **React Server Components**. Free CHAINFEED endpoints
(`getStableHealth`, `getOhlcv`, `getServiceStatus`) are called server-side
during render with `next: { revalidate: 30 }`. Paid endpoints
(`getAuditPack`, `getBestPrice`, etc.) are described in the UI but never
called from the dashboard — those are agent-flow paths and require the
`X-PAYMENT` x402 wire flow which lives in a separate buyer SDK.

The thin SDK at `src/lib/chainfeed-client.ts` mirrors `srv/price-service.cds`
type shapes. CAP returns decimal-shaped strings; the SDK coerces them to
numbers at the boundary.

## Stack

- Next.js 15 (App Router, RSC)
- React 19
- TypeScript 5.6 strict
- Tailwind CSS v4 (`@import "tailwindcss"`, no JS config)
- Recharts 2.13 (OHLCV chart only — single client component)

No shadcn/ui, no auth, no state library. Plain Tailwind + RSC + lightweight
helpers in `chainfeed-client.ts`. Add complexity only if a feature requires
it.
