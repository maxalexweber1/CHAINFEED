/**
 * FluidTokens Lending V3 — finance math (TS port of `lib/fluidtokens/finance.ak`).
 *
 * Pure functions. No bridge calls, no I/O. Inputs are pre-decoded numbers
 * and BigInts; outputs are BigInts where the chain math uses integer
 * arithmetic, JS numbers where the result is bounded (LTV %, ratios).
 *
 * Source: github.com/FluidTokens/ft-cardano-loans-v3 — `lib/fluidtokens/finance.ak`
 *
 * The Aiken contract uses CDDL `Rational` types under the hood. We mirror
 * that with BigInt numerators + integer denominators per formula context
 * (per-mille, basis points, hourly fractions). The contract's
 * `interestRate` is a raw integer; in deployed pools we observe e.g. `400`
 * for the 4% USDCx pool. We treat it as **basis-points-style: rate / 10000
 * is the annual decimal rate**. If a future pool publishes a different
 * unit convention we'll need to surface a denominator field on PoolDatum.
 *
 * Time constants (matching finance.ak):
 *   1 hour = 3,600,000 ms
 *   1 year = 8760 hours
 */

const MS_PER_HOUR = 3_600_000;
const HOURS_PER_YEAR = 8760;

/** Annual rate scaling — `interestRate=400` means 4.00% APR.
 *  finance.ak treats it as a per-mille-with-decimals integer; the deployed
 *  USDCx pool observed `400` and the principal is `50e6`, suggesting the
 *  same basis-points convention as the Stable-Health code uses. */
const RATE_DENOM = 10_000;

// ── Helpers ──────────────────────────────────────────────────────────

/** BigInt ceil-divide: `ceil(a / b)` for non-negative a, b. */
function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new Error('ceilDiv: divisor must be positive');
  return (a + b - 1n) / b;
}

/** Number-fixed-point ceil — used where the source uses Rational ceil
 *  but bounded ranges make Number safe. */
function ceilNum(x: number): number {
  return Math.ceil(x);
}

// ── Public types ─────────────────────────────────────────────────────

export interface PerpetualDebtInputs {
  /** Outstanding principal in raw units (e.g. 50_000_000 for 50 USDCx with 6 decimals). */
  principal: bigint;
  /** Loan creation timestamp (epoch ms). Source field: lendDate. */
  lendDateMs: number;
  /** Current time (epoch ms). Defaults to Date.now() at call site, but
   *  we accept it as input for deterministic test snapshots. */
  nowMs: number;
  /** Annual rate (e.g. 400 = 4.00 %, divided by RATE_DENOM at compute time). */
  interestRate: number;
  /** RepaymentMode.PerpetualLoan apyIncreaseLinearCoefficient. 0 = no drift. */
  apyIncreaseLinearCoefficient: number;
  /** Hours of grace before first installment. 0 for the live USDCx pool. */
  initialGracePeriod: number;
  /** Installment period in hours. Often 0 for true-perpetual loans. */
  installmentPeriod: number;
  /** How many installments the borrower has paid back. */
  repaidInstallments: number;
}

export interface InstallmentLoanDebtInputs {
  /** Principal at loan origination (NOT outstanding — installment loans
   *  amortize to a fixed installment-amount based on origination principal). */
  principal: bigint;
  /** Annual rate. */
  interestRate: number;
  totalInstallments: number;
  repaidInstallments: number;
  /** Per-mille late fee (added to each installment after due time). */
  penaltyFeeForLateRepayment: number;
}

// ── Perpetual-loan debt ──────────────────────────────────────────────

/**
 * Remaining debt for a PerpetualLoan as of `nowMs`.
 *
 * Source formula (finance.ak, paraphrased):
 *   passedHoursSoFar = (nowMs - lendDateMs) / 3_600_000
 *   passedHoursSinceLast = passedHoursSoFar - (initialGracePeriod + installmentPeriod * repaidInstallments)
 *   c = interestRate / RATE_DENOM
 *   m = apyIncreaseLinearCoefficient / RATE_DENOM
 *   remainingInterest = principal × (c × passedHoursSinceLast + m × passedHoursSoFar²) / 8760
 *   remainingDebt     = principal + ceil(remainingInterest)
 *
 * Returns BigInt to mirror on-chain integer arithmetic. Negative
 * `passedHoursSinceLast` (e.g. still inside grace period) clamps to 0.
 */
export function perpetualRemainingDebt(inp: PerpetualDebtInputs): bigint {
  if (inp.principal < 0n) throw new Error('perpetualRemainingDebt: principal must be non-negative');
  if (inp.nowMs < inp.lendDateMs) {
    // Future-lend or out-of-order timestamps — no interest accrued yet.
    return inp.principal;
  }

  const elapsedMs = inp.nowMs - inp.lendDateMs;
  const passedHoursSoFar = elapsedMs / MS_PER_HOUR;
  const passedHoursSinceLast = Math.max(
    0,
    passedHoursSoFar - (inp.initialGracePeriod + inp.installmentPeriod * inp.repaidInstallments),
  );

  const c = inp.interestRate / RATE_DENOM;
  const m = inp.apyIncreaseLinearCoefficient / RATE_DENOM;
  const interestFraction =
    (c * passedHoursSinceLast + m * passedHoursSoFar * passedHoursSoFar) / HOURS_PER_YEAR;

  // principal × interestFraction with ceiling, in raw integer units.
  // Use Number for the fraction (bounded), apply to BigInt principal.
  if (!Number.isFinite(interestFraction) || interestFraction < 0) {
    return inp.principal;
  }

  const principalNum = Number(inp.principal);
  if (!Number.isFinite(principalNum)) {
    // Fallback for very large principals — perform the multiplication in
    // BigInt with a fixed-point intermediate.
    const SCALE = 1_000_000_000n;
    const fracScaled = BigInt(Math.round(interestFraction * Number(SCALE)));
    const interestRaw = ceilDiv(inp.principal * fracScaled, SCALE);
    return inp.principal + interestRaw;
  }
  const interestRaw = BigInt(ceilNum(principalNum * interestFraction));
  return inp.principal + interestRaw;
}

// ── Amortization (installment) loans ─────────────────────────────────

/**
 * Annuity payment per installment. Source: finance.ak
 * `get_next_installment_interest_on_remaining_principal`:
 *
 *   r = interestRate / totalInstallments / RATE_DENOM
 *   installment = ceil((principal × r × (1+r)^N) / ((1+r)^N - 1)) + penaltyFee
 *
 * `penaltyFee` is added unconditionally if the borrower is late — callers
 * must determine that with `isRepaymentLate` and pass `penaltyApplied`.
 */
export function amortizingInstallmentAmount(inp: InstallmentLoanDebtInputs, penaltyApplied: boolean): bigint {
  if (inp.totalInstallments <= 0) throw new Error('amortizing: totalInstallments must be positive');
  if (inp.principal <= 0n) return 0n;

  const r = inp.interestRate / inp.totalInstallments / RATE_DENOM;
  if (!Number.isFinite(r) || r < 0) {
    throw new Error(`amortizing: invalid per-period rate ${r}`);
  }

  const N = inp.totalInstallments;
  const onePlusR_N = Math.pow(1 + r, N);
  if (onePlusR_N <= 1) {
    // Zero-rate edge — installment is just principal / N.
    const base = ceilDiv(inp.principal, BigInt(N));
    return penaltyApplied ? base + perMilleOfBigInt(inp.principal, inp.penaltyFeeForLateRepayment) : base;
  }

  const principalNum = Number(inp.principal);
  const installmentNum = (principalNum * r * onePlusR_N) / (onePlusR_N - 1);
  const installmentRaw = BigInt(ceilNum(installmentNum));

  if (!penaltyApplied) return installmentRaw;
  return installmentRaw + perMilleOfBigInt(inp.principal, inp.penaltyFeeForLateRepayment);
}

/**
 * Simple-interest installment (alternative formula in finance.ak —
 * `get_next_installment_principal_and_interest_on_installments`):
 *
 *   totalInterest  = principal × interestRate / RATE_DENOM
 *   installment    = ceil((principal + totalInterest) / N) + penaltyFee
 */
export function simpleInterestInstallmentAmount(inp: InstallmentLoanDebtInputs, penaltyApplied: boolean): bigint {
  if (inp.totalInstallments <= 0) throw new Error('simple-interest: totalInstallments must be positive');
  if (inp.principal <= 0n) return 0n;

  const totalInterest = ceilDiv(
    inp.principal * BigInt(inp.interestRate),
    BigInt(RATE_DENOM),
  );
  const base = ceilDiv(inp.principal + totalInterest, BigInt(inp.totalInstallments));
  if (!penaltyApplied) return base;
  return base + perMilleOfBigInt(inp.principal, inp.penaltyFeeForLateRepayment);
}

/**
 * Remaining debt for an installment loan = (totalInstallments - repaidInstallments) × installmentAmount.
 * `installmentAmount` is the annuity output for the active installment.
 */
export function installmentRemainingDebt(
  inp: InstallmentLoanDebtInputs,
  amortizing: boolean,
  penaltyApplied: boolean,
): bigint {
  const left = inp.totalInstallments - inp.repaidInstallments;
  if (left <= 0) return 0n;
  const installment = amortizing
    ? amortizingInstallmentAmount(inp, penaltyApplied)
    : simpleInterestInstallmentAmount(inp, penaltyApplied);
  return BigInt(left) * installment;
}

function perMilleOfBigInt(base: bigint, perMille: number): bigint {
  if (!Number.isFinite(perMille) || perMille <= 0) return 0n;
  return ceilDiv(base * BigInt(perMille), 1000n);
}

// ── Late-repayment detection ─────────────────────────────────────────

export interface LateRepaymentInputs {
  isPerpetualLoan: boolean;
  nowMs: number;
  lendDateMs: number;
  /** Hours of grace before the first installment. */
  initialGracePeriod: number;
  /** Installment period in hours. */
  installmentPeriod: number;
  repaidInstallments: number;
  /** Hours of grace per installment after due time. */
  repaymentTimeWindow: number;
}

/**
 * `is_repayment_late` from finance.ak:
 *   not (isPerpetualLoan AND installmentPeriod == 0)
 *   AND nowMs > lendDateMs + (initialGracePeriod
 *                              + (repaidInstallments + 1) × installmentPeriod
 *                              + repaymentTimeWindow) × 3_600_000
 *
 * The first guard means: a perpetual loan with no installment period is
 * *never* "late" — interest just keeps accruing.
 */
export function isRepaymentLate(inp: LateRepaymentInputs): boolean {
  if (inp.isPerpetualLoan && inp.installmentPeriod === 0) return false;
  const dueAtMs = inp.lendDateMs +
    (inp.initialGracePeriod
      + (inp.repaidInstallments + 1) * inp.installmentPeriod
      + inp.repaymentTimeWindow) * MS_PER_HOUR;
  return inp.nowMs > dueAtMs;
}

// ── Liquidation eligibility ──────────────────────────────────────────

export interface LiquidationInputs {
  /** Outstanding debt in principal units (raw, e.g. 50_000_000 for 50 USDCx). */
  remainingDebt: bigint;
  /** Loan UTxO's lovelace value (collateral). */
  collateralLovelace: bigint;
  /** Decimal threshold from PoolDatum. `liquidationMode.ltv = 100` means
   *  trigger when current LTV exceeds 1.00 (debt-equals-collateral). */
  liquidationLtv: number;
  /** Spot price: how many lovelace per single principal-asset unit.
   *  e.g. for USDCx (6 decimals) at 1 USDCx = 4_000_000 lovelace, pass 4_000_000. */
  lovelacePerPrincipalUnit: number;
}

/**
 * `can_liquidate` from finance.ak:
 *   collateralInLovelace == 0  OR  liquidationLtv < currentLtv
 *   where currentLtv = totalOutstandingDebt / collateralInLovelace
 *
 * Returns `{ canLiquidate, currentLtv }`. `currentLtv` is the same scale
 * as `liquidationLtv` (raw units; divide by 100 for "× collateral" multiple).
 */
export function canLiquidate(inp: LiquidationInputs): { canLiquidate: boolean; currentLtv: number } {
  if (inp.collateralLovelace <= 0n) {
    return { canLiquidate: true, currentLtv: Infinity };
  }
  const debtLovelace = Number(inp.remainingDebt) * inp.lovelacePerPrincipalUnit;
  const collLovelace = Number(inp.collateralLovelace);
  const ltvFraction = debtLovelace / collLovelace;
  // LTV in source-units: same scale as liquidationLtv. The deployed USDCx
  // pool has liquidationLtv=100 which means 1.00× — so we report
  // `currentLtv = ltvFraction * 100`.
  const currentLtv = ltvFraction * 100;
  return { canLiquidate: inp.liquidationLtv < currentLtv, currentLtv };
}

// ── Equity at liquidation ────────────────────────────────────────────

export interface EquityInputs {
  collateralLovelace: bigint;
  remainingDebtLovelace: bigint;
  /** From liquidationMode.penaltyPerMille. e.g. 125 = 12.5% penalty. */
  penaltyPerMille: number;
}

/**
 * `equity_in_lovelace` from finance.ak:
 *   collateralInLovelace - remainingDebtInLovelace
 *     - (remainingDebtInLovelace × penaltyPerMille / 1000)
 *
 * Floors at 0 (negative equity = bad-debt scenario, source returns the
 * negative number; we surface it as a signed bigint so callers can detect).
 */
export function equityInLovelace(inp: EquityInputs): bigint {
  const penalty = ceilDiv(inp.remainingDebtLovelace * BigInt(inp.penaltyPerMille), 1000n);
  return inp.collateralLovelace - inp.remainingDebtLovelace - penalty;
}

// ── Constants exposed for tests ──────────────────────────────────────

export const _consts = Object.freeze({
  MS_PER_HOUR,
  HOURS_PER_YEAR,
  RATE_DENOM,
});
