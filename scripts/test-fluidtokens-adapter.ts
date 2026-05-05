/**
 * FluidTokens adapter integration test.
 *
 * Bridge `getUtxosAtCredential` is monkey-patched (the bridge uses
 * `export = {...}` to support exactly this pattern). We assert:
 *   - getPrice('FLUIDTOKENS-POOLS') aggregates pools and skips
 *     UTxOs without the pool-NFT
 *   - getPrice('FLUIDTOKENS-LOANS') aggregates loans and skips
 *     UTxOs without the loan-NFT
 *   - rejects unsupported pair, supportsPair contract
 *   - propagates bridge errors
 *   - perAsset rollup buckets by principal-asset key correctly
 *   - composite computeFluidHealth applies finance.ak per loan
 *
 * Run: npx tsx scripts/test-fluidtokens-adapter.ts
 */

import assert from 'node:assert/strict';
import * as CSL from '@emurgo/cardano-serialization-lib-nodejs';

let n = 0, fails = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  n++;
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (e) {
    fails++;
    const err = e as Error;
    console.log(`FAIL  ${name}\n      ${err.stack || err.message}`);
  }
}

// ── CSL helpers ──────────────────────────────────────────────────────

const intD  = (n: bigint) => CSL.PlutusData.new_integer(CSL.BigInt.from_str(n.toString()));
const bytesD = (hex: string) => CSL.PlutusData.new_bytes(Buffer.from(hex, 'hex'));
function constrD(alt: number, fields: CSL.PlutusData[]): CSL.PlutusData {
  const list = CSL.PlutusList.new();
  for (const f of fields) list.add(f);
  return CSL.PlutusData.new_constr_plutus_data(
    CSL.ConstrPlutusData.new(CSL.BigNum.from_str(String(alt)), list),
  );
}
function listD(items: CSL.PlutusData[]): CSL.PlutusData {
  const list = CSL.PlutusList.new();
  for (const f of items) list.add(f);
  return CSL.PlutusData.new_list(list);
}

const ADA  = { policyId: '', assetNameHex: '' };
const USDM = { policyId: 'c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad', assetNameHex: '0014df105553444d' };
const ORACLE_USDM = { policyId: '93794f9b7f3dc632cb889c7aec7d334f016f532e64f16141b6895f5b', assetNameHex: '6f7261636c65555344' };

function assetD(a: { policyId: string; assetNameHex: string }) {
  return constrD(0, [bytesD(a.policyId), bytesD(a.assetNameHex)]);
}
function collateralAssetD(a: typeof ADA, oracle: typeof ADA) {
  return constrD(0, [assetD(a), constrD(1, []), assetD(oracle)]);
}

function buildPoolDatum(opts: { principalAsset: typeof ADA; interestRate: number }): string {
  const cd = constrD(0, [
    assetD(opts.principalAsset),
    assetD(ORACLE_USDM),
    intD(BigInt(opts.interestRate)),
    intD(0n), intD(0n), intD(0n),
    constrD(2, [intD(100n), intD(125n), intD(100n)]),
    constrD(2, [intD(28n), intD(5n)]),
    intD(0n), intD(0n),
    constrD(0, []),
  ]);
  const lenderAuth = constrD(0, [bytesD('00'.repeat(28))]);
  const lenderBondAddr = constrD(0, [
    constrD(0, [bytesD('00'.repeat(28))]),
    constrD(0, [constrD(0, [constrD(0, [bytesD('00'.repeat(28))])])]),
  ]);
  return constrD(0, [
    bytesD('4e4f4e45'),
    constrD(0, []),
    cd,
    lenderAuth,
    lenderBondAddr,
    bytesD('00'.repeat(32)),
    listD([collateralAssetD(ADA, ADA)]),
    listD([intD(100n)]),
    listD([intD(150n)]),
    constrD(0, []),
  ]).to_hex();
}

function buildLoanDatum(opts: {
  principal: bigint; lendDateMs: number;
  principalAsset: typeof ADA;
  interestRate: number;
  poolIdHex: string;
}): string {
  return constrD(0, [
    intD(0n),
    intD(opts.principal),
    intD(BigInt(opts.lendDateMs)),
    intD(0n),
    intD(BigInt(opts.interestRate)),
    intD(0n),
    assetD(opts.principalAsset),
    assetD(ORACLE_USDM),
    intD(0n), intD(0n),
    constrD(2, [intD(100n), intD(125n), intD(100n)]),
    constrD(2, [intD(28n), intD(5n)]),
    intD(0n), intD(0n),
    constrD(0, []),
    bytesD(opts.poolIdHex),
    constrD(0, [bytesD(''), constrD(0, [bytesD('')]), constrD(0, [bytesD(''), bytesD('')])]),
  ]).to_hex();
}

const FLUID = require('../srv/lib/fluidtokens-config').FLUIDTOKENS_CONFIG.mainnet;

// Build a bridge-shape UTxO with the right pool/loan NFT.
function bridgeUtxoWithNft(opts: {
  txHash?: string; outputIndex?: number;
  policyId: string; nftAssetNameHex: string;
  lovelace: string;
  datumHex: string;
  extraAssets?: Array<{ unit: string; policyId: string; assetNameHex: string; quantity: string }>;
}) {
  const assets = [
    {
      unit: opts.policyId + opts.nftAssetNameHex,
      policyId: opts.policyId,
      assetNameHex: opts.nftAssetNameHex,
      quantity: '1',
    },
    ...(opts.extraAssets ?? []),
  ];
  return {
    txHash:         opts.txHash ?? 'aa'.repeat(32),
    outputIndex:    opts.outputIndex ?? 0,
    lovelace:       opts.lovelace,
    inlineDatumHex: opts.datumHex,
    assets,
  };
}

async function main() {
  process.env.FLUIDTOKENS_NETWORK = 'mainnet';

  const bridge = require('../srv/external/odatano-bridge');
  const orig = { getUtxosAtCredential: bridge.getUtxosAtCredential };
  // Per-call queue keyed by credential — pool first, loan second when both
  // are queried in sequence.
  const utxoMap = new Map<string, Array<Record<string, unknown>> | Error>();
  bridge.getUtxosAtCredential = async (cred: string) => {
    const v = utxoMap.get(cred);
    if (!v) return [];
    if (v instanceof Error) throw v;
    return v;
  };

  const ft = require('../srv/adapters/fluidtokens');
  const { computeFluidHealth } = require('../srv/lib/fluidtokens-health');

  console.log('fluidtokens adapter ──────────────────────────────────────');

  await t('getPrice(FLUIDTOKENS-POOLS): 2 valid pools + 1 unauth (no NFT) skipped', async () => {
    utxoMap.set(FLUID.poolSpendHash, [
      // Authentic ADA pool with pool-NFT
      bridgeUtxoWithNft({
        policyId: FLUID.poolPolicy,
        nftAssetNameHex: '01'.repeat(28),
        lovelace: '500000000',
        datumHex: buildPoolDatum({ principalAsset: ADA, interestRate: 500 }),
      }),
      // Authentic USDM pool — has 1000 USDM in extraAssets
      bridgeUtxoWithNft({
        policyId: FLUID.poolPolicy,
        nftAssetNameHex: '02'.repeat(28),
        lovelace: '2000000',  // minADA-ish
        datumHex: buildPoolDatum({ principalAsset: USDM, interestRate: 600 }),
        extraAssets: [{
          unit: USDM.policyId + USDM.assetNameHex,
          policyId: USDM.policyId,
          assetNameHex: USDM.assetNameHex,
          quantity: '1000000000',  // 1000 USDM (6-decimal)
        }],
      }),
      // Bogus UTxO without pool-NFT — should be skipped
      { txHash: 'cc'.repeat(32), outputIndex: 0,
        lovelace: '999999999', inlineDatumHex: buildPoolDatum({ principalAsset: ADA, interestRate: 700 }),
        assets: [] },
    ]);

    const q = await ft.getPrice('FLUIDTOKENS-POOLS');
    assert.equal(q.kind, 'attestation');
    assert.equal(q.unit, 'count');
    assert.equal(q.value, 2);

    const raw = q.rawPayload as {
      poolCount: number;
      perAsset: Record<string, { count: number; availableRaw: string; lovelace: string }>;
      pools: Array<{ poolIdHex: string; lovelace: string; availablePrincipalRaw: string; principalAsset: typeof ADA }>;
      utxoStats: { totalUtxos: number; skippedNoPoolNft: number; decoded: number };
    };
    assert.equal(raw.poolCount, 2);
    assert.equal(raw.utxoStats.totalUtxos, 3);
    assert.equal(raw.utxoStats.skippedNoPoolNft, 1);
    assert.equal(raw.utxoStats.decoded, 2);
    assert.equal(raw.perAsset.ADA!.count, 1);
    assert.equal(raw.perAsset.ADA!.availableRaw, '500000000');
    const usdmKey = (USDM.policyId + USDM.assetNameHex).toLowerCase();
    assert.equal(raw.perAsset[usdmKey]!.count, 1);
    assert.equal(raw.perAsset[usdmKey]!.availableRaw, '1000000000');
  });

  await t('getPrice(FLUIDTOKENS-LOANS): valid loan + skipped non-NFT', async () => {
    utxoMap.set(FLUID.loanSpendHash, [
      bridgeUtxoWithNft({
        policyId: FLUID.loanPolicy,
        nftAssetNameHex: 'a1'.repeat(28),
        lovelace: '1000000000',  // 1000 ADA collateral
        datumHex: buildLoanDatum({
          principal: 50_000_000n, lendDateMs: 1_000_000_000_000,
          principalAsset: USDM, interestRate: 400,
          poolIdHex: '504f4f4c' + '00'.repeat(26),
        }),
      }),
      // No loan-NFT — skipped
      { txHash: 'dd'.repeat(32), outputIndex: 0,
        lovelace: '50000000',
        inlineDatumHex: buildLoanDatum({
          principal: 1n, lendDateMs: 0,
          principalAsset: ADA, interestRate: 0,
          poolIdHex: '00'.repeat(30),
        }),
        assets: [] },
    ]);

    const q = await ft.getPrice('FLUIDTOKENS-LOANS');
    assert.equal(q.kind, 'attestation');
    assert.equal(q.value, 1);
    const raw = q.rawPayload as {
      loanCount: number;
      perAsset: Record<string, { count: number; outstandingRaw: string; collateralLovelace: string }>;
      loans: Array<{ loanIdHex: string; principal: string; collateralLovelace: string }>;
      utxoStats: { totalUtxos: number; skippedNoLoanNft: number; decoded: number };
    };
    assert.equal(raw.loanCount, 1);
    assert.equal(raw.utxoStats.totalUtxos, 2);
    assert.equal(raw.utxoStats.skippedNoLoanNft, 1);
    assert.equal(raw.loans[0]!.loanIdHex, 'a1'.repeat(28));
    assert.equal(raw.loans[0]!.principal, '50000000');
    assert.equal(raw.loans[0]!.collateralLovelace, '1000000000');
  });

  await t('rejects unsupported pair', async () => {
    await assert.rejects(() => ft.getPrice('FOO-BAR'), /not supported/);
  });

  await t('supportsPair: contract', () => {
    assert.equal(ft.supportsPair('FLUIDTOKENS-POOLS'), true);
    assert.equal(ft.supportsPair('FLUIDTOKENS-LOANS'), true);
    assert.equal(ft.supportsPair('ADA-USD'), false);
    assert.equal(ft.supportsPair(''), false);
  });

  await t('propagates bridge errors', async () => {
    utxoMap.set(FLUID.poolSpendHash, new Error('koios-down'));
    await assert.rejects(() => ft.getPrice('FLUIDTOKENS-POOLS'), /koios-down/);
  });

  await t('rejects unsupported network via env', async () => {
    process.env.FLUIDTOKENS_NETWORK = 'preview';
    await assert.rejects(() => ft.getPrice('FLUIDTOKENS-POOLS'), /unsupported network 'preview'/);
    process.env.FLUIDTOKENS_NETWORK = 'mainnet';
  });

  // ── Composite health endpoint ────────────────────────────────────────

  await t('computeFluidHealth: rolls up pools + loans, applies finance.ak per loan', async () => {
    utxoMap.set(FLUID.poolSpendHash, [
      bridgeUtxoWithNft({
        policyId: FLUID.poolPolicy,
        nftAssetNameHex: '01'.repeat(28),
        lovelace: '1000000000',
        datumHex: buildPoolDatum({ principalAsset: ADA, interestRate: 400 }),
      }),
    ]);
    utxoMap.set(FLUID.loanSpendHash, [
      // Healthy loan: 1000 ADA collateral, 100 ADA principal, fresh (no interest yet)
      bridgeUtxoWithNft({
        policyId: FLUID.loanPolicy,
        nftAssetNameHex: 'aa'.repeat(28),
        lovelace: '1000000000',
        datumHex: buildLoanDatum({
          principal: 100_000_000n, lendDateMs: Date.now(),
          principalAsset: ADA, interestRate: 400,
          poolIdHex: '504f4f4c' + '00'.repeat(26),
        }),
      }),
    ]);

    const result = await computeFluidHealth({
      fetchAllPools: ft._fetchAllPools,
      fetchAllLoans: ft._fetchAllLoans,
      lovelacePerPrincipalUnit: () => 1,   // ADA: raw unit = lovelace
      now: () => Date.now(),
    });
    assert.equal(result.poolsTotal, 1);
    assert.equal(result.loansTotal, 1);
    const adaRollup = result.perAsset.find((r: { key: string }) => r.key === 'ADA');
    assert.ok(adaRollup);
    assert.equal(adaRollup!.pools.count, 1);
    assert.equal(adaRollup!.loans.count, 1);
    assert.equal(adaRollup!.loans.outstandingPrincipalRaw, '100000000');
    // Fresh loan, no time elapsed → currentDebt ~= principal
    const debt = BigInt(adaRollup!.loans.currentDebtRaw);
    assert.ok(debt >= 100_000_000n && debt < 100_001_000n);
    // Healthy: collateral 1000 ADA = 1e9 lovelace, debt 100 ADA = 1e8 lovelace
    // currentLtv = 100/1000 = 10% < liquidation 100% → not liquidatable
    assert.equal(adaRollup!.loans.liquidatable, 0);
  });

  await t('computeFluidHealth: liquidatable loan flagged', async () => {
    utxoMap.set(FLUID.poolSpendHash, []);
    utxoMap.set(FLUID.loanSpendHash, [
      // Underwater: 50 ADA collateral, 100 ADA principal-equivalent debt
      bridgeUtxoWithNft({
        policyId: FLUID.loanPolicy,
        nftAssetNameHex: 'bb'.repeat(28),
        lovelace: '50000000',  // 50 ADA
        datumHex: buildLoanDatum({
          principal: 100_000_000n, lendDateMs: Date.now(),
          principalAsset: ADA, interestRate: 400,
          poolIdHex: '504f4f4c' + '01'.repeat(26),
        }),
      }),
    ]);

    const result = await computeFluidHealth({
      fetchAllPools: ft._fetchAllPools,
      fetchAllLoans: ft._fetchAllLoans,
      lovelacePerPrincipalUnit: () => 1,   // ADA: raw unit = lovelace
    });
    const r = result.perAsset.find((x: { key: string }) => x.key === 'ADA');
    assert.equal(r!.loans.liquidatable, 1);
    assert.ok(result.alerts.some((a: string) => a === 'fluidtokens-ADA-liquidatable-1' || a === 'fluidtokens-ADA-orphan-loans'));
  });

  bridge.getUtxosAtCredential = orig.getUtxosAtCredential;
  console.log(`\n${n - fails}/${n} passed`);
  process.exit(fails ? 1 : 0);
}

main().catch(err => { console.error('runner crash:', err); process.exit(2); });
