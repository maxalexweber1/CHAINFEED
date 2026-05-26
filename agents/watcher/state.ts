/**
 * Per-symbol "last observation" state, persisted to disk.
 *
 * The watcher needs to remember each stable's last verdict + reasonCodes
 * between ticks (and across restarts) so it only fires alerts on CHANGE, not
 * on every poll. Cold start with no state = silent seed (we record but don't
 * alert) so a restart doesn't carpet-bomb subscribers with "current state of
 * the world" messages.
 *
 * Storage: a single JSON file, atomically rewritten via tmp+rename so a crash
 * mid-write can't corrupt it. SQLite would be overkill for ~5 keys.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Verdict } from '../shared/types.js';
import { getLogger } from '../shared/log.js';

const log = getLogger('watcher:state');

export interface Observation {
  verdict: Verdict;
  reasonCodes: string[];
  riskScore: number;
  /** Server-side computation time. */
  computedAt: string;
  /** Wall clock when watcher recorded it. */
  observedAt: string;
}

export interface StateFile {
  /** Schema version. Bump on breaking changes; old files get rejected/migrated. */
  version: 1;
  observations: Record<string, Observation>;
}

const EMPTY_STATE: StateFile = { version: 1, observations: {} };

/**
 * Load state from disk. Missing file → empty state (first run). Malformed file
 * → log + empty state (refuse to crash; better to alert-storm once than to fail
 * boot).
 */
export async function loadState(filePath: string): Promise<StateFile> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<StateFile>;
    if (parsed.version !== 1 || !parsed.observations) {
      log.warn({ path: filePath }, 'state file has unexpected shape, starting empty');
      return { ...EMPTY_STATE };
    }
    return { version: 1, observations: { ...parsed.observations } };
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return { ...EMPTY_STATE };
    log.warn({ path: filePath, err: err.message }, 'failed to read state, starting empty');
    return { ...EMPTY_STATE };
  }
}

/** Atomic write: dump to `<path>.tmp` then rename over `<path>`. */
export async function saveState(filePath: string, state: StateFile): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await fs.rename(tmp, filePath);
}
