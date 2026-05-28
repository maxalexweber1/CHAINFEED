/**
 * CHAINFEED CLI Q&A agent.
 *
 * Natural-language interface to the CHAINFEED MCP server, demonstrating the
 * actual "agents use CHAINFEED as native tools" pitch end-to-end:
 *
 *   user (NL question)  →  Claude (Haiku 4.5, tool-use loop)
 *                                  ↓ tools/call
 *                          MCP server (srv/mcp/http.ts)
 *                                  ↓ OData action
 *                          CHAINFEED (srv/price-service.ts)
 *
 * Why Haiku 4.5: tool-routing + brief factual summaries is exactly its sweet
 * spot. Opus would be overkill and slow; Haiku's 200K context fits a long Q&A
 * session and the per-turn latency is ~1–2s including a tool round-trip.
 *
 * Why manual loop, not the betaZodTool runner: our tool surface is discovered
 * at runtime via `mcp.listTools()`. The runner expects static `betaZodTool`
 * definitions with local `run` functions; we just bridge `tool_use` blocks
 * straight to `mcp.callTool()` and feed the JSON back as `tool_result`.
 *
 * Caching: one `cache_control: {type: 'ephemeral'}` breakpoint on the system
 * prompt covers the tool list AND the system text (tools render *before*
 * system, so the marker caches everything that comes before it). After the
 * first turn, `usage.cache_read_input_tokens` should be ~1000+ on every
 * subsequent turn.
 *
 * Run:    npm run agent:qa
 * Env:    ANTHROPIC_API_KEY (required), MCP_URL (default 127.0.0.1:4005/mcp),
 *         ANTHROPIC_MODEL (default claude-haiku-4-5).
 */

import Anthropic from '@anthropic-ai/sdk';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import readline from 'node:readline/promises';
import { getLogger } from '../shared/log.js';

const log = getLogger('cli-qa');

const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5';

// System prompt: stable across the whole session, sits inside the cached
// prefix. Tool-routing rules are duplicated from `srv/mcp/tools.ts` USE FOR
// blocks intentionally — having both sides reinforce the routing improves
// tool-selection on Haiku, which has less reasoning headroom than Opus.
const SYSTEM_PROMPT = `
You are CHAINFEED-QA, a Cardano stable-coin and DEX/lending expert.
You answer by calling MCP tools — never invent numbers. If a tool doesn't
return what you need, say so directly.

Tool routing:
- "is X safe / healthy / depegging?" → assess_stable
- raw numbers behind a stable's verdict → get_stable_health
- price of a pair → get_best_price (x402-gated)
- "are all stables holding peg?" → get_stable_convergence
- venue dislocation → get_arbitrage (x402-gated)
- price history → get_ohlcv
- lending markets → get_lending_health
- adapter/source liveness → get_service_status

x402-gated tools may return a 'paymentRequired' result. If that happens, tell
the user what they would need to pay — don't try to pay yourself.

Response style: short, factual, lead with the verdict or key number. One or
two sentences. Cite the tool you used in parentheses, e.g. "(via assess_stable)".
`.trim();

interface CliConfig {
  mcpUrl: string;
  mcpAuthToken?: string;
  apiKey: string;
  model: string;
}

function readConfig(): CliConfig {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    log.fatal('ANTHROPIC_API_KEY not set — get one at https://console.anthropic.com');
    process.exit(1);
  }
  return {
    mcpUrl: process.env.MCP_URL ?? 'http://127.0.0.1:4005/mcp',
    mcpAuthToken: process.env.MCP_AUTH_TOKEN,
    apiKey,
    model: MODEL,
  };
}

/** Bridge an MCP `tools/call` result to an Anthropic `tool_result` block. */
async function executeMcpTool(
  mcp: McpClient,
  use: Anthropic.ToolUseBlock,
): Promise<Anthropic.ToolResultBlockParam> {
  try {
    const res = await mcp.callTool({
      name:      use.name,
      arguments: use.input as Record<string, unknown>,
    });
    // Our MCP server's toMcpResult always emits content[0] as a text block
    // with a JSON string. Pass it straight to Claude — it parses JSON fine.
    const content = res.content as Array<{ type: string; text: string }> | undefined;
    const text = content?.[0]?.text ?? '{}';
    return {
      type:        'tool_result',
      tool_use_id: use.id,
      content:     text,
      // `paymentRequired` is intentionally NOT an error (see srv/mcp/server.ts
      // toMcpResult) — Claude sees it as a normal result and tells the user.
      is_error:    res.isError === true,
    };
  } catch (e) {
    // Network glitch or MCP server died mid-call. Surface as a tool error so
    // Claude can mention it instead of hanging.
    return {
      type:        'tool_result',
      tool_use_id: use.id,
      content:     `MCP tool execution failed: ${(e as Error).message}`,
      is_error:    true,
    };
  }
}

/** One Claude turn: send conversation → loop tool-use → print final text. */
async function runTurn(
  anthropic: Anthropic,
  mcp:       McpClient,
  tools:     Anthropic.Tool[],
  conversation: Anthropic.MessageParam[],
  model: string,
): Promise<void> {
  // Bounded loop — paranoia against a runaway model that keeps calling tools.
  // 12 round-trips is more than enough for any realistic Q&A.
  for (let iter = 0; iter < 12; iter++) {
    const response = await anthropic.messages.create({
      model,
      max_tokens: 1024,
      // One cache_control breakpoint covers tools + system (tools render
      // first in the prefix). Subsequent turns of this REPL session see a
      // ~95% cache-read rate on the prefix.
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      tools,
      messages: conversation,
    });

    // Always push the FULL assistant content — tool_use blocks must survive
    // round-trip or Claude can't match the next tool_result by ID.
    conversation.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      const text = response.content.find(
        (b): b is Anthropic.TextBlock => b.type === 'text',
      )?.text ?? '(no text response)';
      process.stdout.write(`\n${text}\n\n`);
      // Cache visibility on stderr — useful when tuning prompt structure.
      const cached = response.usage.cache_read_input_tokens ?? 0;
      const fresh  = response.usage.input_tokens;
      if (cached > 0) {
        process.stderr.write(`  · ${cached} cached + ${fresh} fresh input tokens\n`);
      }
      return;
    }

    // Execute every tool_use in parallel (they don't depend on each other
    // within a single Claude turn — Claude pre-plans them in one shot).
    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );
    for (const u of toolUses) {
      process.stderr.write(`  🔧 ${u.name}(${JSON.stringify(u.input)})\n`);
    }
    const results = await Promise.all(toolUses.map((u) => executeMcpTool(mcp, u)));
    conversation.push({ role: 'user', content: results });
  }

  process.stderr.write('  ! tool-use loop exceeded 12 iterations — aborting turn\n');
}

async function main(): Promise<void> {
  const cfg = readConfig();

  // Connect MCP
  const mcp = new McpClient({ name: 'chainfeed-cli-qa', version: '0.0.1' });
  const transport = new StreamableHTTPClientTransport(
    new URL(cfg.mcpUrl),
    cfg.mcpAuthToken
      ? { requestInit: { headers: { Authorization: `Bearer ${cfg.mcpAuthToken}` } } }
      : undefined,
  );
  try {
    await mcp.connect(transport);
  } catch (e) {
    log.fatal(
      { mcp: cfg.mcpUrl, err: (e as Error).message },
      'failed to connect to MCP — is the CHAINFEED MCP HTTP server running? (npm run mcp:http)',
    );
    process.exit(1);
  }

  const { tools: mcpTools } = await mcp.listTools();
  const anthropicTools: Anthropic.Tool[] = mcpTools.map((t) => ({
    name:         t.name,
    description:  t.description ?? '',
    input_schema: t.inputSchema as Anthropic.Tool['input_schema'],
  }));

  const anthropic = new Anthropic({ apiKey: cfg.apiKey });

  process.stderr.write(
    `\nCHAINFEED-QA — ask anything about Cardano stables, DEXes, lending.\n` +
    `Model: ${cfg.model}  ·  MCP: ${cfg.mcpUrl}  ·  ${anthropicTools.length} tools.\n` +
    `Try: "is USDM safe?"  or  "are all stables holding peg?"\n` +
    `Type 'exit' or Ctrl-C to quit.\n\n`,
  );

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const conversation: Anthropic.MessageParam[] = [];

  const shutdown = async (): Promise<never> => {
    rl.close();
    try { await mcp.close(); } catch { /* best-effort */ }
    process.exit(0);
  };
  process.once('SIGINT',  () => void shutdown());
  process.once('SIGTERM', () => void shutdown());

  while (true) {
    let question: string;
    try {
      question = (await rl.question('> ')).trim();
    } catch {
      break; // readline closed
    }
    if (!question)                              continue;
    if (question === 'exit' || question === 'quit') break;

    conversation.push({ role: 'user', content: question });

    try {
      await runTurn(anthropic, mcp, anthropicTools, conversation, cfg.model);
    } catch (e) {
      // Use typed exceptions from the SDK — never string-match error messages.
      if (e instanceof Anthropic.RateLimitError) {
        log.error('Anthropic rate-limited this client — try again in a moment');
      } else if (e instanceof Anthropic.AuthenticationError) {
        log.fatal('ANTHROPIC_API_KEY rejected — check the value');
        break;
      } else if (e instanceof Anthropic.APIError) {
        log.error({ status: e.status, msg: e.message }, 'Anthropic API error');
      } else {
        log.error({ err: (e as Error).message }, 'turn failed');
      }
      // Roll back the user turn we pushed before the failure so the next
      // attempt doesn't see a half-complete history.
      conversation.pop();
    }
  }

  await shutdown();
}

void main().catch((e) => {
  log.fatal({ err: (e as Error).stack ?? String(e) }, 'fatal');
  process.exit(1);
});
