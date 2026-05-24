/**
 * Generic interval driver with exponential backoff on consecutive failures.
 *
 * Both demo agents do the same thing structurally: tick, do work, sleep, repeat.
 * This module owns that loop so the agents only carry their own tick logic. No
 * timers leak — sleep is AbortSignal-aware, so SIGINT handlers can stop the
 * loop cleanly.
 *
 * Backoff policy: on failure, wait = `intervalMs * min(2^fails, maxBackoffMultiplier)`.
 * Resets to baseline after a single successful tick. Keeps a flapping upstream
 * from drowning us in retries without going into multi-hour silent failure.
 */

export interface PollLoopOpts {
  /** Cadence of the baseline tick, in milliseconds. */
  intervalMs: number;
  /** Signal to stop the loop. Stop is checked between ticks and during sleep. */
  signal?: AbortSignal;
  /** Called on each tick. Throws are caught and trigger backoff. */
  onTick: () => Promise<void>;
  /** Notified after a failed tick (already counted into `consecutiveFails`). */
  onError?: (err: Error, consecutiveFails: number) => void;
  /** Upper bound on backoff multiplier. Default 8 — ie. up to 8 × intervalMs between retries. */
  maxBackoffMultiplier?: number;
  /** If true, skips the first immediate tick and waits one full interval first. Default false. */
  delayFirstTick?: boolean;
}

/** AbortSignal-aware sleep. Resolves early when the signal fires. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    const onAbort = () => { clearTimeout(t); resolve(); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Run the loop until `signal` aborts (or forever if no signal given).
 * Returns when the loop exits — caller should `await` it as the agent's main task.
 */
export async function runPollLoop(opts: PollLoopOpts): Promise<void> {
  const maxMul = opts.maxBackoffMultiplier ?? 8;
  let consecutiveFails = 0;

  if (opts.delayFirstTick) await sleep(opts.intervalMs, opts.signal);

  while (!opts.signal?.aborted) {
    try {
      await opts.onTick();
      consecutiveFails = 0;
    } catch (e) {
      consecutiveFails++;
      try { opts.onError?.(e as Error, consecutiveFails); } catch { /* don't let logging kill the loop */ }
    }
    if (opts.signal?.aborted) break;

    const mul = consecutiveFails === 0 ? 1 : Math.min(2 ** (consecutiveFails - 1), maxMul);
    await sleep(opts.intervalMs * mul, opts.signal);
  }
}
