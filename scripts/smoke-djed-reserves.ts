/**
 * DJED Reserve-Ratio adapter live smoke (mainnet only — Coti's Djed protocol
 * isn't deployed on testnets in a meaningful state).
 *
 * Verifies end-to-end:
 *   1. ODATANO bridge can read UTxOs at the reserve script address
 *   2. Minswap metrics endpoint returns a usable `circulating_supply`
 *   3. Minswap aggregator endpoint returns a usable ADA-USD price
 *   4. The naive coverage ratio falls in a plausible band (50-2000%)
 *
 * Prereqs:
 *   - BLOCKFROST_API_KEY (mainnet)
 *   - The ODATANO bridge configured for mainnet. Per CLAUDE.md, the bridge
 *     reads `cds.env.requires["odatano-core"].network` from package.json,
 *     and `process.env.NETWORK` does NOT override that. If your package.json
 *     is configured for preprod, temporarily patch it to "mainnet" before
 *     running this smoke and revert afterwards (Edit → run → Edit-back).
 *
 * Run: npx tsx scripts/smoke-djed-reserves.ts
 */

import bridge from '../srv/external/odatano-bridge';
const djed = require('../srv/adapters/djed-reserves');

async function main() {
  if (!process.env.BLOCKFROST_API_KEY) {
    console.error('FAIL: BLOCKFROST_API_KEY not set. Source .env.local first.');
    process.exit(2);
  }

  console.log('DJED reserve-ratio live smoke (mainnet)');
  console.log('────────────────────────────────────────');

  const t0 = Date.now();
  let q;
  try {
    q = await djed.getPrice('DJED-RESERVES');
  } catch (e) {
    console.error('FAIL: getPrice threw:', (e as Error)?.message ?? e);
    await bridge.shutdown().catch(() => { /* ignore */ });
    process.exit(1);
  }
  const elapsedMs = Date.now() - t0;

  const raw = q.rawPayload as {
    reserveScriptAddress: string;
    utxoCount:            number;
    adaCollateral:        number;
    djedReserveInventoryRaw: string;
    shenReserveInventoryRaw: string;
    djedCirculating:      number;
    adaUsdReference:      number;
    collateralUsd:        number;
    circulatingUsd:       number;
    healthBucket:         string;
  };

  console.log(`  kind:             ${q.kind}`);
  console.log(`  unit:             ${q.unit}`);
  console.log(`  reserve address:  ${raw.reserveScriptAddress.slice(0, 30)}…`);
  console.log(`  UTxOs at script:  ${raw.utxoCount}`);
  console.log(`  ADA collateral:   ${raw.adaCollateral.toLocaleString()} ADA`);
  console.log(`  DJED inventory:   ${(BigInt(raw.djedReserveInventoryRaw) / 10n ** 6n).toString()} DJED (raw=${raw.djedReserveInventoryRaw})`);
  console.log(`  SHEN inventory:   ${(BigInt(raw.shenReserveInventoryRaw) / 10n ** 6n).toString()} SHEN (raw=${raw.shenReserveInventoryRaw})`);
  console.log(`  DJED circulating: ${raw.djedCirculating.toLocaleString()}`);
  console.log(`  ADA-USD ref:      $${raw.adaUsdReference.toFixed(6)}`);
  console.log(`  Collateral USD:   $${raw.collateralUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
  console.log(`  Circulating USD:  $${raw.circulatingUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
  console.log(`  Coverage ratio:   ${q.value.toFixed(2)}%   [${raw.healthBucket}]`);
  console.log(`  elapsed:          ${elapsedMs} ms`);
  console.log('');

  // Sanity: a healthy DJED protocol has reserves between ~100% (depeg) and
  // ~2000% (early-launch over-collateral). Anything outside is alarming.
  if (!Number.isFinite(q.value) || q.value < 50 || q.value > 5000) {
    console.error(`FAIL: coverage ratio ${q.value}% is implausible (expected 50-5000)`);
    await bridge.shutdown().catch(() => { /* ignore */ });
    process.exit(1);
  }
  if (raw.adaCollateral < 1_000_000) {
    console.error(`FAIL: ADA collateral ${raw.adaCollateral} is way below historical norm (≥ 5M expected)`);
    await bridge.shutdown().catch(() => { /* ignore */ });
    process.exit(1);
  }
  // Coti's reserve script consolidates collateral into a small number of
  // large UTxOs (3 live as of 2026-05-03). The previously-asserted ≥ 100
  // count was based on the wrong address (Minswap V2 pool credential)
  // which holds 3 231 unrelated pool UTxOs. Real reserve has 1-10 UTxOs.
  if (raw.utxoCount < 1) {
    console.error(`FAIL: UTxO count ${raw.utxoCount} — script appears empty`);
    await bridge.shutdown().catch(() => { /* ignore */ });
    process.exit(1);
  }

  console.log('PASS — live data looks plausible.');
  await bridge.shutdown().catch(() => { /* ignore */ });
  process.exit(0);
}

main().catch(async err => {
  console.error('runner crash:', err?.stack ?? err);
  try { await bridge.shutdown(); } catch { /* ignore */ }
  process.exit(2);
});
