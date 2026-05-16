/**
 * FluidTokens Lending V3 — datum decoders.
 *
 * PURE FUNCTIONS. Take CBOR-hex strings (or already-parsed PlutusData),
 * return typed records. Every decoder returns `null` for non-matching
 * datums (e.g. a Loan datum at the Pool address) so a single bridge call
 * can be filtered without throwing.
 *
 * Source schemas are from the audited Aiken contracts:
 *   - lib/fluidtokens/types/pool.ak           → PoolDatum, CommonData
 *   - lib/fluidtokens/types/general.ak        → CollateralAsset, modes
 *   - lib/fluidtokens/types/config.ak         → ConfigDatum (25 fields in
 *                                                 source; deployed has 22 —
 *                                                 the dutchAuction trio is
 *                                                 stubbed empty in production)
 *
 * Live samples used to lock the schema in (see test-fluidtokens-decoder.ts):
 *   - PoolDatum:  input #2 of tx db1e928a... (USDCx perpetual pool)
 *   - LoanDatum:  output #1 of tx db1e928a... (50 USDCx, 1000 ADA collateral)
 *   - ConfigDatum: ref-input #8 of tx db1e928a... (the live "parameters" UTxO)
 */

import * as CSL from '@emurgo/cardano-serialization-lib-nodejs';

// ── Shared helpers ───────────────────────────────────────────────────

function asConstr(d: CSL.PlutusData): CSL.ConstrPlutusData | null {
  return d.as_constr_plutus_data() ?? null;
}

function constrAlt(c: CSL.ConstrPlutusData): number {
  return Number(c.alternative().to_str());
}

function intStr(d: CSL.PlutusData | null): string | null {
  if (!d) return null;
  const i = d.as_integer();
  return i ? i.to_str() : null;
}

function intNum(d: CSL.PlutusData | null): number | null {
  const s = intStr(d);
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function bytesHex(d: CSL.PlutusData | null): string | null {
  if (!d) return null;
  const b = d.as_bytes();
  return b ? Buffer.from(b).toString('hex') : null;
}

function listAt(c: CSL.ConstrPlutusData, idx: number): CSL.PlutusData | null {
  const f = c.data();
  if (idx >= f.len()) return null;
  return f.get(idx);
}

// ── Asset / CollateralAsset ──────────────────────────────────────────

export interface DecodedAsset {
  policyId: string;     // hex (28 bytes for native, "" for ADA)
  assetNameHex: string; // hex (variable bytes, "" for ADA / lovelace)
}

/** Asset = Constr 0 [policyId : Bytes, assetName : Bytes]. */
export function decodeAsset(d: CSL.PlutusData): DecodedAsset | null {
  const c = asConstr(d);
  if (!c || constrAlt(c) !== 0) return null;
  const policyId = bytesHex(listAt(c, 0));
  const assetNameHex = bytesHex(listAt(c, 1));
  if (policyId === null || assetNameHex === null) return null;
  return { policyId, assetNameHex };
}

export interface DecodedCollateralAsset {
  asset: DecodedAsset;
  /** Optional asset-name override — `Just` wraps a Bytes, `Nothing` empty Constr 1. */
  assetNameOverrideHex: string | null;
  oracleTokenAsset: DecodedAsset;
}

/**
 * CollateralAsset = Constr 0 [
 *   asset                : Asset,
 *   assetNameOverride    : Maybe Bytes,    -- Constr 0 [Bytes] | Constr 1 []
 *   oracleTokenAsset     : Asset,          -- (NONE, NONE) when no oracle needed
 * ]
 *
 * Some live datums skip the override and inline the asset-name as Bytes
 * directly; we tolerate either by falling back through the field shapes.
 */
export function decodeCollateralAsset(d: CSL.PlutusData): DecodedCollateralAsset | null {
  const c = asConstr(d);
  if (!c || constrAlt(c) !== 0) return null;

  const f0 = listAt(c, 0);
  const f1 = listAt(c, 1);
  const f2 = listAt(c, 2);
  if (!f0 || !f1 || !f2) return null;

  // f0: Asset
  const asset = decodeAsset(f0);
  if (!asset) return null;

  // f1: Maybe Bytes — Constr 0 [Bytes] = Just, Constr 1 [] = Nothing.
  let assetNameOverrideHex: string | null = null;
  const overrideConstr = asConstr(f1);
  if (overrideConstr) {
    if (constrAlt(overrideConstr) === 0) {
      const inner = listAt(overrideConstr, 0);
      assetNameOverrideHex = inner ? bytesHex(inner) : null;
    }
    // alt 1 = Nothing → leave null
  } else {
    // Tolerate inlined Bytes form.
    assetNameOverrideHex = bytesHex(f1);
  }

  // f2: Asset (oracleTokenAsset)
  const oracleTokenAsset = decodeAsset(f2);
  if (!oracleTokenAsset) return null;

  return { asset, assetNameOverrideHex, oracleTokenAsset };
}

// ── Liquidation / Repayment modes ────────────────────────────────────

export type LiquidationMode =
  | { kind: 'no-liquidation-full-collateral-claim' }
  | { kind: 'no-liquidation-dutch-auction-claim' }
  | { kind: 'liquidation'; ltv: number; penaltyPerMille: number; equityCurrency: number };

export function decodeLiquidationMode(d: CSL.PlutusData): LiquidationMode | null {
  const c = asConstr(d);
  if (!c) return null;
  switch (constrAlt(c)) {
    case 0: return { kind: 'no-liquidation-full-collateral-claim' };
    case 1: return { kind: 'no-liquidation-dutch-auction-claim' };
    case 2: {
      const ltv = intNum(listAt(c, 0));
      const pen = intNum(listAt(c, 1));
      const eq  = intNum(listAt(c, 2));
      if (ltv === null || pen === null || eq === null) return null;
      return { kind: 'liquidation', ltv, penaltyPerMille: pen, equityCurrency: eq };
    }
    default: return null;
  }
}

export type RepaymentMode =
  | { kind: 'interest-on-remaining-principal'; recasts: number }
  | { kind: 'principal-and-interest-on-installments' }
  | { kind: 'perpetual'; apyIncreaseLinearCoefficient: number };

export function decodeRepaymentMode(d: CSL.PlutusData): RepaymentMode | null {
  const c = asConstr(d);
  if (!c) return null;
  switch (constrAlt(c)) {
    case 0: {
      const recasts = intNum(listAt(c, 0)) ?? 0;
      return { kind: 'interest-on-remaining-principal', recasts };
    }
    case 1: return { kind: 'principal-and-interest-on-installments' };
    case 2: {
      // Source has [Int] for perpetual but live datums use exactly two fields:
      //   [period_or_similar, apyIncreaseLinearCoefficient]
      // We require the exact length so a future 3-field variant doesn't
      // silently misread the wrong index. Bail to null (decoder semantics:
      // null = skip + surface) rather than misreport.
      const fields = c.data();
      if (fields.len() !== 2) return null;
      const apyCoeff = intNum(fields.get(1));
      return { kind: 'perpetual', apyIncreaseLinearCoefficient: apyCoeff ?? 0 };
    }
    default: return null;
  }
}

// ── CommonData ───────────────────────────────────────────────────────

export interface DecodedCommonData {
  principalAsset: DecodedAsset;
  principalOracleAsset: DecodedAsset;
  /** Annual rate in source units. 400 = 4% under the live USDCx pool. */
  interestRate: number;
  /** Hours between installments. 0 for perpetual. */
  installmentPeriod: number;
  totalInstallments: number;
  /** Hours of grace before first installment. */
  initialGracePeriod: number;
  liquidationMode: LiquidationMode;
  repaymentMode: RepaymentMode;
  /** Hours of grace per installment after due. */
  repaymentTimeWindow: number;
  /** Per-mille late-fee. */
  penaltyFeeForLateRepayment: number;
  repaymentReceipts: boolean;
}

export function decodeCommonData(d: CSL.PlutusData): DecodedCommonData | null {
  const c = asConstr(d);
  if (!c || constrAlt(c) !== 0) return null;
  const f = c.data();
  if (f.len() < 11) return null;

  const principalAsset       = decodeAsset(f.get(0));
  const principalOracleAsset = decodeAsset(f.get(1));
  if (!principalAsset || !principalOracleAsset) return null;

  const interestRate       = intNum(f.get(2));
  const installmentPeriod  = intNum(f.get(3));
  const totalInstallments  = intNum(f.get(4));
  const initialGracePeriod = intNum(f.get(5));
  if (interestRate === null || installmentPeriod === null || totalInstallments === null || initialGracePeriod === null) {
    return null;
  }

  const liquidationMode = decodeLiquidationMode(f.get(6));
  const repaymentMode   = decodeRepaymentMode(f.get(7));
  if (!liquidationMode || !repaymentMode) return null;

  const repaymentTimeWindow        = intNum(f.get(8));
  const penaltyFeeForLateRepayment = intNum(f.get(9));
  if (repaymentTimeWindow === null || penaltyFeeForLateRepayment === null) return null;

  const receiptsConstr = asConstr(f.get(10));
  const repaymentReceipts = receiptsConstr ? constrAlt(receiptsConstr) === 1 : false;

  return {
    principalAsset, principalOracleAsset,
    interestRate, installmentPeriod, totalInstallments, initialGracePeriod,
    liquidationMode, repaymentMode,
    repaymentTimeWindow, penaltyFeeForLateRepayment, repaymentReceipts,
  };
}

// ── PoolDatum ────────────────────────────────────────────────────────

export interface DecodedPoolDatum {
  /** Hex of permissioned condition script. "4e4f4e45" ("NONE" ASCII) means no KYC. */
  permissionedConditionScriptHash: string;
  isPermissioned: boolean;
  commonData: DecodedCommonData;
  /** Hex hash of the lender's bond-output inline-datum. Identifies the lender position. */
  lenderBondInlineDatumHash: string;
  collateralOptions: DecodedCollateralAsset[];
  minCollateral: number[];
  minCollateralDivider: number[];
  dynamicCollateralPrice: boolean;
}

/**
 * Decode a PoolDatum CBOR. Returns null if the datum doesn't match the
 * expected `Constr 0` shape with `commonData` decodable — sentinel
 * non-Pool-shaped datums (e.g. Request UTxOs that share the same script
 * address temporarily) get skipped silently by callers.
 */
export function decodePoolDatum(datumHex: string): DecodedPoolDatum | null {
  let root: CSL.PlutusData;
  try { root = CSL.PlutusData.from_hex(datumHex); }
  catch { return null; }
  return decodePoolDatumPD(root);
}

export function decodePoolDatumPD(root: CSL.PlutusData): DecodedPoolDatum | null {
  const outer = asConstr(root);
  if (!outer || constrAlt(outer) !== 0) return null;
  const f = outer.data();
  if (f.len() < 10) return null;

  const permHashHex = bytesHex(f.get(0));
  if (permHashHex === null) return null;
  // ASCII "NONE" sentinel = no KYC permissioning.
  const isPermissioned = permHashHex !== '4e4f4e45' && permHashHex.length === 56;

  // f.get(1) = extraData (skipped — opaque consumer-defined Data)
  const commonData = decodeCommonData(f.get(2));
  if (!commonData) return null;

  // f.get(3) = lenderAuth (we don't need it for read-only)
  // f.get(4) = lenderBondAddress (also skip)
  const lenderBondInlineDatumHash = bytesHex(f.get(5)) ?? '';

  const collOptList = f.get(6).as_list();
  if (!collOptList) return null;
  const collateralOptions: DecodedCollateralAsset[] = [];
  for (let i = 0; i < collOptList.len(); i++) {
    const co = decodeCollateralAsset(collOptList.get(i));
    if (co) collateralOptions.push(co);
  }

  const minCollList = f.get(7).as_list();
  const minDivList  = f.get(8).as_list();
  if (!minCollList || !minDivList) return null;

  const minCollateral: number[] = [];
  for (let i = 0; i < minCollList.len(); i++) {
    const v = intNum(minCollList.get(i));
    if (v !== null) minCollateral.push(v);
  }
  const minCollateralDivider: number[] = [];
  for (let i = 0; i < minDivList.len(); i++) {
    const v = intNum(minDivList.get(i));
    if (v !== null) minCollateralDivider.push(v);
  }

  const dynConstr = asConstr(f.get(9));
  const dynamicCollateralPrice = dynConstr ? constrAlt(dynConstr) === 1 : false;

  return {
    permissionedConditionScriptHash: permHashHex,
    isPermissioned,
    commonData,
    lenderBondInlineDatumHash,
    collateralOptions,
    minCollateral,
    minCollateralDivider,
    dynamicCollateralPrice,
  };
}

// ── LoanDatum ────────────────────────────────────────────────────────

export interface DecodedLoanDatum {
  /** Outstanding principal in raw units (divide by 10^decimals for whole units). */
  principal: bigint;
  /** Lend date in epoch milliseconds. */
  lendDateMs: number;
  repaidInstallments: number;
  /** Same units as PoolDatum.commonData.interestRate. */
  interestRate: number;
  principalAsset: DecodedAsset;
  principalOracleAsset: DecodedAsset;
  installmentPeriod: number;
  totalInstallments: number;
  liquidationMode: LiquidationMode;
  repaymentMode: RepaymentMode;
  /** "POOL" prefix (4 bytes ASCII) + 26 bytes pool fingerprint. */
  poolIdHex: string;
}

/**
 * Decode a Loan UTxO inline datum. The schema has more fields than we
 * surface — only the ones consumed by `srv/lib/fluidtokens-finance.ts`
 * (interest computation + LTV) are returned.
 *
 * Live sample (output #1 of tx db1e928a...) has 17 fields:
 *   [0]  unknown int (always 0 in observed samples)
 *   [1]  principal (raw units, e.g. 50_000_000 for 50 USDCx)
 *   [2]  lendDate (epoch ms)
 *   [3]  repaidInstallments
 *   [4]  interestRate (matches pool's commonData.interestRate)
 *   [5]  unknown int
 *   [6]  principalAsset
 *   [7]  principalOracleAsset
 *   [8]  installmentPeriod (or 0 for perpetual)
 *   [9]  totalInstallments (or 0 for perpetual)
 *   [10] liquidationMode (Constr0/1/2)
 *   [11] repaymentMode    (Constr0/1/2)
 *   [12-13] reserved ints
 *   [14] receipts/permissioned flag (Constr0=False)
 *   [15] poolIdHex (Bytes — "POOL" prefix + 26 bytes)
 *   [16] permissionedCondition / collateral asset (skipped)
 */
export function decodeLoanDatum(datumHex: string): DecodedLoanDatum | null {
  let root: CSL.PlutusData;
  try { root = CSL.PlutusData.from_hex(datumHex); }
  catch { return null; }
  return decodeLoanDatumPD(root);
}

export function decodeLoanDatumPD(root: CSL.PlutusData): DecodedLoanDatum | null {
  const outer = asConstr(root);
  if (!outer || constrAlt(outer) !== 0) return null;
  const f = outer.data();
  // Live samples have 17 fields. We need at least through poolIdHex (idx 15).
  if (f.len() < 16) return null;

  const principalStr = intStr(f.get(1));
  const lendDateMs   = intNum(f.get(2));
  const repaidInst   = intNum(f.get(3));
  const interestRate = intNum(f.get(4));
  if (principalStr === null || lendDateMs === null || repaidInst === null || interestRate === null) {
    return null;
  }

  const principalAsset       = decodeAsset(f.get(6));
  const principalOracleAsset = decodeAsset(f.get(7));
  if (!principalAsset || !principalOracleAsset) return null;

  const installmentPeriod = intNum(f.get(8));
  const totalInstallments = intNum(f.get(9));
  if (installmentPeriod === null || totalInstallments === null) return null;

  const liquidationMode = decodeLiquidationMode(f.get(10));
  const repaymentMode   = decodeRepaymentMode(f.get(11));
  if (!liquidationMode || !repaymentMode) return null;

  const poolIdHex = bytesHex(f.get(15));
  if (poolIdHex === null) return null;

  return {
    principal: BigInt(principalStr),
    lendDateMs,
    repaidInstallments: repaidInst,
    interestRate,
    principalAsset,
    principalOracleAsset,
    installmentPeriod,
    totalInstallments,
    liquidationMode,
    repaymentMode,
    poolIdHex,
  };
}

// ── ConfigDatum (read-only — we only use it for offline verification) ─

export interface DecodedConfigDatum {
  /** Index 4 — borrower bond policy. We hardcode this in fluidtokens-config.ts;
   *  decoder exists for offline verification of the deployed config. */
  borrowerBondPolicyId: string;
  lenderBondPolicyId: string;
  poolPolicyId: string;
  loanPolicyId: string;
  poolSpendScriptHash: string;
  loanSpendScriptHash: string;
}

export function decodeConfigDatum(datumHex: string): DecodedConfigDatum | null {
  let root: CSL.PlutusData;
  try { root = CSL.PlutusData.from_hex(datumHex); }
  catch { return null; }
  const outer = asConstr(root);
  if (!outer || constrAlt(outer) !== 0) return null;
  const f = outer.data();
  if (f.len() < 11) return null;

  const poolPolicyId         = bytesHex(f.get(2));
  const borrowerBondPolicyId = bytesHex(f.get(4));
  const lenderBondPolicyId   = bytesHex(f.get(5));
  const loanPolicyId         = bytesHex(f.get(6));
  const poolSpendScriptHash  = bytesHex(f.get(8));
  const loanSpendScriptHash  = bytesHex(f.get(10));

  if (!poolPolicyId || !borrowerBondPolicyId || !lenderBondPolicyId || !loanPolicyId || !poolSpendScriptHash || !loanSpendScriptHash) {
    return null;
  }
  return { poolPolicyId, borrowerBondPolicyId, lenderBondPolicyId, loanPolicyId, poolSpendScriptHash, loanSpendScriptHash };
}
