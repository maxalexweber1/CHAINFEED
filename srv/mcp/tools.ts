/**
 * CHAINFEED MCP tool registry — transport-agnostic.
 *
 * Each tool is a thin client over CHAINFEED's OData V4 actions: it POSTs to
 * `/odata/v4/price/<action>` and shapes the response for an agent. The same
 * registry backs both transports:
 *   - stdio  (srv/mcp/server.ts)      — local agents / Claude Code / Desktop
 *   - HTTP   (srv/mcp/http.ts)        — remote agents, streamable transport
 *
 * Why an HTTP client and not in-process `srv.send`: it keeps the MCP layer a
 * pure facade (no CAP boot in the process), it exercises the exact same code
 * path a paying consumer hits, and x402 falls out for free — a gated action
 * returns HTTP 402 with the requirements, which we surface as a structured
 * `paymentRequired` result the agent can act on (build → sign → retry).
 *
 * The `fetch` impl is injectable so the registry is unit-testable without a
 * running server (see scripts/test-mcp-tools.ts).
 */

import { z } from 'zod';

const ODATA_PATH = '/odata/v4/price';

export type FetchLike = (input: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}) => Promise<{
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface ChainfeedToolContext {
  /** Base URL of a running CHAINFEED OData service, no trailing slash. */
  baseUrl: string;
  fetchImpl: FetchLike;
}

/** Outcome of a single tool invocation, before transport-specific shaping. */
export interface ToolRunResult {
  ok: boolean;
  /** True when the underlying action is x402-gated and payment is owed. */
  paymentRequired?: boolean;
  data?: unknown;
  error?: string;
}

export interface ChainfeedTool {
  name: string;
  description: string;
  /** Zod raw shape — empty object for no-arg tools. */
  inputSchema: z.ZodRawShape;
  run(args: Record<string, unknown>, ctx: ChainfeedToolContext): Promise<ToolRunResult>;
}

/** Resolve a tool context from env, allowing overrides (tests inject fetch). */
export function makeContext(overrides: Partial<ChainfeedToolContext> = {}): ChainfeedToolContext {
  const baseUrl = (overrides.baseUrl ?? process.env.CHAINFEED_BASE_URL ?? 'http://localhost:4004')
    .replace(/\/$/, '');
  const fetchImpl = overrides.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  if (!fetchImpl) throw new Error('no fetch implementation available (Node < 18?) — inject one via makeContext');
  return { baseUrl, fetchImpl };
}

/** Strip OData metadata keys and unwrap the `{ value: ... }` envelope. */
function unwrapODataPayload(json: unknown): unknown {
  if (json === null || typeof json !== 'object') return json;
  const obj = json as Record<string, unknown>;
  const keys = Object.keys(obj).filter(k => !k.startsWith('@'));
  if (keys.length === 1 && keys[0] === 'value') return obj.value;
  if (keys.length === Object.keys(obj).length) return obj;          // no @-keys to strip
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = obj[k];
  return out;
}

/** POST an unbound OData action and normalise the result + x402 handling. */
async function callAction(
  ctx: ChainfeedToolContext,
  action: string,
  params: Record<string, unknown>,
): Promise<ToolRunResult> {
  const url = `${ctx.baseUrl}${ODATA_PATH}/${action}`;
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await ctx.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
    });
  } catch (e) {
    return { ok: false, error: `network error calling ${action}: ${(e as Error)?.message ?? e}` };
  }

  if (res.status === 402) {
    let requirements: unknown = null;
    try { requirements = await res.json(); } catch { /* body optional */ }
    return {
      ok: false,
      paymentRequired: true,
      data: {
        action,
        requirements,
        hint: `'${action}' is x402-gated. Call buildPaymentTx(gatedAction='${action}') to get an `
            + `unsigned payment tx, sign it with your wallet, then retry this action with the signed `
            + `X-PAYMENT envelope.`,
      },
    };
  }

  if (!res.ok) {
    let body = '';
    try { body = await res.text(); } catch { /* ignore */ }
    return { ok: false, error: `${action} failed: HTTP ${res.status} ${body.slice(0, 300)}` };
  }

  let json: unknown;
  try { json = await res.json(); } catch { return { ok: false, error: `${action}: response was not valid JSON` }; }
  return { ok: true, data: unwrapODataPayload(json) };
}

const STABLE_SYMBOLS = 'USDM, DJED, iUSD, USDA, USDCx';

/**
 * Curated agent-facing tool set. Not every OData action — just the ones an
 * agent reasons with. Descriptions carry the routing intent (when to pick
 * this tool over a neighbour) — that's the part that makes tool selection work.
 *
 * Each description follows the same shape so an LLM can parse it uniformly:
 *   1. One-line "what you get"
 *   2. "USE FOR …" — the trigger phrases / natural-language question shapes
 *   3. "NOT FOR …" — the disambiguation against sibling tools (where relevant)
 *   4. Inputs / examples / x402-gating notes
 */
export const CHAINFEED_TOOLS: ChainfeedTool[] = [
  {
    name: 'assess_stable',
    description:
      'Actionable verdict on ONE Cardano stablecoin: ok | caution | alert, with reasons and '
      + 'suggested next actions. '
      + 'USE FOR yes/no questions like "is USDM safe?", "is DJED depegging?", "should I worry about iUSD?" — '
      + 'it collapses price, peg-deviation, reserves, freshness, and risk into one decision so the '
      + "caller doesn't reason about raw thresholds. "
      + 'NOT FOR raw numbers (use get_stable_health) or basket-level questions (use get_stable_convergence). '
      + `Symbols: ${STABLE_SYMBOLS}. `
      + 'Returns string-stable `verdict`, `reasonCodes`, `suggestedActions`, plus `assessmentConfidence` '
      + '(trust in the verdict) separately from `riskScore` (health of the stable), and a full `detail` block.',
    inputSchema: { symbol: z.string().describe(`Stablecoin symbol, one of: ${STABLE_SYMBOLS}`) },
    run: (args, ctx) => callAction(ctx, 'assessStable', { symbol: String(args.symbol ?? '') }),
  },
  {
    name: 'get_stable_health',
    description:
      'Detailed numeric breakdown for ONE stablecoin: aggregated price, peg-deviation in bps, '
      + 'reserves (source / coverage / age), supply, liquidity depth, and the four risk-score '
      + 'components individually. '
      + 'USE FOR specific-number questions: "what\'s the peg deviation?", "how old is the reserve '
      + 'attestation?", "what\'s the liquidity depth?". '
      + 'NOT FOR yes/no safety questions — assess_stable already returns this data PLUS a verdict, '
      + 'so prefer it unless the caller explicitly wants the raw numbers without a judgment. '
      + `Symbols: ${STABLE_SYMBOLS}.`,
    inputSchema: { symbol: z.string().describe(`Stablecoin symbol, one of: ${STABLE_SYMBOLS}`) },
    run: (args, ctx) => callAction(ctx, 'getStableHealth', { symbol: String(args.symbol ?? '') }),
  },
  {
    name: 'get_best_price',
    description:
      'Aggregated multi-source oracle price for a trading pair: median across oracles + DEXes that '
      + 'cover it, with a confidence score and peg-deviation (when one side is a USD-pegged stable). '
      + 'USE FOR "what is X worth right now?", "ADA-USD price", "how much is DJED in ADA?". '
      + 'NOT FOR per-venue dislocation (use get_arbitrage) or stablecoin safety (use assess_stable). '
      + 'Pair convention X-Y = "Y per 1 X". Examples: ADA-USD, ADA-USDM, ADA-DJED, NIGHT-ADA. '
      + '**x402-gated** (paid endpoint — call buildPaymentTx first if you don\'t already hold a payment receipt).',
    inputSchema: { pair: z.string().describe('Pair name, e.g. ADA-USD or ADA-USDM') },
    run: (args, ctx) => callAction(ctx, 'getBestPrice', { pair: String(args.pair ?? '') }),
  },
  {
    name: 'get_stable_convergence',
    description:
      'NxN cross-rate matrix across all USD-pegged Cardano stables (derived through an ADA pivot), '
      + 'plus a single `convergenceScore` in [0,1] and per-stable outlier flags. '
      + 'USE FOR basket-level questions: "are all the stables holding peg?", "which stable is the '
      + 'outlier right now?", "is the Cardano stablecoin market under stress?". '
      + 'NOT FOR a single stable\'s verdict (use assess_stable for that).',
    inputSchema: {},
    run: (_args, ctx) => callAction(ctx, 'getStableConvergence', {}),
  },
  {
    name: 'get_arbitrage',
    description:
      'Best buy and best sell venue for a pair across DEXes, with the spread in bps and whether the '
      + 'trade is profitable after a typical 0.3% fee. '
      + 'USE FOR cross-venue dislocation: "where can I trade ADA-USDM cheapest?", "is there an arb '
      + 'opportunity?", "what\'s the spread between DEXes for X?". '
      + 'NOT FOR the aggregate median price (use get_best_price). '
      + '**x402-gated** (paid endpoint).',
    inputSchema: { pair: z.string().describe('Pair name, e.g. ADA-USDM') },
    run: (args, ctx) => callAction(ctx, 'getArbitrageOpportunities', { pair: String(args.pair ?? '') }),
  },
  {
    name: 'get_ohlcv',
    description:
      'OHLCV candle history for a pair. Intervals: 1m, 5m, 15m, 1h, 4h, 1d (server caps lookback '
      + 'per interval so responses stay ≤ 2000 candles). '
      + 'USE FOR historical / charting questions: "what did ADA-USD do today?", "show me ADA-USDM '
      + '1h candles for the last 3 days", building a chart. '
      + 'IMPORTANT: `sampleCount` per bucket is the number of oracle OBSERVATIONS — NOT traded '
      + 'volume (CHAINFEED aggregates oracles, it doesn\'t run a venue). Empty buckets are NOT '
      + 'forward-filled (gap-honesty over chart-prettiness).',
    inputSchema: {
      pair:          z.string().describe('Pair name, e.g. ADA-USD'),
      interval:      z.enum(['1m', '5m', '15m', '1h', '4h', '1d']).describe('Candle interval'),
      lookbackHours: z.number().positive().describe('Window ending now, in hours (clamped per interval)'),
    },
    run: (args, ctx) => callAction(ctx, 'getOhlcv', {
      pair:          String(args.pair ?? ''),
      interval:      String(args.interval ?? '1h'),
      lookbackHours: Number(args.lookbackHours ?? 24),
    }),
  },
  {
    name: 'get_lending_health',
    description:
      'Health rollup for Cardano lending protocols: FluidTokens v3 (per-asset pool/loan counts, '
      + 'outstanding debt, liquidatable position count) and Liqwid v2 (stable-market supply/borrow/'
      + 'utilization, APY from the Liqwid API). '
      + 'USE FOR lending-protocol risk: "is anything getting liquidated on FluidTokens?", "what\'s '
      + 'lending utilization right now?", "are there at-risk Liqwid markets?". '
      + 'NOT a price feed. Returns both protocols; one may be unavailable independently (mainnet-only).',
    inputSchema: {},
    run: async (_args, ctx) => {
      const [fluid, liqwid] = await Promise.all([
        callAction(ctx, 'getFluidtokensHealth', {}),
        callAction(ctx, 'getLiqwidHealth', {}),
      ]);
      // Roll two free reads into one tool result; surface per-protocol errors
      // rather than failing the whole call if only one is down.
      return {
        ok: fluid.ok || liqwid.ok,
        data: {
          fluidtokens: fluid.ok ? fluid.data : { available: false, error: fluid.error },
          liqwid:      liqwid.ok ? liqwid.data : { available: false, error: liqwid.error },
        },
        error: (!fluid.ok && !liqwid.ok)
          ? `both lending reads failed (fluid: ${fluid.error}; liqwid: ${liqwid.error})`
          : undefined,
      };
    },
  },
  {
    name: 'get_service_status',
    description:
      'Operational liveness snapshot: per-adapter cache state, last fetch age per pair, in-flight '
      + 'refresh markers, last error per source. Pure in-memory read — never triggers a fetch. '
      + 'USE FOR operational / debugging questions: "is the orcfax source down?", "when was the last '
      + 'successful minswap-v2 fetch?", "which adapter is stale?". '
      + 'NOT FOR pricing or stable-safety questions — use get_best_price or assess_stable for those.',
    inputSchema: {},
    run: (_args, ctx) => callAction(ctx, 'getServiceStatus', {}),
  },
];
