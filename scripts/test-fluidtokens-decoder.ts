/**
 * FluidTokens datum decoder unit tests.
 *
 * Builds synthetic CBOR datums via CSL to exercise:
 *   - Asset / CollateralAsset (Maybe Just / Nothing override)
 *   - LiquidationMode (3 variants)
 *   - RepaymentMode (3 variants)
 *   - CommonData full record
 *   - PoolDatum + LoanDatum decode + invalid-shape rejection
 *   - ConfigDatum (selected indices)
 *
 * Decoder is pure-fn → no bridge or CDS boot needed.
 *
 * Run: npx tsx scripts/test-fluidtokens-decoder.ts
 */

import assert from 'node:assert/strict';
import * as CSL from '@emurgo/cardano-serialization-lib-nodejs';

import {
  decodeAsset, decodeCollateralAsset,
  decodeLiquidationMode, decodeRepaymentMode,
  decodeCommonData, decodePoolDatum, decodeLoanDatum,
  decodeConfigDatum,
} from '../srv/lib/fluidtokens-decoder';

let n = 0, fails = 0;
function t(name: string, fn: () => void) {
  n++;
  try { fn(); console.log(`  ok  ${name}`); }
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

const ASSET_USDCx = { policyId: '1f3aec8bfe7ea4fe14c5f121e2a92e301afe414147860d557cac7e34', assetNameHex: '5553444378' };
const ORACLE_USDCx = { policyId: '93794f9b7f3dc632cb889c7aec7d334f016f532e64f16141b6895f5b', assetNameHex: '6f7261636c655553444378' };
const ADA_ASSET = { policyId: '', assetNameHex: '' };
const NIGHT_ASSET = { policyId: '0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa', assetNameHex: '4e49474854' };

function assetD(a: { policyId: string; assetNameHex: string }): CSL.PlutusData {
  return constrD(0, [bytesD(a.policyId), bytesD(a.assetNameHex)]);
}
function collateralAssetD(a: { policyId: string; assetNameHex: string }, override: string | null,
                          oracle: { policyId: string; assetNameHex: string }): CSL.PlutusData {
  const overrideD = override === null ? constrD(1, []) : constrD(0, [bytesD(override)]);
  return constrD(0, [assetD(a), overrideD, assetD(oracle)]);
}

// ── Tests ────────────────────────────────────────────────────────────

console.log('fluidtokens decoder ──────────────────────────────────────');

t('decodeAsset: USDCx', () => {
  const a = decodeAsset(assetD(ASSET_USDCx));
  assert.deepEqual(a, ASSET_USDCx);
});
t('decodeAsset: ADA (empty policy + empty name)', () => {
  const a = decodeAsset(assetD(ADA_ASSET));
  assert.deepEqual(a, ADA_ASSET);
});
t('decodeAsset: rejects non-constr (integer)', () => {
  assert.equal(decodeAsset(intD(42n)), null);
});
t('decodeAsset: rejects wrong alternative (Constr 1)', () => {
  assert.equal(decodeAsset(constrD(1, [bytesD(''), bytesD('')])), null);
});

t('decodeCollateralAsset: with Just override', () => {
  const ca = decodeCollateralAsset(collateralAssetD(NIGHT_ASSET, '4e49474854', ORACLE_USDCx));
  assert.ok(ca);
  assert.deepEqual(ca!.asset, NIGHT_ASSET);
  assert.equal(ca!.assetNameOverrideHex, '4e49474854');
  assert.deepEqual(ca!.oracleTokenAsset, ORACLE_USDCx);
});
t('decodeCollateralAsset: with Nothing override', () => {
  const ca = decodeCollateralAsset(collateralAssetD(ADA_ASSET, null, ADA_ASSET));
  assert.ok(ca);
  assert.equal(ca!.assetNameOverrideHex, null);
});

t('decodeLiquidationMode: NoLiquidationFullCollateralClaim', () => {
  assert.deepEqual(decodeLiquidationMode(constrD(0, [])), { kind: 'no-liquidation-full-collateral-claim' });
});
t('decodeLiquidationMode: NoLiquidationDutchAuctionClaim', () => {
  assert.deepEqual(decodeLiquidationMode(constrD(1, [])), { kind: 'no-liquidation-dutch-auction-claim' });
});
t('decodeLiquidationMode: Liquidation [100, 125, 100] — live USDCx pool', () => {
  const m = decodeLiquidationMode(constrD(2, [intD(100n), intD(125n), intD(100n)]));
  assert.deepEqual(m, { kind: 'liquidation', ltv: 100, penaltyPerMille: 125, equityCurrency: 100 });
});
t('decodeLiquidationMode: rejects unknown alt', () => {
  assert.equal(decodeLiquidationMode(constrD(99, [])), null);
});

t('decodeRepaymentMode: InterestOnRemainingPrincipal with recasts', () => {
  assert.deepEqual(decodeRepaymentMode(constrD(0, [intD(3n)])), { kind: 'interest-on-remaining-principal', recasts: 3 });
});
t('decodeRepaymentMode: PrincipalAndInterestOnInstallments', () => {
  assert.deepEqual(decodeRepaymentMode(constrD(1, [])), { kind: 'principal-and-interest-on-installments' });
});
t('decodeRepaymentMode: Perpetual [period, apyIncrease=5] — live USDCx', () => {
  // Live datum: Constr2 [int 28, int 5] — apyIncreaseLinearCoefficient=5 (the LAST field).
  const m = decodeRepaymentMode(constrD(2, [intD(28n), intD(5n)]));
  assert.deepEqual(m, { kind: 'perpetual', apyIncreaseLinearCoefficient: 5 });
});

t('decodeCommonData: live USDCx pool record', () => {
  const cd = decodeCommonData(constrD(0, [
    assetD(ASSET_USDCx),
    assetD(ORACLE_USDCx),
    intD(400n),                        // interestRate
    intD(0n),                          // installmentPeriod
    intD(0n),                          // totalInstallments
    intD(0n),                          // initialGracePeriod
    constrD(2, [intD(100n), intD(125n), intD(100n)]),
    constrD(2, [intD(28n), intD(5n)]),
    intD(0n), intD(0n),                // repaymentTimeWindow, penaltyFee
    constrD(0, []),                    // repaymentReceipts = false
  ]));
  assert.ok(cd);
  assert.equal(cd!.interestRate, 400);
  assert.equal(cd!.repaymentMode.kind, 'perpetual');
  assert.equal(cd!.liquidationMode.kind, 'liquidation');
  if (cd!.liquidationMode.kind === 'liquidation') {
    assert.equal(cd!.liquidationMode.ltv, 100);
    assert.equal(cd!.liquidationMode.penaltyPerMille, 125);
  }
  if (cd!.repaymentMode.kind === 'perpetual') {
    assert.equal(cd!.repaymentMode.apyIncreaseLinearCoefficient, 5);
  }
  assert.deepEqual(cd!.principalAsset, ASSET_USDCx);
});

// ── Live PoolDatum reconstruction ────────────────────────────────────

function buildLivePoolDatum(): string {
  const cd = constrD(0, [
    assetD(ASSET_USDCx),
    assetD(ORACLE_USDCx),
    intD(400n), intD(0n), intD(0n), intD(0n),
    constrD(2, [intD(100n), intD(125n), intD(100n)]),
    constrD(2, [intD(28n), intD(5n)]),
    intD(0n), intD(0n),
    constrD(0, []),
  ]);

  const lenderAuth = constrD(0, [bytesD('36982c2359c92470d61996f5438317eca8a445a164c4ac431a99eb3b')]);
  // lenderBondAddress — just an opaque Address shape (Constr0 [Constr0[bytes], ...])
  const lenderBondAddr = constrD(0, [
    constrD(0, [bytesD('36982c2359c92470d61996f5438317eca8a445a164c4ac431a99eb3b')]),
    constrD(0, [constrD(0, [constrD(0, [bytesD('cf230591199b839514289907a946baf2235d9e3f77ee0bf3f0d5741f')])])]),
  ]);

  return constrD(0, [
    bytesD('4e4f4e45'),                    // permissionedConditionScriptHash = "NONE"
    constrD(0, []),                        // extraData
    cd,                                    // commonData
    lenderAuth,                            // lenderAuth
    lenderBondAddr,                        // lenderBondAddress
    bytesD('923918e403bf43c34b4ef6b48eb2ee04babed17320d8d1b9ff9ad086e86f44ec'),
    listD([
      collateralAssetD(NIGHT_ASSET, '4e49474854', { policyId: '93794f9b7f3dc632cb889c7aec7d334f016f532e64f16141b6895f5b', assetNameHex: '6f7261636c654e69676874' }),
      collateralAssetD(ADA_ASSET, null, ADA_ASSET),
    ]),
    listD([intD(100n), intD(100n)]),       // minCollateral
    listD([intD(150n), intD(150n)]),       // minCollateralDivider
    constrD(1, []),                        // dynamicCollateralPrice = True
  ]).to_hex();
}

t('decodePoolDatum: live USDCx pool reconstruction', () => {
  const hex = buildLivePoolDatum();
  const p = decodePoolDatum(hex);
  assert.ok(p);
  assert.equal(p!.permissionedConditionScriptHash, '4e4f4e45');
  assert.equal(p!.isPermissioned, false);
  assert.equal(p!.commonData.interestRate, 400);
  assert.equal(p!.collateralOptions.length, 2);
  assert.deepEqual(p!.collateralOptions[0]!.asset, NIGHT_ASSET);
  assert.deepEqual(p!.collateralOptions[1]!.asset, ADA_ASSET);
  assert.deepEqual(p!.minCollateral, [100, 100]);
  assert.deepEqual(p!.minCollateralDivider, [150, 150]);
  assert.equal(p!.dynamicCollateralPrice, true);
});

t('decodePoolDatum: rejects garbage', () => {
  assert.equal(decodePoolDatum('182a'), null);
  assert.equal(decodePoolDatum('zzzz'), null);
});

t('decodePoolDatum: rejects wrong outer alternative', () => {
  const wrong = constrD(1, []).to_hex();
  assert.equal(decodePoolDatum(wrong), null);
});

t('decodePoolDatum: marks permissioned when hash is 28 bytes', () => {
  const cd = constrD(0, [
    assetD(ASSET_USDCx), assetD(ORACLE_USDCx),
    intD(400n), intD(0n), intD(0n), intD(0n),
    constrD(2, [intD(100n), intD(125n), intD(100n)]),
    constrD(2, [intD(28n), intD(5n)]),
    intD(0n), intD(0n), constrD(0, []),
  ]);
  const hex = constrD(0, [
    bytesD('aa'.repeat(28)),
    constrD(0, []), cd,
    constrD(0, [bytesD('00'.repeat(28))]),
    constrD(0, [constrD(0, [bytesD('00'.repeat(28))]), constrD(0, [constrD(0, [constrD(0, [bytesD('00'.repeat(28))])])])]),
    bytesD('00'.repeat(32)),
    listD([collateralAssetD(ADA_ASSET, null, ADA_ASSET)]),
    listD([intD(100n)]), listD([intD(150n)]),
    constrD(0, []),
  ]).to_hex();
  const p = decodePoolDatum(hex);
  assert.ok(p);
  assert.equal(p!.isPermissioned, true);
});

// ── LoanDatum tests ──────────────────────────────────────────────────

function buildLiveLoanDatum(opts: {
  principal: bigint;
  lendDateMs: number;
  interestRate: number;
  apyIncrease: number;
  poolIdHex: string;
}): string {
  return constrD(0, [
    intD(0n),                                                     // [0] unknown int
    intD(opts.principal),                                         // [1] principal
    intD(BigInt(opts.lendDateMs)),                                // [2] lendDate
    intD(0n),                                                     // [3] repaidInstallments
    intD(BigInt(opts.interestRate)),                              // [4] interestRate
    intD(0n),                                                     // [5] unknown int
    assetD(ASSET_USDCx),                                          // [6] principalAsset
    assetD(ORACLE_USDCx),                                         // [7] principalOracleAsset
    intD(0n), intD(0n),                                           // [8] installmentPeriod, [9] totalInstallments
    constrD(2, [intD(100n), intD(125n), intD(100n)]),             // [10] liquidationMode
    constrD(2, [intD(28n), intD(BigInt(opts.apyIncrease))]),      // [11] repaymentMode
    intD(0n), intD(0n),                                           // [12] [13]
    constrD(0, []),                                               // [14] reserved
    bytesD(opts.poolIdHex),                                       // [15] poolIdHex
    constrD(0, [bytesD(''), constrD(0, [bytesD('')]), constrD(0, [bytesD(''), bytesD('')])]),  // [16] permissionedCondition
  ]).to_hex();
}

t('decodeLoanDatum: live 50 USDCx perpetual loan reconstruction', () => {
  const hex = buildLiveLoanDatum({
    principal: 50_000_000n,
    lendDateMs: 1776533464000,
    interestRate: 400,
    apyIncrease: 5,
    poolIdHex: '504f4f4c00ac82d2a0bbecf26dcbdcd6264190de9a67d55661b8d5f9644cb45d49',
  });
  const l = decodeLoanDatum(hex);
  assert.ok(l);
  assert.equal(l!.principal, 50_000_000n);
  assert.equal(l!.lendDateMs, 1776533464000);
  assert.equal(l!.interestRate, 400);
  assert.equal(l!.repaymentMode.kind, 'perpetual');
  if (l!.repaymentMode.kind === 'perpetual') {
    assert.equal(l!.repaymentMode.apyIncreaseLinearCoefficient, 5);
  }
  assert.equal(l!.liquidationMode.kind, 'liquidation');
  assert.deepEqual(l!.principalAsset, ASSET_USDCx);
  assert.equal(l!.poolIdHex, '504f4f4c00ac82d2a0bbecf26dcbdcd6264190de9a67d55661b8d5f9644cb45d49');
});

t('decodeLoanDatum: rejects too-short field list', () => {
  const hex = constrD(0, [intD(0n), intD(1n)]).to_hex();
  assert.equal(decodeLoanDatum(hex), null);
});

t('decodeLoanDatum: rejects garbage', () => {
  assert.equal(decodeLoanDatum('zzzz'), null);
});

// ── ConfigDatum tests ────────────────────────────────────────────────

t('decodeConfigDatum: extracts the 6 indices we depend on', () => {
  const fields: CSL.PlutusData[] = [];
  for (let i = 0; i < 22; i++) {
    if (i === 1) {
      // Constr0 [Bytes] = adminCredential — tolerated as non-Bytes by decoder
      fields.push(constrD(1, [bytesD('aa'.repeat(28))]));
    } else if (i >= 16 && i <= 21) {
      fields.push(intD(0n));
    } else {
      fields.push(bytesD((i.toString().padStart(2, '0')).repeat(28)));
    }
  }
  const hex = constrD(0, fields).to_hex();
  const c = decodeConfigDatum(hex);
  assert.ok(c);
  assert.equal(c!.poolPolicyId,        '02'.repeat(28));
  assert.equal(c!.borrowerBondPolicyId, '04'.repeat(28));
  assert.equal(c!.lenderBondPolicyId,   '05'.repeat(28));
  assert.equal(c!.loanPolicyId,         '06'.repeat(28));
  assert.equal(c!.poolSpendScriptHash,  '08'.repeat(28));
  assert.equal(c!.loanSpendScriptHash,  '10'.repeat(28));
});

t('decodeConfigDatum: rejects under-length', () => {
  assert.equal(decodeConfigDatum(constrD(0, [bytesD('')]).to_hex()), null);
});

console.log(`\n${n - fails}/${n} passed`);
process.exit(fails ? 1 : 0);
