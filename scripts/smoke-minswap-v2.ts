/**
 * Live smoke for the new Minswap V2 direct adapter.
 *
 * Runs each supported pair through the adapter, hitting Koios via the
 * ODATANO bridge. Cross-checks each spot against WingRiders V2 (also
 * direct, also constant-product) — if both adapters return live
 * mainnet pool data within ~1.5 % of each other, math + pool selection
 * is sane.
 */

import minswapV2 from '../srv/adapters/minswap-v2';
import wingriders from '../srv/adapters/wingriders';
import type { PriceQuote } from '../srv/adapters/types';

const PAIRS = ['ADA-USDM', 'ADA-USDA', 'ADA-DJED', 'ADA-iUSD', 'ADA-USDCx'] as const;

let n = 0, fails = 0;
async function t(name: string, fn: () => Promise<void>) {
  n++;
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (e) { fails++; console.log(`FAIL  ${name}\n      ${(e as Error)?.message ?? e}`); }
}

async function main() {
  console.log('Minswap V2 — live ─────────────────────────────────────');

  // Cold reads — pull each pair, confirm finite + on-peg.
  for (const pair of PAIRS) {
    await t(`minswap-v2 ${pair}: live pool spot`, async () => {
      const q = (await minswapV2.getPrice(pair)) as PriceQuote;
      const rp = q.rawPayload as { adaReserve?: string; tokenReserve?: string; utxoTxHash?: string };
      const ada = Number(rp.adaReserve ?? 0) / 1e6;
      const tok = Number(rp.tokenReserve ?? 0) / 1e6;
      console.log(`        ${pair} price=${q.price.toFixed(6)}, ada=${ada.toLocaleString()}, tok=${tok.toLocaleString()}, tx=${rp.utxoTxHash?.slice(0, 12)}...`);
      if (!Number.isFinite(q.price) || q.price <= 0) throw new Error(`bad price ${q.price}`);
      if (q.price < 0.1 || q.price > 5) throw new Error(`spot ${q.price} outside expected ADA-stable band [0.1, 5]`);
    });
  }

  // Cross-check vs WingRiders for the four pairs WR also covers (USDCx is dust on WR, skip).
  for (const pair of ['ADA-USDM', 'ADA-USDA', 'ADA-DJED', 'ADA-iUSD'] as const) {
    await t(`cross-source ${pair} (minswap-v2 vs wingriders, ≤ 2% spread)`, async () => {
      const [m, w] = await Promise.all([
        minswapV2.getPrice(pair) as Promise<PriceQuote>,
        wingriders.getPrice(pair) as Promise<PriceQuote>,
      ]);
      const spread = Math.abs(m.price - w.price) / Math.min(m.price, w.price) * 100;
      console.log(`        minswap-v2=${m.price.toFixed(6)}, wingriders=${w.price.toFixed(6)}, spread=${spread.toFixed(3)}%`);
      if (spread > 2) throw new Error(`spread too wide: ${spread.toFixed(3)}%`);
    });
  }

  // supportsPair scope
  await t('supportsPair: minswap-v2 covers 5 ADA-stable pairs', async () => {
    for (const p of PAIRS) {
      if (!minswapV2.supportsPair(p)) throw new Error(`minswap-v2 should support ${p}`);
    }
    if (minswapV2.supportsPair('ADA-USD'))   throw new Error('minswap-v2 should NOT support ADA-USD (use minswap aggregator)');
    if (minswapV2.supportsPair('NIGHT-ADA')) throw new Error('minswap-v2 should NOT support NIGHT-ADA (use sundae/wingriders)');
  });

  console.log(`\n${n - fails}/${n} passed`);
  process.exit(fails ? 1 : 0);
}

main().catch(e => { console.error('runner crash:', e); process.exit(2); });
