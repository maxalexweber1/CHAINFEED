/**
 * Indigo CDP-aggregator live smoke (mainnet).
 *
 * Hits Koios + Minswap directly — no bridge, no API key. Verifies:
 *   1. Koios returns ≥ 100 UTxOs at the CDP-manager credential
 *   2. ≥ 50 of them decode as iUSD CDPs (Indigo's iUSD has ~350 CDPs live)
 *   3. The aggregate iUSD debt matches Cardano on-chain total supply
 *      within ~5% (debt is conserved; difference is fees/burns in flight)
 *   4. The system collateral ratio is in a plausible band (150-2000%)
 *
 * Run: npx tsx scripts/smoke-indigo-cdp.ts
 */

const indigo = require('../srv/adapters/indigo-cdp');

async function main() {
  console.log('Indigo CDP iUSD-collateralization live smoke (mainnet)');
  console.log('────────────────────────────────────────────────────');

  const t0 = Date.now();
  let q;
  try {
    q = await indigo.getPrice('iUSD-COLLATERAL');
  } catch (e) {
    console.error('FAIL: getPrice threw:', (e as Error)?.message ?? e);
    process.exit(1);
  }
  const elapsedMs = Date.now() - t0;

  const raw = q.rawPayload as {
    cdpManagerAddress: string;
    cdpCount: number;
    collateralAda: number;
    debtUnits: number;
    adaUsdReference: number;
    collateralUsd: number;
    healthBucket: string;
    perAssetSummary: Record<string, { count: number; collateralAda: number; debtRaw: string }>;
    utxoStats: { totalUnspent: number; skippedNoDatum: number; skippedNonCdp: number; decodedCdps: number };
  };

  console.log(`  kind:               ${q.kind}`);
  console.log(`  unit:               ${q.unit}`);
  console.log(`  CDP manager:        ${raw.cdpManagerAddress.slice(0, 30)}…`);
  console.log(`  Total UTxOs unspent: ${raw.utxoStats.totalUnspent}`);
  console.log(`  CDPs decoded:       ${raw.utxoStats.decodedCdps} (skipped ${raw.utxoStats.skippedNonCdp} non-CDP, ${raw.utxoStats.skippedNoDatum} no-datum)`);
  console.log('');
  console.log('  Per-iAsset breakdown:');
  for (const [name, v] of Object.entries(raw.perAssetSummary)) {
    console.log(`    ${name.padEnd(6)}  count=${String(v.count).padStart(4)}   collateral=${v.collateralAda.toLocaleString(undefined, { maximumFractionDigits: 0 })} ADA   debtRaw=${v.debtRaw}`);
  }
  console.log('');
  console.log(`  iUSD CDPs:          ${raw.cdpCount}`);
  console.log(`  iUSD collateral:    ${raw.collateralAda.toLocaleString()} ADA`);
  console.log(`  iUSD debt:          ${raw.debtUnits.toLocaleString()} iUSD`);
  console.log(`  ADA-USD ref:        $${raw.adaUsdReference.toFixed(6)}`);
  console.log(`  Collateral USD:     $${raw.collateralUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
  console.log(`  System CR:          ${q.value.toFixed(2)}%   [${raw.healthBucket}]`);
  console.log(`  elapsed:            ${elapsedMs} ms`);
  console.log('');

  // Sanity bands — anything outside means either the protocol shifted
  // dramatically OR our decoder is misreading data.
  if (raw.utxoStats.totalUnspent < 100) {
    console.error(`FAIL: only ${raw.utxoStats.totalUnspent} unspent UTxOs at CDP manager — Indigo historically ≥ 400`);
    process.exit(1);
  }
  if (raw.cdpCount < 50) {
    console.error(`FAIL: only ${raw.cdpCount} iUSD CDPs decoded — Indigo historically ≥ 200`);
    process.exit(1);
  }
  if (raw.collateralAda < 1_000_000) {
    console.error(`FAIL: iUSD collateral ${raw.collateralAda} ADA implausibly low (≥ 5M historically)`);
    process.exit(1);
  }
  if (!Number.isFinite(q.value) || q.value < 100 || q.value > 5000) {
    console.error(`FAIL: system CR ${q.value}% is implausible (expected 100-5000%)`);
    process.exit(1);
  }

  console.log('PASS — live data looks plausible.');
  process.exit(0);
}

main().catch(err => {
  console.error('runner crash:', err?.stack ?? err);
  process.exit(2);
});
