/**
 * Live smoke test for the three DEX adapters. Each one hits its real
 * upstream endpoint — no mocks. If any of these fail we either have an
 * outage upstream OR the API surface drifted (rotate the adapter).
 *
 * Run: npx tsx scripts/smoke-dex-adapters.ts
 */

import minswap    from '../srv/adapters/minswap';
import sundaeswap from '../srv/adapters/sundaeswap';
import dexhunter  from '../srv/adapters/dexhunter';

let n = 0, fails = 0;
async function t(name: string, fn: () => Promise<void>) {
  n++;
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (e) {
    fails++;
    console.log(`FAIL  ${name}\n      ${(e as Error)?.message ?? e}`);
  }
}

async function main() {
  console.log('DEX adapters — live ───────────────────────────────────');

  await t('minswap ADA-USD: returns finite price ~ $0.10..$5', async () => {
    const q = await minswap.getPrice('ADA-USD');
    console.log(`        price=${q.price}`);
    if (!Number.isFinite(q.price) || q.price < 0.1 || q.price > 5) {
      throw new Error(`unreasonable price ${q.price}`);
    }
    if (q.sourceName !== 'minswap') throw new Error('wrong sourceName');
  });

  await t('sundaeswap ADA-USDM: returns finite price ~ $0.10..$5', async () => {
    const q = await sundaeswap.getPrice('ADA-USDM');
    console.log(`        price=${q.price}, pool=${(q.rawPayload as { poolId?: string }).poolId}`);
    if (!Number.isFinite(q.price) || q.price < 0.1 || q.price > 5) {
      throw new Error(`unreasonable price ${q.price}`);
    }
  });

  await t('dexhunter ADA-USDM: returns finite price ~ $0.10..$5', async () => {
    const q = await dexhunter.getPrice('ADA-USDM');
    console.log(`        price=${q.price}, splits=${(q.rawPayload as { splits?: unknown[] }).splits?.length ?? 0}`);
    if (!Number.isFinite(q.price) || q.price < 0.1 || q.price > 5) {
      throw new Error(`unreasonable price ${q.price}`);
    }
  });

  await t('cross-source price agreement (sundae vs dexhunter, ≤ 5% spread)', async () => {
    const [s, d] = await Promise.all([
      sundaeswap.getPrice('ADA-USDM'),
      dexhunter.getPrice('ADA-USDM'),
    ]);
    const spread = Math.abs(s.price - d.price) / Math.min(s.price, d.price) * 100;
    console.log(`        sundae=${s.price.toFixed(6)}, dexhunter=${d.price.toFixed(6)}, spread=${spread.toFixed(3)}%`);
    if (spread > 5) throw new Error(`spread too wide: ${spread}%`);
  });

  await t('supportsPair: only configured pair', async () => {
    if (!minswap.supportsPair('ADA-USD')) throw new Error('minswap should support ADA-USD');
    if (minswap.supportsPair('ADA-USDM'))  throw new Error('minswap should NOT support ADA-USDM yet');
    if (!sundaeswap.supportsPair('ADA-USDM')) throw new Error('sundaeswap should support ADA-USDM');
    if (!dexhunter.supportsPair('ADA-USDM'))  throw new Error('dexhunter should support ADA-USDM');
  });

  console.log(`\n${n - fails}/${n} passed`);
  process.exit(fails ? 1 : 0);
}

main().catch(e => { console.error('runner crash:', e); process.exit(2); });
