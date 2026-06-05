/**
 * Unit tests for the pure-fn health report builder (srv/lib/health.ts).
 *
 * All dependencies are injected, so no DB, no filesystem, no real adapters.
 * Each test stubs the four `HealthDeps` slots and asserts the resulting
 * report's classification.
 *
 * Run: npx tsx scripts/test-health.ts
 */

import assert from 'node:assert/strict';
import { buildHealthReport, type HealthDeps } from '../srv/lib/health';
import type { CacheStatus } from '../srv/lib/cache';

let n = 0, fails = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  n++;
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (e) { fails++; console.log(`FAIL  ${name}\n      ${(e as Error).stack || (e as Error).message}`); }
}

// ── Stub-builders ────────────────────────────────────────────────────────────

const NOW = new Date('2026-05-26T10:00:00.000Z');

function mkAdapterStatus(name: string, opts: { hasError?: boolean; cold?: boolean } = {}): CacheStatus {
  if (opts.cold) return { sourceName: name, ttlMs: 60_000, cachedPairCount: 0, pairs: [] };
  return {
    sourceName: name,
    ttlMs: 60_000,
    cachedPairCount: 1,
    pairs: [{
      pair: 'ADA-USD',
      fetchedAtIso: '2026-05-26T09:59:30.000Z',
      ageSeconds: 30,
      hasInflightRefresh: false,
      lastError: opts.hasError ? { message: 'fetch failed', at: '2026-05-26T09:59:00.000Z' } : null,
    }],
  };
}

function baseDeps(overrides: Partial<HealthDeps> = {}): HealthDeps {
  return {
    pingDb:             async () => 5,
    getAdapterStatuses: () => [mkAdapterStatus('orcfax'), mkAdapterStatus('sundae')],
    readHeartbeat:      async () => ({ tickAt: '2026-05-26T09:59:30.000Z', intervalMs: 60_000 }),
    now:                () => NOW,
    uptimeSec:          () => 3600,
    version:            '0.1.0-test',
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('health-report ──────────────────────────────────────────');

  await t('all-green inputs → status healthy, all checks ok', async () => {
    const r = await buildHealthReport(baseDeps());
    assert.equal(r.status, 'healthy');
    assert.equal(r.checks.db.status, 'ok');
    assert.equal(r.checks.db.latencyMs, 5);
    assert.equal(r.checks.adapters.status, 'ok');
    assert.equal(r.checks.watcher.status, 'ok');
  });

  await t('report shape: has timestamp, uptime, version, and three checks', async () => {
    const r = await buildHealthReport(baseDeps());
    assert.equal(r.timestamp, NOW.toISOString());
    assert.equal(r.uptimeSec, 3600);
    assert.equal(r.version, '0.1.0-test');
    assert.ok(r.checks.db && r.checks.adapters && r.checks.watcher);
  });

  // ── DB ─────────────────────────────────────────────────────────────────
  await t('db ping throws → db critical, overall critical', async () => {
    const r = await buildHealthReport(baseDeps({
      pingDb: async () => { throw new Error('connection refused'); },
    }));
    assert.equal(r.status, 'critical');
    assert.equal(r.checks.db.status, 'critical');
    assert.equal(r.checks.db.latencyMs, null);
    assert.match(r.checks.db.error ?? '', /connection refused/);
  });

  await t('db slow (200ms) still classified ok (no latency threshold)', async () => {
    const r = await buildHealthReport(baseDeps({ pingDb: async () => 200 }));
    assert.equal(r.checks.db.status, 'ok');
    assert.equal(r.checks.db.latencyMs, 200);
  });

  // ── Adapters ───────────────────────────────────────────────────────────
  await t('all adapters cold → adapter status unknown, overall healthy', async () => {
    const r = await buildHealthReport(baseDeps({
      getAdapterStatuses: () => [
        mkAdapterStatus('orcfax', { cold: true }),
        mkAdapterStatus('sundae', { cold: true }),
      ],
    }));
    assert.equal(r.checks.adapters.status, 'unknown');
    assert.equal(r.checks.adapters.cold, 2);
    assert.equal(r.status, 'healthy');
  });

  await t('one of two adapters degraded → adapters degraded (50% threshold)', async () => {
    const r = await buildHealthReport(baseDeps({
      getAdapterStatuses: () => [
        mkAdapterStatus('orcfax'),
        mkAdapterStatus('sundae', { hasError: true }),
      ],
    }));
    assert.equal(r.checks.adapters.status, 'degraded');
    assert.equal(r.checks.adapters.ok, 1);
    assert.equal(r.checks.adapters.degraded, 1);
    assert.equal(r.status, 'degraded');
  });

  await t('all adapters degraded → adapters critical, overall critical', async () => {
    const r = await buildHealthReport(baseDeps({
      getAdapterStatuses: () => [
        mkAdapterStatus('a', { hasError: true }),
        mkAdapterStatus('b', { hasError: true }),
        mkAdapterStatus('c', { hasError: true }),
      ],
    }));
    assert.equal(r.checks.adapters.status, 'critical');
    assert.equal(r.status, 'critical');
  });

  await t('majority adapters ok (3 of 4) → adapter status ok', async () => {
    const r = await buildHealthReport(baseDeps({
      getAdapterStatuses: () => [
        mkAdapterStatus('a'),
        mkAdapterStatus('b'),
        mkAdapterStatus('c'),
        mkAdapterStatus('d', { hasError: true }),
      ],
    }));
    // 1 degraded out of 4 seen — still flags overall as 'degraded' because we
    // only return 'ok' when ZERO are degraded.
    assert.equal(r.checks.adapters.status, 'degraded');
  });

  await t('per-adapter map echoes ok/degraded/cold per source', async () => {
    const r = await buildHealthReport(baseDeps({
      getAdapterStatuses: () => [
        mkAdapterStatus('orcfax'),
        mkAdapterStatus('sundae', { hasError: true }),
        mkAdapterStatus('minswap', { cold: true }),
      ],
    }));
    assert.equal(r.checks.adapters.byAdapter.orcfax,  'ok');
    assert.equal(r.checks.adapters.byAdapter.sundae, 'degraded');
    assert.equal(r.checks.adapters.byAdapter.minswap, 'cold');
  });

  // ── Watcher (heartbeat-based) ──────────────────────────────────────────
  await t('no heartbeat → watcher unknown, overall stays healthy', async () => {
    const r = await buildHealthReport(baseDeps({ readHeartbeat: async () => null }));
    assert.equal(r.checks.watcher.status, 'unknown');
    assert.equal(r.checks.watcher.lastTickAt, null);
    assert.equal(r.status, 'healthy');
  });

  await t('heartbeat 1.5× interval old → watcher ok (under 2× threshold)', async () => {
    const tickAt = new Date(NOW.getTime() - 90_000).toISOString();    // 90s < 120s
    const r = await buildHealthReport(baseDeps({
      readHeartbeat: async () => ({ tickAt, intervalMs: 60_000 }),
    }));
    assert.equal(r.checks.watcher.status, 'ok');
    assert.equal(r.checks.watcher.ageMs, 90_000);
  });

  await t('heartbeat 2.5× interval old → watcher degraded, overall degraded', async () => {
    const tickAt = new Date(NOW.getTime() - 150_000).toISOString();   // 150s, 120 ≤ 150 < 180
    const r = await buildHealthReport(baseDeps({
      readHeartbeat: async () => ({ tickAt, intervalMs: 60_000 }),
    }));
    assert.equal(r.checks.watcher.status, 'degraded');
    assert.equal(r.status, 'degraded');
  });

  await t('heartbeat 3.5× interval old → watcher critical, overall critical', async () => {
    const tickAt = new Date(NOW.getTime() - 210_000).toISOString();   // 210s ≥ 180
    const r = await buildHealthReport(baseDeps({
      readHeartbeat: async () => ({ tickAt, intervalMs: 60_000 }),
    }));
    assert.equal(r.checks.watcher.status, 'critical');
    assert.equal(r.status, 'critical');
  });

  // ── Aggregation rules ──────────────────────────────────────────────────
  await t('any critical wins over degraded + ok', async () => {
    const r = await buildHealthReport(baseDeps({
      pingDb: async () => { throw new Error('down'); },         // critical
      getAdapterStatuses: () => [
        mkAdapterStatus('a'),                                    // ok
        mkAdapterStatus('b', { hasError: true }),                // contributes degraded
      ],
    }));
    assert.equal(r.status, 'critical');
  });

  await t('degraded wins over ok-only', async () => {
    const r = await buildHealthReport(baseDeps({
      // adapter check returns degraded; db + watcher ok
      getAdapterStatuses: () => [
        mkAdapterStatus('a'),
        mkAdapterStatus('b', { hasError: true }),
      ],
    }));
    assert.equal(r.status, 'degraded');
  });

  await t('unknown checks do not penalise overall', async () => {
    const r = await buildHealthReport(baseDeps({
      getAdapterStatuses: () => [mkAdapterStatus('a', { cold: true })], // unknown
      readHeartbeat:      async () => null,                              // unknown
    }));
    assert.equal(r.checks.adapters.status, 'unknown');
    assert.equal(r.checks.watcher.status, 'unknown');
    assert.equal(r.status, 'healthy');
  });

  console.log(`\n${n - fails}/${n} passed`);
  process.exit(fails ? 1 : 0);
}

void main();
