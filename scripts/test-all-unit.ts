/**
 * Single-command unit-test runner — discovers every `scripts/test-*.ts` and
 * runs them in parallel. All current tests are pure (no network, no env vars
 * needed) so contention isn't an issue; if a future test breaks that property
 * we'd add a `parallelSafe` flag here, same shape as `smoke-all.ts`.
 *
 * Exits non-zero on any failure. CI-gateable.
 *
 * Run:
 *   npm run test:unit
 *   # or
 *   npx tsx scripts/test-all-unit.ts
 *
 * Output is silent on success per-test (just the OK/FAIL summary line) unless
 * VERBOSE_TEST=1 — keeps CI logs scannable.
 */

import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve, basename } from 'node:path';

interface TestJob {
  name: string;
  file: string;
  timeoutMs: number;
}

interface TestResult {
  job: TestJob;
  status: 'pass' | 'fail' | 'timeout';
  durationMs: number;
  exitCode: number | null;
  /** Last line of the test's stdout — typically the "N/M passed" summary. */
  summary?: string;
  /** Last few lines of stderr on failure. */
  errorTail?: string;
}

/** Auto-discover all scripts/test-*.ts files in this directory. */
function discover(): TestJob[] {
  const dir = __dirname;
  const files = readdirSync(dir)
    .filter(f => /^test-.+\.ts$/.test(f) && f !== 'test-all-unit.ts');
  return files.map(f => ({
    name: basename(f, '.ts').replace(/^test-/, ''),
    file: resolve(dir, f),
    timeoutMs: 60_000,    // generous default — most finish in <2s
  }));
}

function runTest(job: TestJob): Promise<TestResult> {
  return new Promise(resolveResult => {
    const t0 = Date.now();
    const child = spawn('npx', ['tsx', job.file], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      env: process.env,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on('data', d => {
      stdoutChunks.push(Buffer.from(d));
      if (process.env.VERBOSE_TEST === '1') process.stdout.write(d);
    });
    child.stderr.on('data', d => stderrChunks.push(Buffer.from(d)));

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolveResult({
        job, status: 'timeout', durationMs: Date.now() - t0, exitCode: null,
        errorTail: Buffer.concat(stderrChunks).toString('utf8').slice(-500),
      });
    }, job.timeoutMs);

    child.on('exit', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const lastLine = stdout.trim().split('\n').filter(Boolean).pop();
      resolveResult({
        job,
        status:     code === 0 ? 'pass' : 'fail',
        durationMs: Date.now() - t0,
        exitCode:   code,
        summary:    lastLine,
        errorTail:  code !== 0 ? Buffer.concat(stderrChunks).toString('utf8').slice(-500) : undefined,
      });
    });
  });
}

async function main() {
  const jobs = discover();

  console.log('CHAINFEED unit tests');
  console.log('───────────────────────────────────────────────────────');
  console.log(`  running ${jobs.length} test files in parallel…\n`);

  const results = await Promise.all(jobs.map(runTest));

  // Print summary, alphabetical by name for stable output across runs.
  const sorted = [...results].sort((a, b) => a.job.name.localeCompare(b.job.name));
  for (const r of sorted) {
    const flag = r.status === 'pass' ? '✓' : '✗';
    const t = `${(r.durationMs / 1000).toFixed(1)}s`.padStart(6);
    const summary = r.summary ?? `(${r.status})`;
    console.log(`  ${flag} ${r.job.name.padEnd(28)} ${t}   ${summary}`);
  }

  console.log('───────────────────────────────────────────────────────');
  const passCount = results.filter(r => r.status === 'pass').length;
  const failures  = results.filter(r => r.status !== 'pass');

  // Aggregate the "N/M passed" totals from each summary so we can show a
  // grand total — useful in CI badges.
  let grandPass = 0, grandTotal = 0;
  for (const r of results) {
    const m = r.summary?.match(/^(\d+)\/(\d+)\s+passed/);
    if (m) {
      grandPass  += Number(m[1]);
      grandTotal += Number(m[2]);
    }
  }

  console.log(`  ${passCount}/${results.length} files passed   ${grandPass}/${grandTotal} assertions`);

  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const r of failures) {
      console.log(`  - ${r.job.name} (${r.status}, exit=${r.exitCode})`);
      if (r.errorTail) {
        console.log('    stderr tail:');
        for (const line of r.errorTail.split('\n').slice(-5)) {
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
