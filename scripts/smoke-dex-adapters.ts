/**
 * Live smoke test for the DEX adapters. Each one hits its real upstream
 * endpoint — no mocks. If any of these fail we either have an outage
 * upstream OR the API surface drifted (rotate the adapter).
 *
 * Run: npx tsx scripts/smoke-dex-adapters.ts
 */

import minswap    from '../srv/adapters/minswap';
import minswapV2  from '../srv/adapters/minswap-v2';
import sundaeswap from '../srv/adapters/sundaeswap';
import wingriders from '../srv/adapters/wingriders';
import { isPriceQuote, type PriceQuote } from '../srv/adapters/types';

let n = 0, fails = 0;
async function t(name: string, fn: () => Promise<void>) {
  n++;
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (e) {
    fails++;
    console.log(`FAIL  ${name}\n      ${(e as Error)?.message ?? e}`);
  }
}

/** Fetch a quote and assert it's a usable PriceQuote. Throws if not. */
async function priceOf(adapter: { getPrice: (p: string) => Promise<unknown> }, pair: string): Promise<PriceQuote> {
  const q = (await adapter.getPrice(pair)) as PriceQuote;
  if (!isPriceQuote(q)) throw new Error(`expected PriceQuote, got ${JSON.stringify(q)}`);
  return q;
}

function inBand(q: PriceQuote, min: number, max: number): void {
  if (!Number.isFinite(q.price) || q.price <= 0) {
    throw new Error(`non-finite or non-positive price ${q.price}`);
  }
  if (q.price < min || q.price > max) {
    throw new Error(`price ${q.price} outside expected band [${min}, ${max}]`);
  }
}

async function main() {
  console.log('DEX adapters — live ───────────────────────────────────');

  // ── minswap (ADA-USD only after pivot) ───────────────────────────────
  await t('minswap ADA-USD: returns finite price ~ $0.10..$5', async () => {
    const q = await priceOf(minswap, 'ADA-USD');
    console.log(`        price=${q.price}`);
    inBand(q, 0.1, 5);
    if (q.sourceName !== 'minswap') throw new Error('wrong sourceName');
  });

  // ── sundaeswap (3 pairs: ADA-USDM, ADA-USDCx, NIGHT-ADA) ─────────────
  const sundaePairs: Array<{ pair: string; min: number; max: number }> = [
    { pair: 'ADA-USDM',  min: 0.1, max: 5 },     // USDM per ADA ≈ ADA-USD
    { pair: 'ADA-USDCx', min: 0.1, max: 5 },     // USDCx per ADA ≈ ADA-USD
    { pair: 'NIGHT-ADA', min: 1e-3, max: 5 },    // ADA per NIGHT
  ];
  for (const { pair, min, max } of sundaePairs) {
    await t(`sundaeswap ${pair}: live pool spot price`, async () => {
      const q = await priceOf(sundaeswap, pair);
      console.log(`        ${pair} price=${q.price}, pool=${(q.rawPayload as { poolId?: string }).poolId}`);
      inBand(q, min, max);
    });
  }

  // ── minswap-v2 (5 ADA-stable pairs via paginated Koios pool reads) ───
  const minswapV2Pairs: Array<{ pair: string; min: number; max: number }> = [
    { pair: 'ADA-USDM',  min: 0.1, max: 5 },
    { pair: 'ADA-USDA',  min: 0.1, max: 5 },
    { pair: 'ADA-DJED',  min: 0.1, max: 5 },
    { pair: 'ADA-iUSD',  min: 0.1, max: 5 },
    { pair: 'ADA-USDCx', min: 0.1, max: 5 },
  ];
  for (const { pair, min, max } of minswapV2Pairs) {
    await t(`minswap-v2 ${pair}: live pool spot`, async () => {
      const q = await priceOf(minswapV2, pair);
      const rp = q.rawPayload as { adaReserve?: string; tokenReserve?: string };
      const ada = Number(rp.adaReserve ?? 0) / 1e6;
      console.log(`        ${pair} price=${q.price}, ada=${ada.toLocaleString()}`);
      inBand(q, min, max);
    });
  }

  // ── wingriders (NIGHT-ADA + 4 ADA-stables) ───────────────────────────
  // ADA-stable pools on WingRiders V2 are CONSTANT_PRODUCT (verified
  // 2026-05-03), so the same naive `tokenUnits / adaUnits` math used for
  // NIGHT-ADA works for stables too. Stable-vs-stable STABLESWAP is a
  // separate adapter (`wingriders-stableswap.ts`) and a different concern.
  const wingridersPairs: Array<{ pair: string; min: number; max: number }> = [
    { pair: 'NIGHT-ADA', min: 1e-3, max: 5 },
    { pair: 'ADA-USDM',  min: 0.1,  max: 5 },
    { pair: 'ADA-USDA',  min: 0.1,  max: 5 },
    { pair: 'ADA-DJED',  min: 0.1,  max: 5 },
    { pair: 'ADA-iUSD',  min: 0.1,  max: 5 },
  ];
  for (const { pair, min, max } of wingridersPairs) {
    await t(`wingriders ${pair}: live CONSTANT_PRODUCT pool`, async () => {
      const q = await priceOf(wingriders, pair);
      const rp = q.rawPayload as { tvlInAda?: string; adaReserve?: string };
      console.log(`        ${pair} price=${q.price}, ada=${Number(rp.adaReserve ?? 0) / 1e6}, tvl=${rp.tvlInAda}`);
      inBand(q, min, max);
    });
  }

  // ── cross-source agreement ───────────────────────────────────────────
  await t('cross-source ADA-USDM (sundae vs minswap-v2, ≤ 2% spread)', async () => {
    const [s, m] = await Promise.all([
      priceOf(sundaeswap, 'ADA-USDM'),
      priceOf(minswapV2,  'ADA-USDM'),
    ]);
    const spread = Math.abs(s.price - m.price) / Math.min(s.price, m.price) * 100;
    console.log(`        sundae=${s.price.toFixed(6)}, minswap-v2=${m.price.toFixed(6)}, spread=${spread.toFixed(3)}%`);
    if (spread > 2) throw new Error(`spread too wide: ${spread}%`);
  });

  await t('cross-source ADA-USDA (minswap-v2 vs wingriders, ≤ 2% spread)', async () => {
    const [m, w] = await Promise.all([
      priceOf(minswapV2,  'ADA-USDA'),
      priceOf(wingriders, 'ADA-USDA'),
    ]);
    const spread = Math.abs(m.price - w.price) / Math.min(m.price, w.price) * 100;
    console.log(`        minswap-v2=${m.price.toFixed(6)}, wingriders=${w.price.toFixed(6)}, spread=${spread.toFixed(3)}%`);
    if (spread > 2) throw new Error(`spread too wide: ${spread}%`);
  });

  await t('cross-source NIGHT-ADA (sundae vs wingriders, ≤ 5% spread)', async () => {
    const [s, w] = await Promise.all([
      priceOf(sundaeswap,  'NIGHT-ADA'),
      priceOf(wingriders,  'NIGHT-ADA'),
    ]);
    const spread = Math.abs(s.price - w.price) / Math.min(s.price, w.price) * 100;
    console.log(`        sundae=${s.price.toFixed(6)}, wingriders=${w.price.toFixed(6)}, spread=${spread.toFixed(3)}%`);
    if (spread > 5) throw new Error(`spread too wide: ${spread}%`);
  });

  // ── supportsPair scope ───────────────────────────────────────────────
  await t('supportsPair: minswap is ADA-USD only', async () => {
    if (!minswap.supportsPair('ADA-USD'))   throw new Error('minswap should support ADA-USD');
    if (minswap.supportsPair('ADA-USDM'))   throw new Error('minswap should NOT support ADA-USDM');
    if (minswap.supportsPair('SNEK-ADA'))   throw new Error('minswap should NOT support SNEK-ADA (out of scope)');
    if (minswap.supportsPair('NIGHT-ADA'))  throw new Error('minswap should NOT support NIGHT-ADA');
  });

  await t('supportsPair: sundaeswap covers 3 stable+NIGHT pairs', async () => {
    if (!sundaeswap.supportsPair('ADA-USDM'))  throw new Error('sundae should support ADA-USDM');
    if (!sundaeswap.supportsPair('ADA-USDCx')) throw new Error('sundae should support ADA-USDCx');
    if (!sundaeswap.supportsPair('NIGHT-ADA')) throw new Error('sundae should support NIGHT-ADA');
    if (sundaeswap.supportsPair('ADA-DJED'))   throw new Error('sundae should NOT support ADA-DJED (pool dust)');
  });

  await t('supportsPair: minswap-v2 covers 5 ADA-stable pairs', async () => {
    for (const p of ['ADA-USDM', 'ADA-USDA', 'ADA-DJED', 'ADA-iUSD', 'ADA-USDCx']) {
      if (!minswapV2.supportsPair(p)) throw new Error(`minswap-v2 should support ${p}`);
    }
    if (minswapV2.supportsPair('ADA-USD'))   throw new Error('minswap-v2 should NOT support ADA-USD (use minswap aggregator)');
    if (minswapV2.supportsPair('NIGHT-ADA')) throw new Error('minswap-v2 should NOT support NIGHT-ADA');
  });

  await t('supportsPair: wingriders covers NIGHT-ADA + 4 ADA-stable pairs', async () => {
    for (const p of ['NIGHT-ADA', 'ADA-USDM', 'ADA-USDA', 'ADA-DJED', 'ADA-iUSD']) {
      if (!wingriders.supportsPair(p)) throw new Error(`wingriders should support ${p}`);
    }
    if (wingriders.supportsPair('SNEK-ADA'))   throw new Error('wingriders should NOT support SNEK-ADA');
    if (wingriders.supportsPair('ADA-USDCx'))  throw new Error('wingriders should NOT support ADA-USDCx (pool dust)');
  });

  await t('cross-source ADA-USDM (sundae vs wingriders, ≤ 5% spread)', async () => {
    const [s, w] = await Promise.all([
      priceOf(sundaeswap, 'ADA-USDM'),
      priceOf(wingriders, 'ADA-USDM'),
    ]);
    const spread = Math.abs(s.price - w.price) / Math.min(s.price, w.price) * 100;
    console.log(`        sundae=${s.price.toFixed(6)}, wingriders=${w.price.toFixed(6)}, spread=${spread.toFixed(3)}%`);
    if (spread > 5) throw new Error(`spread too wide: ${spread}%`);
  });

  console.log(`\n${n - fails}/${n} passed`);
  process.exit(fails ? 1 : 0);
}

main().catch(e => { console.error('runner crash:', e); process.exit(2); });
