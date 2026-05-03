/**
 * Liquidity-depth live smoke — runs the merged-pool constant-product
 * probe against real mainnet pool reserves for each indexed stable.
 *
 * Reads pool reserves via the registry's price fanout (Minswap V2 +
 * WingRiders V2 + SundaeSwap V3 — whichever support the pair) and
 * simulates the swap directly. No DexHunter, no aggregator routing.
 *
 * Prereqs:
 *   - mainnet bridge config (set "network":"mainnet" + add "koios" to
 *     backends in package.json — Minswap V2 needs Koios for pool reads).
 *   - .env.local sourced for BLOCKFROST_API_KEY.
 *
 * Run: npx tsx scripts/smoke-liquidity-depth.ts
 */

import { executableDepthForToken } from '../srv/lib/liquidity-depth';
import { STABLE_METADATA, allStableSymbols } from '../srv/lib/stable-metadata';

async function main() {
  console.log('Liquidity-depth live smoke (direct-DEX, merged-pool CP)');
  console.log('────────────────────────────────────────────────────');

  for (const sym of allStableSymbols()) {
    const meta = STABLE_METADATA[sym]!;
    const tokenId = meta.policyId + meta.assetNameHex;
    const t0 = Date.now();
    const r = await executableDepthForToken(tokenId);
    const elapsed = Date.now() - t0;

    const mid = r.midPrice !== null ? r.midPrice.toFixed(6) : 'n/a';
    const depth = r.depthAtMaxProbed
      ? `≥ ${r.depthAda.toLocaleString()} ADA`
      : `${r.depthAda.toFixed(0)} ADA`;
    console.log(`  ${sym.padEnd(6)}  mid=${mid.padStart(10)}   depth(@1%): ${depth.padEnd(20)}  (${elapsed}ms)`);

    if (r.pools.length > 0) {
      const totalAda = r.pools.reduce((s, p) => s + p.adaReserve, 0);
      console.log(`              merged from ${r.pools.length} pool(s), total ${totalAda.toLocaleString(undefined, { maximumFractionDigits: 0 })} ADA`);
      for (const p of r.pools) {
        console.log(`                ${p.source.padEnd(20)} ada=${p.adaReserve.toLocaleString(undefined, { maximumFractionDigits: 0 }).padStart(12)}  tok=${p.tokenReserve.toLocaleString(undefined, { maximumFractionDigits: 0 }).padStart(12)}`);
      }
    } else {
      console.log(`              no pool reserves available for ${meta.pegPair}`);
    }

    for (const p of r.probedPoints) {
      const slip = p.slippagePct === Infinity ? '   FAIL' : `${p.slippagePct.toFixed(2)}%`.padStart(7);
      console.log(`              probe ${String(p.amountAda).padStart(8)} ADA   eff=${p.effectivePrice.toFixed(6).padStart(9)}   slip=${slip}`);
    }
    console.log();
  }
}

main().catch(err => {
  console.error('runner crash:', err?.stack ?? err);
  process.exit(2);
});
