/**
 * Watcher heartbeat — cross-process liveness signal for the health endpoint.
 *
 * The CAP-side `/health` route can't introspect the watcher (different
 * container, different process), so the watcher drops a tiny JSON file at
 * the end of every tick. CAP reads it to decide whether the watcher is
 * "alive within the expected cadence" or stalled.
 *
 * Same atomic-write pattern as state.ts (tmp + rename) so a crash mid-write
 * can't corrupt the file. Failures here are logged but never propagated —
 * a watcher that can't write its heartbeat is still a watcher that polled,
 * and we'd rather degrade gracefully than crash the tick loop.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getLogger } from '../shared/log.js';

const log = getLogger('watcher:heartbeat');

export interface Heartbeat {
  /** ISO timestamp when the tick STARTED — conservative for age calc. */
  tickAt: string;
  /** Stables successfully polled this tick. */
  polled: number;
  /** Stables that errored this tick. */
  errors: number;
  /** Alert events fired (any sink). */
  alerts: number;
  /** Configured cadence — readers flag the heartbeat stale at > 2× this value. */
  intervalMs: number;
}

/** Atomic write: dump to `<path>.tmp` then rename over `<path>`. */
export async function writeHeartbeat(filePath: string, hb: Heartbeat): Promise<void> {
  try {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${filePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(hb, null, 2), 'utf8');
    await fs.rename(tmp, filePath);
  } catch (e) {
    // Heartbeat failure is non-fatal: the watcher keeps polling. Log so
    // ops can see it; the /health endpoint will report watcher as stale
    // after one cadence, which is the correct user-visible signal.
    log.warn({ path: filePath, err: (e as Error).message }, 'heartbeat write failed');
  }
}
