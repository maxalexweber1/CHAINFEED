/**
 * Single-command smoke runner — exercises every live-smoke file CHAINFEED
 * ships, parallel where safe, sequential where required (chain-dependent
 * smokes pull from the bridge and may rate-limit on shared API keys).
 *
 * Exits non-zero on any failure. CI-gateable.
 *
 * Run:
 *   npm run smoke
 *   # or
 *   npx tsx scripts/smoke-all.ts
 *
 * Skip categories with env:
 *   SKIP_CHAIN_SMOKES=1   skips bridge-dependent smokes (charli3, djed, indigo)
 *   SKIP_HTTP_SMOKES=1    skips HTTP-dependent smokes (dex, liquidity, circle)
 */

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

interface SmokeJob {
  name: string;
  file: string;
  category: 'http' | 'chain' | 'mixed';
  /** True = safe to run in parallel with others in the same group. */
  parallelSafe: boolean;
  /** Per-smoke timeout (ms). */
  timeoutMs: number;
}

const SMOKES: SmokeJob[] = [
  // HTTP-only smokes (Minswap aggregator, Sundae GraphQL, WingRiders GraphQL,
  // Circle PDF) — parallel-safe.
  { name: 'dex-adapters',         file: 'smoke-dex-adapters.ts',         category: 'http',  parallelSafe: true,  timeoutMs: 90_000 },
  { name: 'circle-attestation',   file: 'smoke-circle-attestation.ts',   category: 'http',  parallelSafe: true,  timeoutMs: 30_000 },

  // Bridge / chain-dependent smokes — sequential (shared Blockfrost rate limit).
  // liquidity-depth moved here 2026-05-03 post DexHunter removal: now reads
  // pool reserves via fanout, which routes through Minswap V2 (Koios) +
  // bridge-backed adapters. indigo-cdp moved post-2026-05-02 for the same
  // reason (bridge.getUtxosAtCredential needs BLOCKFROST_API_KEY env).
  { name: 'liquidity-depth',      file: 'smoke-liquidity-depth.ts',      category: 'chain', parallelSafe: false, timeoutMs: 120_000 },
  { name: 'indigo-cdp',           file: 'smoke-indigo-cdp.ts',           category: 'chain', parallelSafe: false, timeoutMs: 30_000 },
  { name: 'odatano',              file: 'smoke-odatano.ts',              category: 'chain', parallelSafe: false, timeoutMs: 30_000 },
  { name: 'charli3',              file: 'smoke-charli3.ts',              category: 'chain', parallelSafe: false, timeoutMs: 90_000 },
  { name: 'djed-reserves',        file: 'smoke-djed-reserves.ts',        category: 'chain', parallelSafe: false, timeoutMs: 60_000 },
  // FluidTokens v3 reads ~1100 UTxOs (pools + loans) via two
  // bridge.getUtxosAtCredential calls. Heavier than Indigo; allow 90s.
  // Mainnet-only (FLUIDTOKENS_NETWORK=mainnet enforced internally), so it
  // ignores the global NETWORK env and always hits mainnet Koios.
  { name: 'fluidtokens',          file: 'smoke-fluidtokens.ts',          category: 'chain', parallelSafe: false, timeoutMs: 120_000 },
  // Liqwid v2 reads 3 singleton MarketState UTxOs (one per stable market) +
  // a single GraphQL fanout for APY. Way lighter than FluidTokens — 30s ample.
  { name: 'liqwid',               file: 'smoke-liqwid.ts',               category: 'chain', parallelSafe: false, timeoutMs: 30_000 },
];

interface SmokeResult {
  job: SmokeJob;
  status: 'pass' | 'fail' | 'skip' | 'timeout';
  durationMs: number;
  exitCode: number | null;
  stderrTail?: string;
}

function runSmoke(job: SmokeJob): Promise<SmokeResult> {
  return new Promise(resolveResult => {
    const t0 = Date.now();
    const child = spawn('npx', ['tsx', resolve(__dirname, job.file)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      env: process.env,
    });
    const stderrChunks: Buffer[] = [];
    child.stderr.on('data', d => stderrChunks.push(Buffer.from(d)));
    // Drain stdout silently — keeps the parent's output clean. Set
    // VERBOSE_SMOKE=1 to forward.
    if (process.env.VERBOSE_SMOKE === '1') {
      child.stdout.on('data', d => process.stdout.write(d));
    } else {
      child.stdout.on('data', () => { /* drop */ });
    }

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolveResult({
        job, status: 'timeout', durationMs: Date.now() - t0, exitCode: null,
        stderrTail: Buffer.concat(stderrChunks).toString('utf8').slice(-500),
      });
    }, job.timeoutMs);

    child.on('exit', (code) => {
      clearTimeout(timer);
      resolveResult({
        job,
        status:     code === 0 ? 'pass' : 'fail',
        durationMs: Date.now() - t0,
        exitCode:   code,
        stderrTail: code !== 0 ? Buffer.concat(stderrChunks).toString('utf8').slice(-500) : undefined,
      });
    });
  });
}

async function main() {
  const skipChain = process.env.SKIP_CHAIN_SMOKES === '1';
  const skipHttp  = process.env.SKIP_HTTP_SMOKES  === '1';

  console.log('CHAINFEED smoke-all');
  console.log('───────────────────────────────────────────────────────');

  const filtered = SMOKES.filter(s => {
    if (skipChain && s.category === 'chain') return false;
    if (skipHttp  && s.category === 'http')  return false;
    return true;
  });

  if (filtered.length === 0) {
    console.log('  (no smokes to run — everything skipped via env)');
    process.exit(0);
  }

  // Parallel batch: all parallelSafe smokes at once.
  const parallel = filtered.filter(s => s.parallelSafe);
  const sequential = filtered.filter(s => !s.parallelSafe);

  const results: SmokeResult[] = [];
  if (parallel.length > 0) {
    console.log(`  running ${parallel.length} HTTP smoke(s) in parallel…`);
    const parallelResults = await Promise.all(parallel.map(runSmoke));
    results.push(...parallelResults);
    for (const r of parallelResults) {
      const flag = r.status === 'pass' ? '✓' : '✗';
      console.log(`    ${flag} ${r.job.name.padEnd(22)} ${(r.durationMs / 1000).toFixed(1)}s`);
    }
  }
  if (sequential.length > 0) {
    console.log(`  running ${sequential.length} chain smoke(s) sequentially…`);
    for (const job of sequential) {
      const r = await runSmoke(job);
      results.push(r);
      const flag = r.status === 'pass' ? '✓' : '✗';
      console.log(`    ${flag} ${r.job.name.padEnd(22)} ${(r.durationMs / 1000).toFixed(1)}s`);
    }
  }

  console.log('───────────────────────────────────────────────────────');
  const passCount = results.filter(r => r.status === 'pass').length;
  const failures  = results.filter(r => r.status !== 'pass');

  console.log(`  ${passCount}/${results.length} smokes passed`);

  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const r of failures) {
      console.log(`  - ${r.job.name} (${r.status}, exit=${r.exitCode}, ${(r.durationMs / 1000).toFixed(1)}s)`);
      if (r.stderrTail) {
        console.log(`    stderr tail:`);
        for (const line of r.stderrTail.split('\n').slice(-5)) {
          console.log(`      ${line}`);
        }
      }
    }
    process.exit(1);
  }

  console.log('  PASS');
  process.exit(0);
}

main().catch(err => {
  console.error('runner crash:', err);
  process.exit(2);
});
