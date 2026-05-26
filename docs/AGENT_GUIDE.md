# CHAINFEED for Agents

CHAINFEED's primary consumer is **agents**, not human developers writing HTTP
calls by hand. This doc covers the surface: the MCP server, the tool catalog,
three reference agents that ship in this repo, and the integration pattern
for building your own.

---

## TL;DR

```bash
# 1. Run CHAINFEED + the MCP HTTP facade
npm run dev          # :4004  CHAINFEED OData
npm run mcp:http     # :4005  MCP streamable-HTTP, points at :4004

# 2. Pick a reference agent
npm run agent:qa         # natural-language Q&A REPL (needs ANTHROPIC_API_KEY)
npm run agent:dashboard  # live terminal dashboard
npm run agent:watcher    # background sink to Discord/Telegram
```

All three connect to the SAME MCP server with the SAME tool catalog. Pick
the one that matches your interaction model.

---

## Why MCP, not raw OData

CHAINFEED's OData surface is documented in [`API.md`](API.md). It's perfectly
fine for hand-written HTTP clients, but it's not ideal for LLM-driven agents:

- Each tool's "when to use this vs. its neighbour" semantics live in prose
  comments that don't survive the JSON wire format.
- Auth + 402 + retry boilerplate eats context.
- Tool discovery requires reading `$metadata`.

The MCP server (`srv/mcp/`) wraps the OData surface in a curated tool
catalog with explicit routing intent baked into each tool's `description`
field. LLMs pick the right tool from those descriptions; agent code just
calls `mcp.callTool({name, arguments})` and gets a JSON result.

x402-gated actions are handled transparently: a paid action returns a
structured `paymentRequired` result with the `buildPaymentTx` hint, so
wallet-equipped agents can pay-then-retry without breaking flow.

---

## The MCP server

Implementation: `srv/mcp/tools.ts` (registry) + `srv/mcp/server.ts` (stdio)
+ `srv/mcp/http.ts` (streamable HTTP). Both transports share the same
8 curated tools.

### Run

| Transport | Command | Use for |
|---|---|---|
| **stdio** | `npm run mcp` | Local LLM clients (Claude Code, Claude Desktop) that spawn the server as a subprocess |
| **streamable-HTTP** | `npm run mcp:http` | Remote agents over the network; also what the three reference agents in this repo use |

stdio uses **stdout** as the JSON-RPC wire — never log to stdout when
extending the stdio server. The pino logger in `srv/lib/log.ts` writes to
stderr for exactly this reason.

### Tool catalog

| Tool | Returns | x402-gated |
|---|---|---|
| `assess_stable` | Verdict (`ok` / `caution` / `alert`) + reasons + suggested actions for one stable. **Start here** for "is X safe?" | no |
| `get_stable_health` | Raw numeric breakdown — peg-bps, reserves, supply, liquidity, risk-score components | no |
| `get_best_price` | Aggregated median price across oracles + DEXes for a pair | **yes** |
| `get_stable_convergence` | NxN cross-rate matrix + basket convergence score | no |
| `get_arbitrage` | Best buy/sell venue + spread for a pair | **yes** |
| `get_ohlcv` | Candle history. `sampleCount` = oracle observations (not volume) | no |
| `get_lending_health` | FluidTokens v3 + Liqwid v2 rollup | no |
| `get_service_status` | Per-adapter cache + liveness snapshot | no |

Routing-intent prose lives in `description` on each tool — open
`srv/mcp/tools.ts` for the canonical wording.

### Register with Claude Code / Desktop (stdio)

`.mcp.json`:

```json
{
  "mcpServers": {
    "chainfeed": {
      "command": "npm",
      "args": ["run", "mcp"],
      "env": { "CHAINFEED_BASE_URL": "http://127.0.0.1:4004" }
    }
  }
}
```

Use `127.0.0.1`, not `localhost` — Node 18+ resolves `localhost` to `::1`
first and CAP only binds IPv4, so `fetch` from the MCP server to CHAINFEED
silently fails with `localhost`.

---

## Three reference agents

All three live under `agents/` and share `agents/shared/` (typed MCP client,
poll-loop driver, pino logger, types). They're shaped to show three
distinct agent-consumer patterns.

### 1. CLI Q&A (`agents/cli-qa/`) — natural language

```bash
npm run agent:qa
```

Needs `ANTHROPIC_API_KEY` in your `.env`. Defaults to Haiku 4.5; override
with `ANTHROPIC_MODEL=claude-opus-4-7` if you want.

What it shows: an LLM (Claude) deciding which tool to call and feeding the
result back through a conversation. This is the **canonical agent shape** —
user asks a question in plain English, the agent picks tools, executes
them, summarizes.

Try:
- `is USDM safe?`
- `whats the peg deviation on iUSD?`
- `are all stables holding peg right now?`
- `give me ADA-USDM 1h candles for the last 6 hours`

stderr shows the tool calls inline so you can see the routing:
```
> is USDM safe?
  🔧 assess_stable({"symbol":"USDM"})

USDM is in caution — 0.20% above peg with a reserves attestation older
than 7 days (via assess_stable).
```

Prompt caching is on by default; subsequent turns show
`· N cached + M fresh input tokens` on stderr.

### 2. Dashboard (`agents/dashboard/`) — read-only TUI

```bash
npm run agent:dashboard
```

Terminal UI built with `ink`. Polls every 30s; press `r` to refresh now,
`q` to quit. No LLM, no API key, no external sinks — pure observability.

What it shows: agents don't have to be LLM-driven. Any client that
consumes the MCP tool surface qualifies. The dashboard is the **dev
surface** during the hackathon — you tail this while iterating on
adapters or stable-assessment logic.

### 3. Watcher (`agents/watcher/`) — push notifications

```bash
DISCORD_WEBHOOK_URL=... TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... \
  npm run agent:watcher
```

Polls all 5 stables on a 60s loop, diffs each fresh assessment against the
last persisted observation (`state.json`), fires `🔻 degraded` / `🟢
recovered` / `⚠️ same-verdict-new-reasons` events to all configured sinks
(stdout always; Discord + Telegram opt-in via env-vars).

What it shows: an **always-on background consumer**. Demonstrates state
diffing, sink isolation (one sink failing doesn't block the others), and
the heartbeat-to-`/health` mechanism that lets CHAINFEED's health endpoint
report watcher liveness across process boundaries.

Architecture details + the diff/sink layer: `agents/watcher/diff.ts`,
`agents/watcher/sinks/*.ts`.

---

## Adding your own agent

Pattern that works for any consumer (LLM-driven or rule-based):

1. **Connect.** Use the MCP TypeScript SDK directly (`@modelcontextprotocol/sdk`)
   if you want raw flexibility, or the typed wrapper at
   `agents/shared/chainfeed-client.ts` for `assessStable` / `getServiceStatus`
   / `getStableConvergence` / `getLendingHealth` with proper types.

2. **Discover.** Call `mcp.listTools()` once at startup — descriptions
   include the routing intent.

3. **Call.** `await mcp.callTool({name, arguments})`. The result is
   `{content: [{type:'text', text:'<json>'}], isError}`. JSON-parse the
   `text`.

4. **Handle x402.** A 402-gated action returns `isError: false` (it's an
   actionable state, not an error) with a `paymentRequired: true` field
   and `hint` describing the `buildPaymentTx` handoff. Surface to the
   user; don't pay automatically unless your agent has a wallet and an
   explicit budget.

5. **Log structured.** Reuse `agents/shared/log.ts` — pino, stderr-only
   (so stdout stays clean for any wire protocol you add), pretty in dev,
   JSON in prod.

Minimal example, using the typed wrapper:

```ts
import { connectMcp } from '../shared/chainfeed-client.js';

const mcp = await connectMcp({ url: 'http://127.0.0.1:4005/mcp' });
const assessment = await mcp.assessStable('USDM');
console.log(`${assessment.symbol}: ${assessment.verdict}`);
console.log(`headline: ${assessment.headline}`);
await mcp.close();
```

Or use the raw SDK if you need tools beyond the typed wrapper:

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const client = new Client({ name: 'my-agent', version: '0.0.1' });
await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:4005/mcp')));
const { tools } = await client.listTools();
const result = await client.callTool({ name: 'get_lending_health', arguments: {} });
```

---

## Shared infrastructure

The three reference agents are deliberately thin — most of the wiring is
in `agents/shared/`, reusable for whatever you build next:

```
agents/shared/
├── chainfeed-client.ts   typed MCP wrapper (assessStable, ...)
├── poll-loop.ts          generic interval driver with backoff + AbortSignal
├── types.ts              StableSymbol, StableAssessment etc. (re-exported from srv/)
└── log.ts                pino logger, stderr-only, pretty/json by env
```

If you find yourself reaching for these in your own agent, just import
them — `agents/` is scoped ESM (`agents/package.json` sets `type: module`),
so the imports use `.js` extensions even though the source is `.ts`.

---

## On-chain consumption is a separate path

If you want to **verify** CHAINFEED quotes inside a Cardano smart contract
rather than consume them off-chain, see the Aiken library at
`contracts/lib/chainfeed.ak`. That's a different consumption shape (DApp
on-chain) than the agent surface this doc covers. They coexist — the same
signing key signs both the off-chain envelope and the on-chain payload.

Reference DApp: `validators/stop_loss.ak` + demo flow at
`scripts/demo-aiken-flow.ts`.
