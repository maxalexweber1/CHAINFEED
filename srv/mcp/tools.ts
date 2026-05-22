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
 */
export const CHAINFEED_TOOLS: ChainfeedTool[] = [
  {
    name: 'assess_stable',
    description:
      'Get an actionable verdict (ok | caution | alert) on a Cardano stablecoin, with the reasons '
      + 'behind it and suggested next actions. USE THIS FIRST when asked whether a stable is safe, '
      + 'healthy, or depegging — it collapses price, peg-deviation, reserves, and risk into one '
      + `decision so you don't have to reason about raw thresholds. Symbols: ${STABLE_SYMBOLS}. `
      + 'Returns `verdict`, `reasonCodes` (string-stable), `suggestedActions`, an `assessmentConfidence` '
      + '(trust in the verdict) separate from `riskScore` (health of the stable), and the full `detail` block.',
    inputSchema: { symbol: z.string().describe(`Stablecoin symbol, one of: ${STABLE_SYMBOLS}`) },
    run: (args, ctx) => callAction(ctx, 'assessStable', { symbol: String(args.symbol ?? '') }),
  },
  {
    name: 'get_stable_health',
    description:
      'Detailed health breakdown for a stablecoin: aggregated price, peg-deviation (bps), reserves '
      + '(source/coverage/freshness), supply, liquidity depth, and the four risk-score components. '
      + 'Use when you need the underlying numbers behind assess_stable rather than just the verdict. '
      + `Symbols: ${STABLE_SYMBOLS}.`,
    inputSchema: { symbol: z.string().describe(`Stablecoin symbol, one of: ${STABLE_SYMBOLS}`) },
    run: (args, ctx) => callAction(ctx, 'getStableHealth', { symbol: String(args.symbol ?? '') }),
  },
  {
    name: 'get_best_price',
    description:
      'Aggregated multi-source oracle price for a pair (median across oracles + DEXes) with a '
      + 'confidence score and peg-deviation. Examples: ADA-USD, ADA-USDM, ADA-DJED, BTC-ADA, NIGHT-ADA. '
      + 'Pair convention is X-Y = "Y per 1 X". Note: this endpoint is x402-gated.',
    inputSchema: { pair: z.string().describe('Pair name, e.g. ADA-USD or ADA-USDM') },
    run: (args, ctx) => callAction(ctx, 'getBestPrice', { pair: String(args.pair ?? '') }),
  },
  {
    name: 'get_stable_convergence',
    description:
      'Cross-rate matrix across all USD-pegged Cardano stables (derived through an ADA pivot). '
      + 'Returns a convergenceScore in [0,1] and flags which stables are drifting from the basket. '
      + 'Use to compare stables against each other or detect a single stable losing parity.',
    inputSchema: {},
    run: (_args, ctx) => callAction(ctx, 'getStableConvergence', {}),
  },
  {
    name: 'get_arbitrage',
    description:
      'Best buy and best sell venue for a pair across DEXes, with the spread and whether it is '
      + 'profitable after a typical fee. Use for cross-venue price-dislocation questions. '
      + 'Note: this endpoint is x402-gated.',
    inputSchema: { pair: z.string().describe('Pair name, e.g. ADA-USDM') },
    run: (args, ctx) => callAction(ctx, 'getArbitrageOpportunities', { pair: String(args.pair ?? '') }),
  },
  {
    name: 'get_ohlcv',
    description:
      'OHLCV candle history for a pair. Intervals: 1m, 5m, 15m, 1h, 4h, 1d (each has a server-side '
      + 'lookback cap). `sampleCount` is the number of oracle observations in the bucket — NOT traded '
      + 'volume (CHAINFEED is an aggregator, not a venue). Empty buckets are not forward-filled.',
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
      'Health rollup for Cardano lending markets: FluidTokens v3 (pools/loans, outstanding debt, '
      + 'liquidatable count) and Liqwid v2 (stable markets supply/borrow/utilization + APY). '
      + 'Use for lending-protocol risk questions. Returns both protocols; either may be unavailable '
      + 'independently (mainnet-only).',
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
      'Per-adapter cache/liveness snapshot (last fetch age, in-flight refresh, last error per pair). '
      + 'Pure read of in-memory state — never triggers a fetch. Use to check whether a data source '
      + 'is degraded before trusting a price.',
    inputSchema: {},
    run: (_args, ctx) => callAction(ctx, 'getServiceStatus', {}),
  },
];
