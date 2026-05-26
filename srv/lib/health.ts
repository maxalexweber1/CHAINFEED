/**
 * Real semantic health check — composes three signals into one verdict.
 *
 * Three checks, each with its own status:
 *   - db        — `SELECT 1` round-trip to the CAP database
 *   - adapters  — derived from the registry's in-memory cache snapshot
 *   - watcher   — read of the heartbeat file the watcher container writes
 *
 * The endpoint (`/health` in srv/server.ts) maps the aggregate status to HTTP:
 *   healthy/degraded → 200 (uptime monitor stays green)
 *   critical         → 503 (uptime monitor pages on-call)
 *
 * "degraded" is intentionally still 200 so partial outages don't trigger
 * pager fatigue — Discord alerts already cover the meaningful single-stable
 * incidents.
 *
 * Pure-fn shape: all I/O is injected via `HealthDeps`. The HTTP handler in
 * srv/server.ts wires the real deps; unit tests inject stubs.
 */

import { promises as fs } from 'node:fs';
import type { CacheStatus } from './cache';

export type CheckStatus = 'ok' | 'degraded' | 'critical' | 'unknown';
export type OverallStatus = 'healthy' | 'degraded' | 'critical';

export interface HealthCheckDb {
  status: 'ok' | 'critical';
  latencyMs: number | null;
  error?: string;
}

export interface HealthCheckAdapters {
  status: CheckStatus;
  total: number;
  ok: number;
  degraded: number;
  cold: number;
  /** Per-adapter terse summary so an SRE can see which are dirty without a getServiceStatus call. */
  byAdapter: Record<string, 'ok' | 'degraded' | 'cold'>;
}

export interface HealthCheckWatcher {
  status: 'ok' | 'degraded' | 'critical' | 'unknown';
  /** ISO timestamp of last successful tick start, or null if no heartbeat read. */
  lastTickAt: string | null;
  /** Age of the last heartbeat in milliseconds. */
  ageMs: number | null;
  /** Tick cadence the watcher self-reports — used to scale thresholds. */
  intervalMs: number | null;
}

export interface HealthReport {
  status: OverallStatus;
  timestamp: string;
  uptimeSec: number;
  version: string;
  checks: {
    db:       HealthCheckDb;
    adapters: HealthCheckAdapters;
    watcher:  HealthCheckWatcher;
  };
}

export interface HealthDeps {
  /** Pings the database; returns round-trip ms on success, throws on failure. */
  pingDb: () => Promise<number>;
  /** Snapshot of every cached adapter's in-memory state. */
  getAdapterStatuses: () => CacheStatus[];
  /** Read the watcher heartbeat. Return null if file missing/unparseable. */
  readHeartbeat: () => Promise<{ tickAt: string; intervalMs: number } | null>;
  /** Injectable now() for deterministic tests. */
  now: () => Date;
  /** Process uptime in seconds — typically `process.uptime()`. */
  uptimeSec: () => number;
  /** Version string — typically the package.json version. */
  version: string;
}

// ─── Per-check classification ───────────────────────────────────────────────

/** An adapter is "ok" if all its cached pairs are error-free, "degraded" if
 *  any has a lastError, "cold" if it has no cached pairs (never used). */
function classifyAdapter(s: CacheStatus): 'ok' | 'degraded' | 'cold' {
  if (s.cachedPairCount === 0) return 'cold';
  return s.pairs.some((p) => p.lastError !== null) ? 'degraded' : 'ok';
}

/** Overall adapter check status from per-adapter breakdown. */
function classifyAdapters(byAdapter: Record<string, 'ok' | 'degraded' | 'cold'>): {
  status: CheckStatus; ok: number; degraded: number; cold: number; total: number;
} {
  const values = Object.values(byAdapter);
  const total = values.length;
  const okCount       = values.filter((v) => v === 'ok').length;
  const degradedCount = values.filter((v) => v === 'degraded').length;
  const coldCount     = values.filter((v) => v === 'cold').length;
  const seen = okCount + degradedCount; // exclude 'cold' from ratio math

  let status: CheckStatus;
  if (seen === 0)                        status = 'unknown';       // nothing fetched yet
  else if (degradedCount === 0)          status = 'ok';
  else if (okCount / seen >= 0.5)        status = 'degraded';      // majority still good
  else                                   status = 'critical';      // most adapters dirty

  return { status, ok: okCount, degraded: degradedCount, cold: coldCount, total };
}

/** Watcher status from heartbeat age vs cadence.
 *  - missing heartbeat → 'unknown' (watcher might not be deployed)
 *  - age < 2× interval → 'ok'
 *  - 2× ≤ age < 3× interval → 'degraded'
 *  - age ≥ 3× interval → 'critical' (watcher is stalled) */
function classifyWatcher(
  heartbeat: { tickAt: string; intervalMs: number } | null,
  now: Date,
): HealthCheckWatcher {
  if (!heartbeat) {
    return { status: 'unknown', lastTickAt: null, ageMs: null, intervalMs: null };
  }
  const tickAt = new Date(heartbeat.tickAt);
  const ageMs = now.getTime() - tickAt.getTime();
  const i = heartbeat.intervalMs;
  let status: HealthCheckWatcher['status'];
  if      (ageMs < 2 * i) status = 'ok';
  else if (ageMs < 3 * i) status = 'degraded';
  else                    status = 'critical';
  return { status, lastTickAt: heartbeat.tickAt, ageMs, intervalMs: i };
}

/** Aggregate the three per-check statuses into one overall verdict.
 *  Any critical → critical. Else any degraded → degraded. Else healthy.
 *  'unknown' contributes 'ok' to the overall (we don't penalise missing data). */
function aggregateStatus(
  db: HealthCheckDb,
  adapters: HealthCheckAdapters,
  watcher: HealthCheckWatcher,
): OverallStatus {
  const each = [db.status, adapters.status, watcher.status];
  if (each.includes('critical')) return 'critical';
  if (each.includes('degraded')) return 'degraded';
  return 'healthy';
}

// ─── Public entry ──────────────────────────────────────────────────────────

/** Build the full health report from the injected dependencies. */
export async function buildHealthReport(deps: HealthDeps): Promise<HealthReport> {
  const now = deps.now();

  // db — wrap pingDb in try/catch so a backend outage doesn't throw out of here
  let dbCheck: HealthCheckDb;
  try {
    const latencyMs = await deps.pingDb();
    dbCheck = { status: 'ok', latencyMs };
  } catch (e) {
    dbCheck = { status: 'critical', latencyMs: null, error: (e as Error).message };
  }

  // adapters — derive from cache snapshot
  const statuses = deps.getAdapterStatuses();
  const byAdapter: Record<string, 'ok' | 'degraded' | 'cold'> = {};
  for (const s of statuses) byAdapter[s.sourceName] = classifyAdapter(s);
  const adapterAgg = classifyAdapters(byAdapter);
  const adaptersCheck: HealthCheckAdapters = { ...adapterAgg, byAdapter };

  // watcher — read heartbeat + classify by age
  const heartbeat = await deps.readHeartbeat();
  const watcherCheck = classifyWatcher(heartbeat, now);

  return {
    status:    aggregateStatus(dbCheck, adaptersCheck, watcherCheck),
    timestamp: now.toISOString(),
    uptimeSec: Math.round(deps.uptimeSec()),
    version:   deps.version,
    checks: {
      db:       dbCheck,
      adapters: adaptersCheck,
      watcher:  watcherCheck,
    },
  };
}

// ─── Default dep factories (CAP-side) ──────────────────────────────────────

/** Read the watcher heartbeat from a known JSON path. Returns null on any
 *  failure (missing file, malformed JSON, IO error). */
export async function defaultReadHeartbeat(filePath: string):
    Promise<{ tickAt: string; intervalMs: number } | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<{ tickAt: string; intervalMs: number }>;
    if (typeof parsed.tickAt === 'string' && typeof parsed.intervalMs === 'number') {
      return { tickAt: parsed.tickAt, intervalMs: parsed.intervalMs };
    }
    return null;
  } catch {
    return null;
  }
}
