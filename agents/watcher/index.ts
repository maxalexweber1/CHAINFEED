/**
 * CHAINFEED stable watcher — entrypoint.
 *
 * Polls assess_stable for the 5 USD-pegged stables on a configurable interval,
 * diffs each fresh assessment against the last persisted observation, fires
 * alert events to all configured sinks, and writes the new state to disk.
 *
 * Run:  npm run agent:watcher
 * Env:
 *   MCP_URL                  default http://localhost:4005/mcp
 *   WATCHER_INTERVAL_MS      default 60000
 *   WATCHER_STATE_FILE       default agents/watcher/state.json
 *   WATCHER_ONCE             if set, exit after a single tick (CI / smoke)
 *   DISCORD_WEBHOOK_URL      enables Discord sink when set        (Step 4)
 *   TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID  enables Telegram sink  (Step 4)
 *
 * Per-symbol error isolation: a failing assess_stable preserves last-known
 * state for that symbol and fires no event. Other symbols continue normally.
 */

import path from 'node:path';
import { connectMcp, type ChainfeedClient } from '../shared/chainfeed-client.js';
import { runPollLoop } from '../shared/poll-loop.js';
import { STABLE_SYMBOLS, type AssessmentResponse, type StableSymbol } from '../shared/types.js';
import { loadState, saveState, type StateFile } from './state.js';
import { diffObservation, observationFromAssessment } from './diff.js';
import { stdoutSink } from './sinks/stdout.js';
import { makeDiscordSink } from './sinks/discord.js';
import { makeTelegramSink } from './sinks/telegram.js';
import type { AlertEvent, Sink } from './sinks/types.js';

interface WatcherConfig {
  mcpUrl: string;
  stateFile: string;
  intervalMs: number;
  runOnce: boolean;
}

function readConfig(): WatcherConfig {
  return {
    mcpUrl:     process.env.MCP_URL              ?? 'http://localhost:4005/mcp',
    stateFile:  process.env.WATCHER_STATE_FILE   ?? path.resolve('agents/watcher/state.json'),
    intervalMs: Number(process.env.WATCHER_INTERVAL_MS ?? 60_000),
    runOnce:    !!process.env.WATCHER_ONCE,
  };
}

/**
 * Resolve which sinks are active based on which env-vars are set. Each
 * external sink is opt-in: present env-vars ⇒ active. Missing ⇒ silently
 * skipped (so dev/staging deploys don't fail boot without a Discord URL).
 * stdout is always on — both as a fallback and as a deploy-log trail.
 */
function resolveSinks(): Sink[] {
  const sinks: Sink[] = [stdoutSink];

  const discordUrl = process.env.DISCORD_WEBHOOK_URL;
  if (discordUrl) sinks.push(makeDiscordSink({ webhookUrl: discordUrl }));

  const tgToken = process.env.TELEGRAM_BOT_TOKEN;
  const tgChat  = process.env.TELEGRAM_CHAT_ID;
  if (tgToken && tgChat) sinks.push(makeTelegramSink({ botToken: tgToken, chatId: tgChat }));

  return sinks;
}

/** One poll-tick: fetch all 5 stables in parallel, diff vs state, fire sinks, persist. */
async function tick(client: ChainfeedClient, state: StateFile, sinks: Sink[], stateFile: string): Promise<void> {
  const results = await Promise.allSettled(
    STABLE_SYMBOLS.map((sym) => client.assessStable(sym).then((r) => [sym, r] as const)),
  );

  const events: AlertEvent[] = [];
  let okCount = 0;
  let errCount = 0;

  for (const r of results) {
    if (r.status === 'rejected') {
      errCount++;
      process.stderr.write(`watcher: assess_stable failed: ${(r.reason as Error)?.message ?? r.reason}\n`);
      continue;
    }
    okCount++;
    const [sym, fresh] = r.value;
    const evt = diffObservation(sym, fresh, state.observations[sym]);
    if (evt) events.push(evt);
    state.observations[sym] = observationFromAssessment(fresh);
  }

  // Fire sinks in parallel. One sink's failure doesn't block the others.
  const sinkResults = await Promise.allSettled(sinks.map((s) => s.notify(events)));
  sinkResults.forEach((res, i) => {
    if (res.status === 'rejected') {
      process.stderr.write(`watcher: sink '${sinks[i]!.name}' failed: ${(res.reason as Error)?.message ?? res.reason}\n`);
    }
  });

  // Persist after sinks ran. If a sink throws but state wrote, we'd miss
  // re-firing on restart — acceptable: sinks are best-effort, state is truth.
  try {
    await saveState(stateFile, state);
  } catch (e) {
    process.stderr.write(`watcher: failed to persist state: ${(e as Error)?.message ?? e}\n`);
  }

  const ts = new Date().toISOString();
  process.stderr.write(
    `[${ts}] tick: ${okCount} polled, ${errCount} errors, ${events.length} alert${events.length === 1 ? '' : 's'}\n`,
  );
}

async function main(): Promise<void> {
  const cfg = readConfig();
  const sinks = resolveSinks();
  const state = await loadState(cfg.stateFile);
  const seeded = Object.keys(state.observations).length;

  process.stderr.write(
    `chainfeed-watcher: starting\n` +
    `  mcp:      ${cfg.mcpUrl}\n` +
    `  state:    ${cfg.stateFile} (${seeded} prior observation${seeded === 1 ? '' : 's'})\n` +
    `  sinks:    ${sinks.map((s) => s.name).join(', ')}\n` +
    `  interval: ${cfg.intervalMs}ms${cfg.runOnce ? ' (once)' : ''}\n`,
  );

  let client: ChainfeedClient;
  try {
    client = await connectMcp({ url: cfg.mcpUrl, clientName: 'chainfeed-watcher' });
  } catch (e) {
    process.stderr.write(
      `chainfeed-watcher: failed to connect to MCP at ${cfg.mcpUrl}\n` +
      `  → ${(e as Error)?.message ?? e}\n` +
      `  → Is the CHAINFEED MCP HTTP server running? Try: npm run mcp:http\n`,
    );
    process.exit(1);
  }

  // SIGINT/SIGTERM → save state, close client, exit.
  const ac = new AbortController();
  const shutdown = async (sig: NodeJS.Signals) => {
    process.stderr.write(`chainfeed-watcher: ${sig} received, shutting down\n`);
    ac.abort();
    try { await saveState(cfg.stateFile, state); } catch { /* best-effort */ }
    try { await client.close();                  } catch { /* best-effort */ }
    process.exit(0);
  };
  process.once('SIGINT',  () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  if (cfg.runOnce) {
    await tick(client, state, sinks, cfg.stateFile);
    await client.close();
    return;
  }

  await runPollLoop({
    intervalMs: cfg.intervalMs,
    signal: ac.signal,
    onTick: () => tick(client, state, sinks, cfg.stateFile),
    onError: (err, fails) => {
      process.stderr.write(`watcher: tick failed (consecutive=${fails}): ${err.message}\n`);
    },
  });
}

void main().catch((e) => {
  process.stderr.write(`chainfeed-watcher: fatal: ${(e as Error)?.stack ?? e}\n`);
  process.exit(1);
});
