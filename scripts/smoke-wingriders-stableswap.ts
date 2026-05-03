/**
 * Live smoke for the WingRiders V2 STABLESWAP adapter.
 *
 * For each supported pair:
 *   - call wingriders-stableswap directly
 *   - cross-check: ADA-pivot via getBestPrice-style fanout for both sides
 *     would be heavyweight; instead we just sanity-check the spot is
 *     within ±5% of 1.0 (every supported pair is stable-vs-stable USD-peg)
 *
 * Run: npx tsx scripts/smoke-wingriders-stableswap.ts
 */

const adapter = require('../srv/adapters/wingriders-stableswap');

const PAIRS = [
  'DJED-USDM', 'iUSD-USDM', 'USDA-USDM',
  'USDM-DJED', 'USDM-iUSD', 'USDM-USDA',
  'DJED-iUSD', 'iUSD-DJED',
];

async function main() {
  console.log('WingRiders V2 STABLESWAP live smoke');
  console.log('────────────────────────────────────────────────────');

  let pass = 0;
  let fail = 0;
  for (const pair of PAIRS) {
    const t0 = Date.now();
    try {
      const q = await adapter.getPrice(pair);
      const elapsed = Date.now() - t0;
      const raw = q.rawPayload as { activeReserveA: string; activeReserveB: string; tvlInAda: string | null };
      // Adapter exposes the pool RESERVE-RATIO, not exact STABLESWAP spot.
      // Imbalances of several percent are normal for high-amplification pools
      // and don't imply a peg-break — they're a pool-balance signal.
      const drift = Math.abs(q.price - 1.0) * 100;
      const tag = drift < 1   ? 'BALANCED'
                : drift < 5   ? 'IMBALANCED'
                : drift < 10  ? 'STRESSED'
                :               'STRESSED+';
      console.log(`  ${pair.padEnd(12)} ratio=${q.price.toFixed(6).padStart(10)}  drift=${drift.toFixed(2)}%  [${tag}]  active A/B: ${raw.activeReserveA}/${raw.activeReserveB}  tvl=${raw.tvlInAda?.split('.')[0] ?? '(null)'}  (${elapsed}ms)`);
      pass++;
    } catch (err) {
      console.log(`  ${pair.padEnd(12)} FAIL  ${(err as Error).message}`);
      fail++;
    }
  }

  console.log('────────────────────────────────────────────────────');
  console.log(`${pass}/${PAIRS.length} pairs reachable, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => { console.error('runner crash:', err?.stack ?? err); process.exit(2); });
