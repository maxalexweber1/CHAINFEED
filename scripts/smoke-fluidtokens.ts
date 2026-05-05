/**
 * FluidTokens v3 live-mainnet smoke.
 *
 * Hits the actual ODATANO-bridge against mainnet, reads the live pool
 * + loan UTxOs, and asserts:
 *   - Pool count > 0 (the protocol is live, not empty)
 *   - At least one decoded pool has a recognized principal-asset
 *   - Loan count is reasonable (≥ 0; we don't require any to be active
 *     because the protocol is fresh — Bond mint events confirmed live
 *     2026-04-17 but loans may have been repaid by smoke time)
 *   - Composite health endpoint returns sensible per-asset rollups
 *
 * Requires:
 *   - BLOCKFROST_API_KEY set with mainnet key, OR Koios reachable
 *   - FLUIDTOKENS_NETWORK=mainnet (default — only deployed network)
 *   - package.json `cds.requires.odatano-core.network` = mainnet
 *
 * Run: npx tsx scripts/smoke-fluidtokens.ts
 */

const SHOULD_SHUTDOWN = true;

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

async function main() {
  // Force mainnet for FluidTokens regardless of NETWORK env.
  process.env.FLUIDTOKENS_NETWORK = 'mainnet';

  const ft = require('../srv/adapters/fluidtokens');
  const { computeFluidHealth } = require('../srv/lib/fluidtokens-health');
  const bridge = require('../srv/external/odatano-bridge');

  console.log('fluidtokens v3 live mainnet smoke ─────────────────────────');

  let poolsResult: { pools: Array<{ poolIdHex: string; lovelace: bigint; datum: { commonData: { principalAsset: { policyId: string; assetNameHex: string }; interestRate: number } } }>; totalUtxos: number; skippedNoDatum: number; skippedNoPoolNft: number; skippedDecode: number } | null = null;

  await t('fetchAllPools: live mainnet → ≥ 1 active pool', async () => {
    const r = await ft._fetchAllPools();
    poolsResult = r;
    console.log(`        utxos=${r.totalUtxos} pools=${r.pools.length} skipNoDatum=${r.skippedNoDatum} skipNoNft=${r.skippedNoPoolNft} skipDecode=${r.skippedDecode}`);
    if (r.pools.length > 0) {
      const sample = r.pools[0]!;
      const pa = sample.datum.commonData.principalAsset;
      const assetLabel = pa.policyId === '' ? 'ADA' : `${pa.policyId.slice(0, 8)}…/${pa.assetNameHex.slice(0, 8)}…`;
      console.log(`        sample: poolId=${sample.poolIdHex.slice(0, 12)}… principal=${assetLabel} rate=${sample.datum.commonData.interestRate} lovelace=${sample.lovelace}`);
    }
    if (r.pools.length === 0) {
      throw new Error(`expected ≥ 1 active pool on mainnet, got ${r.pools.length}`);
    }
  });

  await t('fetchAllPools: every pool has a recognizable principal asset', async () => {
    if (!poolsResult) throw new Error('previous step failed');
    for (const p of poolsResult.pools) {
      const pa = p.datum.commonData.principalAsset;
      // ADA OR a 56-char hex policyId — either is structurally valid.
      const isAda = pa.policyId === '' && pa.assetNameHex === '';
      const isNative = pa.policyId.length === 56;
      if (!isAda && !isNative) {
        throw new Error(`pool ${p.poolIdHex.slice(0, 12)} has malformed principalAsset: ${JSON.stringify(pa)}`);
      }
    }
  });

  await t('fetchAllLoans: live mainnet — count + shape', async () => {
    const r = await ft._fetchAllLoans();
    console.log(`        utxos=${r.totalUtxos} loans=${r.loans.length} skipNoDatum=${r.skippedNoDatum} skipNoNft=${r.skippedNoLoanNft} skipDecode=${r.skippedDecode}`);
    if (r.loans.length > 0) {
      const sample = r.loans[0]!;
      console.log(`        sample: loanId=${sample.loanIdHex.slice(0, 12)}… principal=${sample.datum.principal} lendDate=${new Date(sample.datum.lendDateMs).toISOString()} rate=${sample.datum.interestRate}`);
    }
    // We don't require ≥1 because all loans may have been repaid since
    // mint-day. A clean shape (totalUtxos consistent with skip counts) is
    // the actual contract.
    const accounted = r.loans.length + r.skippedNoDatum + r.skippedNoLoanNft + r.skippedDecode;
    if (accounted !== r.totalUtxos) {
      throw new Error(`utxo accounting mismatch: ${accounted} vs ${r.totalUtxos}`);
    }
  });

  await t('getPrice(FLUIDTOKENS-POOLS): wraps fetchAllPools as AttestationQuote', async () => {
    const q = await ft.getPrice('FLUIDTOKENS-POOLS');
    if (q.kind !== 'attestation') throw new Error(`expected attestation, got ${q.kind}`);
    if (q.unit !== 'count') throw new Error(`expected unit=count, got ${q.unit}`);
    if (q.value < 1) throw new Error(`expected value ≥ 1, got ${q.value}`);
    const raw = q.rawPayload as { perAsset: Record<string, { count: number; availableRaw: string }> };
    const assets = Object.keys(raw.perAsset);
    console.log(`        active assets: ${assets.length} keys (${assets.slice(0, 3).map(k => k === 'ADA' ? 'ADA' : k.slice(0, 8) + '…').join(', ')}…)`);
  });

  await t('computeFluidHealth: composite — pools + loans rolled up per-asset', async () => {
    const result = await computeFluidHealth({
      fetchAllPools: ft._fetchAllPools,
      fetchAllLoans: ft._fetchAllLoans,
      // Skip LTV computation — smoke doesn't have a price reference and
      // shouldn't depend on the price-fanout being healthy.
      lovelacePerPrincipalUnit: () => null,
    });
    console.log(`        poolsTotal=${result.poolsTotal} loansTotal=${result.loansTotal} assets=${result.perAsset.length} alerts=${result.alerts.length}`);
    if (result.poolsTotal !== (poolsResult?.pools.length ?? -1)) {
      throw new Error(`composite poolsTotal mismatch with raw fetchAllPools`);
    }
    for (const r of result.perAsset) {
      console.log(`        ${r.key.padEnd(8)} pools=${r.pools.count} loans=${r.loans.count} liquidatable=${r.loans.liquidatable} late=${r.loans.late}`);
    }
  });

  if (SHOULD_SHUTDOWN) {
    try { await bridge.shutdown(); } catch { /* best-effort */ }
  }

  console.log(`\n${n - fails}/${n} passed`);
  process.exit(fails ? 1 : 0);
}

main().catch(err => { console.error('runner crash:', err); process.exit(2); });
