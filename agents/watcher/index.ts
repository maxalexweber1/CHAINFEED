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
import { getLogger } from '../shared/log.js';
import { loadState, saveState, type StateFile } from './state.js';
import { diffObservation, observationFromAssessment } from './diff.js';
import { writeHeartbeat } from './heartbeat.js';
import { stdoutSink } from './sinks/stdout.js';
import { makeDiscordSink } from './sinks/discord.js';
import { makeTelegramSink } from './sinks/telegram.js';
import type { AlertEvent, Sink } from './sinks/types.js';

const log = getLogger('watcher');

interface WatcherConfig {
  mcpUrl: string;
  stateFile: string;
  heartbeatFile: string;
  intervalMs: number;
  runOnce: boolean;
}

function readConfig(): WatcherConfig {
  return {
    mcpUrl:        process.env.MCP_URL                ?? 'http://localhost:4005/mcp',
    stateFile:     process.env.WATCHER_STATE_FILE     ?? path.resolve('agents/watcher/state.json'),
    heartbeatFile: process.env.WATCHER_HEARTBEAT_FILE ?? path.resolve('agents/watcher/heartbeat.json'),
    intervalMs:    Number(process.env.WATCHER_INTERVAL_MS ?? 60_000),
    runOnce:       !!process.env.WATCHER_ONCE,
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
async function tick(
  client: ChainfeedClient,
  state: StateFile,
  sinks: Sink[],
  cfg: WatcherConfig,
): Promise<void> {
  const tickStartedAt = new Date();
  const results = await Promise.allSettled(
    STABLE_SYMBOLS.map((sym) => client.assessStable(sym).then((r) => [sym, r] as const)),
  );

  const events: AlertEvent[] = [];
  let okCount = 0;
  let errCount = 0;

  for (const r of results) {
    if (r.status === 'rejected') {
      errCount++;
      log.warn({ err: (r.reason as Error)?.message ?? String(r.reason) }, 'assess_stable failed');
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
      log.error(
        { sink: sinks[i]!.name, err: (res.reason as Error)?.message ?? String(res.reason) },
        'sink notify failed',
      );
    }
  });

  // Persist after sinks ran. If a sink throws but state wrote, we'd miss
  // re-firing on restart — acceptable: sinks are best-effort, state is truth.
  try {
    await saveState(cfg.stateFile, state);
  } catch (e) {
    log.error({ err: (e as Error)?.message ?? String(e) }, 'failed to persist state');
  }

  // Heartbeat — written even on partial failure (errCount > 0) so the
  // health endpoint sees the watcher as alive but degraded, not as missing.
  await writeHeartbeat(cfg.heartbeatFile, {
    tickAt:     tickStartedAt.toISOString(),
    polled:     okCount,
    errors:     errCount,
    alerts:     events.length,
    intervalMs: cfg.intervalMs,
  });

  log.info({ polled: okCount, errors: errCount, alerts: events.length }, 'tick');
}

async function main(): Promise<void> {
  const cfg = readConfig();
  const sinks = resolveSinks();
  const state = await loadState(cfg.stateFile);
  const seeded = Object.keys(state.observations).length;

  log.info(
    {
      mcp:        cfg.mcpUrl,
      stateFile:  cfg.stateFile,
      seeded,
      sinks:      sinks.map((s) => s.name),
      intervalMs: cfg.intervalMs,
      runOnce:    cfg.runOnce,
    },
    'starting',
  );

  let client: ChainfeedClient;
  try {
    client = await connectMcp({ url: cfg.mcpUrl, clientName: 'chainfeed-watcher' });
  } catch (e) {
    log.fatal(
      { mcp: cfg.mcpUrl, err: (e as Error)?.message ?? String(e) },
      'failed to connect to MCP — is the CHAINFEED MCP HTTP server running? (npm run mcp:http)',
    );
    process.exit(1);
  }

  // SIGINT/SIGTERM → save state, close client, exit.
  const ac = new AbortController();
  const shutdown = async (sig: NodeJS.Signals) => {
    log.info({ signal: sig }, 'shutdown requested');
    ac.abort();
    try { await saveState(cfg.stateFile, state); } catch { /* best-effort */ }
    try { await client.close();                  } catch { /* best-effort */ }
    process.exit(0);
  };
  process.once('SIGINT',  () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  if (cfg.runOnce) {
    await tick(client, state, sinks, cfg);
    await client.close();
    return;
  }

  await runPollLoop({
    intervalMs: cfg.intervalMs,
    signal: ac.signal,
    onTick: () => tick(client, state, sinks, cfg),
    onError: (err, fails) => {
      log.error({ consecutive: fails, err: err.message }, 'tick failed');
    },
  });
}

void main().catch((e) => {
  log.fatal({ err: (e as Error)?.stack ?? String(e) }, 'fatal');
  process.exit(1);
});
