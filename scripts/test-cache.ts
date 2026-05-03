/**
 * Cache layer tests. Fake-clock pattern.
 * Run: npx tsx scripts/test-cache.ts
 */

import assert from 'node:assert/strict';
import { withCache } from '../srv/lib/cache';
import type { PriceAdapter, PriceQuote } from '../srv/adapters/types';

let n = 0, fails = 0;
async function t(name: string, fn: () => Promise<void>) {
  n++;
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (e) {
    fails++;
    const err = e as Error;
    console.log(`FAIL  ${name}\n      ${err.stack || err.message}`);
  }
}

interface StubAdapter extends PriceAdapter {
  callCount(): number;
  setNextDelay(ms: number): void;
  failNext(): void;
}

function makeStubAdapter(): StubAdapter {
  let calls = 0;
  let nextDelayMs = 0;
  let nextThrows = false;
  return {
    sourceName: 'stub',
    supportsPair: () => true,
    async getPrice(pair: string): Promise<PriceQuote> {
      calls++;
      if (nextDelayMs > 0) {
        const d = nextDelayMs; nextDelayMs = 0;
        await new Promise<void>(r => setTimeout(r, d));
      }
      if (nextThrows) { nextThrows = false; throw new Error('upstream-failed'); }
      return { kind: 'price', sourceName: 'stub', pair, price: 1.0, timestamp: Date.now(), rawPayload: { calls } };
    },
    callCount: () => calls,
    setNextDelay: (ms: number) => { nextDelayMs = ms; },
    failNext: () => { nextThrows = true; },
  };
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function main() {
console.log('cache (stale-while-revalidate) ──────────────────────────');

await t('cold miss → calls upstream once, returns quote', async () => {
  const stub = makeStubAdapter();
  const cached = withCache(stub, { ttlMs: 1000 });
  const q = await cached.getPrice('A') as PriceQuote;
  assert.equal(stub.callCount(), 1);
  assert.equal(q.price, 1.0);
});

await t('fresh hit → no upstream call', async () => {
  const stub = makeStubAdapter();
  const cached = withCache(stub, { ttlMs: 1000 });
  await cached.getPrice('A');
  await cached.getPrice('A');
  await cached.getPrice('A');
  assert.equal(stub.callCount(), 1);
});

await t('different pairs cache independently', async () => {
  const stub = makeStubAdapter();
  const cached = withCache(stub, { ttlMs: 1000 });
  await cached.getPrice('A');
  await cached.getPrice('B');
  await cached.getPrice('A');  // hit
  await cached.getPrice('B');  // hit
  assert.equal(stub.callCount(), 2);
});

await t('stale (TTL ≤ age < 2*TTL) returns cached + triggers bg refresh', async () => {
  const stub = makeStubAdapter();
  const cached = withCache(stub, { ttlMs: 50 });
  const q1 = await cached.getPrice('A');
  assert.equal(stub.callCount(), 1);

  await sleep(80);  // 80 > 50 (stale), 80 < 100 (within 2*TTL)
  const q2 = await cached.getPrice('A');
  // Stale read returns the prior quote synchronously (no upstream wait)
  assert.equal((q2.rawPayload as { calls: number }).calls, 1);

  // Background refresh should have fired — give it a moment
  await sleep(50);
  assert.equal(stub.callCount(), 2);
});

await t('very stale (age ≥ 2*TTL) blocks on refresh', async () => {
  const stub = makeStubAdapter();
  const cached = withCache(stub, { ttlMs: 30 });
  await cached.getPrice('A');
  await sleep(80);  // > 2 * 30
  const q = await cached.getPrice('A');
  assert.equal(stub.callCount(), 2);
  assert.equal((q.rawPayload as { calls: number }).calls, 2, 'should be the fresh quote, not the stale one');
});

await t('concurrent cold-miss reads dedupe to one upstream call', async () => {
  const stub = makeStubAdapter();
  stub.setNextDelay(50);
  const cached = withCache(stub, { ttlMs: 1000 });
  const [a, b, c] = await Promise.all([
    cached.getPrice('A'), cached.getPrice('A'), cached.getPrice('A'),
  ]) as [PriceQuote, PriceQuote, PriceQuote];
  assert.equal(stub.callCount(), 1, 'three concurrent miss-reads should share one upstream call');
  assert.equal(a.price, b.price);
  assert.equal(b.price, c.price);
});

await t('failed cold-miss propagates error and does not poison cache', async () => {
  const stub = makeStubAdapter();
  stub.failNext();
  const cached = withCache(stub, { ttlMs: 1000 });
  await assert.rejects(() => cached.getPrice('A'), /upstream-failed/);
  // Next call should retry (no poisoned entry)
  const q = await cached.getPrice('A') as PriceQuote;
  assert.equal(q.price, 1.0);
  assert.equal(stub.callCount(), 2);
});

await t('status(): empty before any read', async () => {
  const stub = makeStubAdapter();
  const cached = withCache(stub, { ttlMs: 1000 });
  const s = cached.status();
  assert.equal(s.sourceName, 'stub');
  assert.equal(s.ttlMs, 1000);
  assert.equal(s.cachedPairCount, 0);
  assert.deepEqual(s.pairs, []);
});

await t('status(): tracks fetched pairs with age + null error', async () => {
  const stub = makeStubAdapter();
  const cached = withCache(stub, { ttlMs: 1000 });
  await cached.getPrice('A');
  await cached.getPrice('B');
  const s = cached.status();
  assert.equal(s.cachedPairCount, 2);
  assert.deepEqual(s.pairs.map(p => p.pair).sort(), ['A', 'B']);
  for (const p of s.pairs) {
    assert.ok(p.fetchedAtIso !== null);
    assert.ok(p.ageSeconds !== null && p.ageSeconds! >= 0);
    assert.equal(p.hasInflightRefresh, false);
    assert.equal(p.lastError, null);
  }
});

await t('status(): records lastError on failed background refresh', async () => {
  const stub = makeStubAdapter();
  const cached = withCache(stub, { ttlMs: 200 });
  await cached.getPrice('A');
  await sleep(250);                     // age ≈ 250ms → stale
  stub.failNext();
  await cached.getPrice('A');           // serves stale, fires bg refresh that fails
  await sleep(50);                      // give bg refresh time to fail
  const s = cached.status();
  const a = s.pairs.find(p => p.pair === 'A')!;
  assert.ok(a.lastError !== null);
  assert.match(a.lastError!.message, /upstream-failed/);
});

await t('failed background refresh keeps stale entry usable', async () => {
  // Use a larger TTL so timing jitter (Node's setTimeout) doesn't push us
  // out of the stale-while-revalidate window into the blocking-refresh branch.
  const stub = makeStubAdapter();
  const cached = withCache(stub, { ttlMs: 200 });
  await cached.getPrice('A');           // call 1

  await sleep(250);                     // age ≈ 250ms → 200 ≤ 250 < 400 (stale, not very-stale)
  stub.failNext();
  const q = await cached.getPrice('A'); // returns stale, fires bg refresh that fails
  assert.equal((q.rawPayload as { calls: number }).calls, 1, 'should serve the stale prior quote');

  await sleep(50);                      // give the bg refresh time to fail
  assert.equal(stub.callCount(), 2, 'upstream called twice (initial + failed bg refresh)');

  // Subsequent stale read (still within stale-while-revalidate window) should
  // either serve stale + start a fresh attempt, or block on a fresh attempt.
  // Either way the prior failure must not have poisoned the cache.
  const q2 = await cached.getPrice('A');
  assert.ok(q2 != null);
});

console.log(`\n${n - fails}/${n} passed`);
process.exit(fails ? 1 : 0);
}

main();
