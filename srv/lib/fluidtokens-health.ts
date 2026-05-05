/**
 * FluidTokens lending health — composite orchestrator.
 *
 * Pure orchestration; takes injected dependencies (pool/loan fetchers,
 * optional ADA-USD reference, optional clock) so it's testable without
 * booting CAP or the bridge. Mirrors the shape of `stable-health.ts`.
 *
 * Per-asset rollup:
 *   - Aggregate pool count + available principal per principal-asset.
 *   - For each loan, apply finance.ak to compute current outstanding
 *     debt (perpetual or installment), LTV (when collateral is ADA and
 *     ADA-USD reference is provided), and liquidation eligibility.
 *   - Bucket loans into health states (healthy / underwater / liquidatable).
 */

import {
  perpetualRemainingDebt, installmentRemainingDebt,
  isRepaymentLate, canLiquidate,
  _consts,
} from './fluidtokens-finance';
import type { DecodedAsset } from './fluidtokens-decoder';

// ── Injected dependency shapes ───────────────────────────────────────

interface PoolSnapshotLike {
  poolIdHex: string;
  txHash: string;
  outputIndex: number;
  lovelace: bigint;
  availablePrincipalRaw: bigint;
  datum: {
    isPermissioned: boolean;
    commonData: {
      principalAsset: DecodedAsset;
      interestRate: number;
      installmentPeriod: number;
      totalInstallments: number;
      initialGracePeriod: number;
      repaymentTimeWindow: number;
      penaltyFeeForLateRepayment: number;
      liquidationMode:
        | { kind: 'no-liquidation-full-collateral-claim' }
        | { kind: 'no-liquidation-dutch-auction-claim' }
        | { kind: 'liquidation'; ltv: number; penaltyPerMille: number; equityCurrency: number };
      repaymentMode:
        | { kind: 'interest-on-remaining-principal'; recasts: number }
        | { kind: 'principal-and-interest-on-installments' }
        | { kind: 'perpetual'; apyIncreaseLinearCoefficient: number };
    };
    collateralOptions: Array<{ asset: DecodedAsset; oracleTokenAsset: DecodedAsset }>;
  };
}

interface LoanSnapshotLike {
  loanIdHex: string;
  txHash: string;
  outputIndex: number;
  collateralLovelace: bigint;
  poolIdHex: string;
  datum: {
    principal: bigint;
    lendDateMs: number;
    repaidInstallments: number;
    interestRate: number;
    principalAsset: DecodedAsset;
    installmentPeriod: number;
    totalInstallments: number;
    liquidationMode:
      | { kind: 'no-liquidation-full-collateral-claim' }
      | { kind: 'no-liquidation-dutch-auction-claim' }
      | { kind: 'liquidation'; ltv: number; penaltyPerMille: number; equityCurrency: number };
    repaymentMode:
      | { kind: 'interest-on-remaining-principal'; recasts: number }
      | { kind: 'principal-and-interest-on-installments' }
      | { kind: 'perpetual'; apyIncreaseLinearCoefficient: number };
  };
}

export interface FluidHealthDeps {
  fetchAllPools: () => Promise<{ pools: PoolSnapshotLike[]; totalUtxos: number }>;
  fetchAllLoans: () => Promise<{ loans: LoanSnapshotLike[]; totalUtxos: number }>;
  /** Lovelace per 1 unit of the principal asset. e.g. for USDCx (6-decimal,
   *  $1 peg) at ADA=$0.247: 1 USDCx = 1/0.247 ADA ≈ 4_048_582 lovelace.
   *  Caller computes this externally from the price-fanout if available;
   *  null/undefined disables LTV computation for that asset. */
  lovelacePerPrincipalUnit?: (asset: DecodedAsset) => number | null | undefined;
  /** Override Date.now() for deterministic snapshots. */
  now?: () => number;
  log?: (level: 'warn' | 'info', msg: string) => void;
}

// ── Public output shape ──────────────────────────────────────────────

export interface AssetRollup {
  /** "ADA" for ADA, otherwise lowercase hex unit. */
  key: string;
  principalAsset: DecodedAsset;
  pools: {
    count: number;
    /** Sum of available principal across all pools (raw units). */
    availableRaw: string;
    /** Sum of lovelace held by these pools. */
    lovelace: string;
    /** Permissioned pools (KYC-restricted) within the asset. */
    permissionedCount: number;
  };
  loans: {
    count: number;
    /** Sum of outstanding principal at origination (raw units). */
    outstandingPrincipalRaw: string;
    /** Sum of current debt computed via finance.ak (raw units). */
    currentDebtRaw: string;
    collateralLovelace: string;
    /** Loans where currentLtv > liquidationLtv (when computable). */
    liquidatable: number;
    /** Loans whose isRepaymentLate fires (installment loans only). */
    late: number;
  };
}

export interface FluidHealthResult {
  computedAtMs: number;
  poolsTotal: number;
  loansTotal: number;
  /** Sorted by loan-count descending, then pool-count descending. */
  perAsset: AssetRollup[];
  alerts: string[];
}

// ── Implementation ───────────────────────────────────────────────────

function principalKey(a: DecodedAsset): string {
  if (a.policyId === '' && a.assetNameHex === '') return 'ADA';
  return (a.policyId + a.assetNameHex).toLowerCase();
}

export async function computeFluidHealth(deps: FluidHealthDeps): Promise<FluidHealthResult> {
  const now = deps.now ?? Date.now;
  const nowMs = now();

  // Fetch in parallel.
  const [poolsR, loansR] = await Promise.all([
    deps.fetchAllPools(),
    deps.fetchAllLoans(),
  ]);

  // Bucket pools by principal-asset.
  type PoolBucket = {
    asset: DecodedAsset;
    count: number; permissionedCount: number;
    availableRaw: bigint; lovelace: bigint;
  };
  const poolBuckets = new Map<string, PoolBucket>();
  for (const p of poolsR.pools) {
    const key = principalKey(p.datum.commonData.principalAsset);
    const b = poolBuckets.get(key) ?? {
      asset: p.datum.commonData.principalAsset,
      count: 0, permissionedCount: 0,
      availableRaw: 0n, lovelace: 0n,
    };
    b.count++;
    if (p.datum.isPermissioned) b.permissionedCount++;
    b.availableRaw += p.availablePrincipalRaw;
    b.lovelace     += p.lovelace;
    poolBuckets.set(key, b);
  }

  // Bucket loans by principal-asset, applying finance.ak math per loan.
  type LoanBucket = {
    asset: DecodedAsset;
    count: number;
    outstandingPrincipalRaw: bigint;
    currentDebtRaw: bigint;
    collateralLovelace: bigint;
    liquidatable: number;
    late: number;
  };
  const loanBuckets = new Map<string, LoanBucket>();

  for (const l of loansR.loans) {
    const key = principalKey(l.datum.principalAsset);
    const b = loanBuckets.get(key) ?? {
      asset: l.datum.principalAsset,
      count: 0,
      outstandingPrincipalRaw: 0n,
      currentDebtRaw: 0n,
      collateralLovelace: 0n,
      liquidatable: 0,
      late: 0,
    };
    b.count++;
    b.outstandingPrincipalRaw += l.datum.principal;
    b.collateralLovelace      += l.collateralLovelace;

    // Current debt via finance.ak.
    let currentDebt = l.datum.principal;
    try {
      if (l.datum.repaymentMode.kind === 'perpetual') {
        currentDebt = perpetualRemainingDebt({
          principal: l.datum.principal,
          lendDateMs: l.datum.lendDateMs,
          nowMs,
          interestRate: l.datum.interestRate,
          apyIncreaseLinearCoefficient: l.datum.repaymentMode.apyIncreaseLinearCoefficient,
          initialGracePeriod: 0,    // not surfaced on Loan datum; safe lower bound for accrued debt
          installmentPeriod: l.datum.installmentPeriod,
          repaidInstallments: l.datum.repaidInstallments,
        });
      } else {
        const amortizing = l.datum.repaymentMode.kind === 'interest-on-remaining-principal';
        // For installment loans we need the late-flag to know whether to
        // apply the per-installment penalty.
        const late = isRepaymentLate({
          isPerpetualLoan: false,
          nowMs,
          lendDateMs: l.datum.lendDateMs,
          initialGracePeriod: 0,
          installmentPeriod: l.datum.installmentPeriod,
          repaidInstallments: l.datum.repaidInstallments,
          repaymentTimeWindow: 0,
        });
        if (late) b.late++;
        currentDebt = installmentRemainingDebt({
          principal: l.datum.principal,
          interestRate: l.datum.interestRate,
          totalInstallments: l.datum.totalInstallments,
          repaidInstallments: l.datum.repaidInstallments,
          penaltyFeeForLateRepayment: 0,
        }, amortizing, late);
      }
    } catch (err) {
      deps.log?.('warn', `loan ${l.loanIdHex} debt calc failed: ${(err as Error).message}`);
      currentDebt = l.datum.principal;
    }
    b.currentDebtRaw += currentDebt;

    // Liquidation check — only meaningful when collateral is ADA AND we
    // have a price reference for the principal asset. Cardano-native
    // collateral other than ADA would need its own oracle; out of scope here.
    if (l.datum.liquidationMode.kind === 'liquidation' && deps.lovelacePerPrincipalUnit) {
      const rate = deps.lovelacePerPrincipalUnit(l.datum.principalAsset);
      if (rate && Number.isFinite(rate) && rate > 0) {
        const { canLiquidate: liq } = canLiquidate({
          remainingDebt: currentDebt,
          collateralLovelace: l.collateralLovelace,
          liquidationLtv: l.datum.liquidationMode.ltv,
          lovelacePerPrincipalUnit: rate,
        });
        if (liq) b.liquidatable++;
      }
    }
    loanBuckets.set(key, b);
  }

  // Merge into per-asset rollups (union of pool-keys and loan-keys).
  const allKeys = new Set([...poolBuckets.keys(), ...loanBuckets.keys()]);
  const perAsset: AssetRollup[] = [];
  for (const key of allKeys) {
    const pb = poolBuckets.get(key);
    const lb = loanBuckets.get(key);
    perAsset.push({
      key,
      principalAsset: pb?.asset ?? lb!.asset,
      pools: {
        count:        pb?.count ?? 0,
        availableRaw: (pb?.availableRaw ?? 0n).toString(),
        lovelace:     (pb?.lovelace     ?? 0n).toString(),
        permissionedCount: pb?.permissionedCount ?? 0,
      },
      loans: {
        count:                   lb?.count ?? 0,
        outstandingPrincipalRaw: (lb?.outstandingPrincipalRaw ?? 0n).toString(),
        currentDebtRaw:          (lb?.currentDebtRaw          ?? 0n).toString(),
        collateralLovelace:      (lb?.collateralLovelace      ?? 0n).toString(),
        liquidatable:            lb?.liquidatable ?? 0,
        late:                    lb?.late         ?? 0,
      },
    });
  }
  perAsset.sort((a, b) => (b.loans.count - a.loans.count) || (b.pools.count - a.pools.count));

  // Alerts (string-stable identifiers consumers can match on).
  const alerts: string[] = [];
  for (const r of perAsset) {
    if (r.loans.liquidatable > 0)            alerts.push(`fluidtokens-${r.key}-liquidatable-${r.loans.liquidatable}`);
    if (r.loans.late > 0)                    alerts.push(`fluidtokens-${r.key}-late-${r.loans.late}`);
    if (r.pools.count === 0 && r.loans.count > 0) alerts.push(`fluidtokens-${r.key}-orphan-loans`);
  }

  return {
    computedAtMs: nowMs,
    poolsTotal: poolsR.pools.length,
    loansTotal: loansR.loans.length,
    perAsset,
    alerts,
  };
}

// Re-export consts for tests.
export const _financeConsts = _consts;
