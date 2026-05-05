/**
 * FluidTokens finance.ak TS-port unit tests.
 *
 * Pure-fn tests — no bridge, no fixtures.
 *
 * Covers:
 *   - perpetualRemainingDebt: zero-elapsed, mid-elapsed, future-lend,
 *     quadratic drift via apyIncreaseLinearCoefficient, repaidInstallments offset
 *   - amortizingInstallmentAmount: zero-rate edge, sane mid-rate, penalty add
 *   - simpleInterestInstallmentAmount: same scenarios
 *   - installmentRemainingDebt: full lifecycle (paid down to 0)
 *   - isRepaymentLate: perpetual-with-zero-period sentinel, in-window, late
 *   - canLiquidate: trivial collateral=0, healthy, underwater
 *   - equityInLovelace: positive, zero penalty, deeply negative
 *
 * Run: npx tsx scripts/test-fluidtokens-finance.ts
 */

import assert from 'node:assert/strict';
import {
  perpetualRemainingDebt,
  amortizingInstallmentAmount,
  simpleInterestInstallmentAmount,
  installmentRemainingDebt,
  isRepaymentLate,
  canLiquidate,
  equityInLovelace,
  _consts,
} from '../srv/lib/fluidtokens-finance';

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

const HOUR = _consts.MS_PER_HOUR;
const YEAR_MS = _consts.HOURS_PER_YEAR * HOUR;

console.log('fluidtokens finance ──────────────────────────────────────');

// ── perpetualRemainingDebt ───────────────────────────────────────────

t('perpetual: zero elapsed → debt = principal', () => {
  const r = perpetualRemainingDebt({
    principal: 50_000_000n,
    lendDateMs: 1_000_000_000_000,
    nowMs:      1_000_000_000_000,
    interestRate: 400,
    apyIncreaseLinearCoefficient: 0,
    initialGracePeriod: 0,
    installmentPeriod: 0,
    repaidInstallments: 0,
  });
  assert.equal(r, 50_000_000n);
});

t('perpetual: 1 year elapsed @ 4% APR linear → debt ≈ 52M (4% interest)', () => {
  const r = perpetualRemainingDebt({
    principal: 50_000_000n,
    lendDateMs: 0,
    nowMs:      YEAR_MS,
    interestRate: 400,
    apyIncreaseLinearCoefficient: 0,
    initialGracePeriod: 0,
    installmentPeriod: 0,
    repaidInstallments: 0,
  });
  // Expected: 50e6 + 50e6 × 0.04 = 52e6 (rounded up to nearest unit)
  assert.ok(r >= 51_999_999n && r <= 52_000_001n, `expected ~52e6, got ${r}`);
});

t('perpetual: half year elapsed → ~2% interest (half the linear)', () => {
  const r = perpetualRemainingDebt({
    principal: 100_000_000n,
    lendDateMs: 0,
    nowMs:      YEAR_MS / 2,
    interestRate: 400,
    apyIncreaseLinearCoefficient: 0,
    initialGracePeriod: 0,
    installmentPeriod: 0,
    repaidInstallments: 0,
  });
  // 100e6 + 100e6 × 0.04 × 0.5 = 102e6
  assert.ok(r >= 101_999_999n && r <= 102_000_001n);
});

t('perpetual: future lendDate (now < lendDate) → debt = principal', () => {
  const r = perpetualRemainingDebt({
    principal: 1_000n,
    lendDateMs: 1_000_000,
    nowMs:        500_000,
    interestRate: 1000,
    apyIncreaseLinearCoefficient: 0,
    initialGracePeriod: 0, installmentPeriod: 0, repaidInstallments: 0,
  });
  assert.equal(r, 1_000n);
});

t('perpetual: quadratic drift kicks in via apyIncreaseLinearCoefficient', () => {
  // 1-day elapsed (24h) so drift stays bounded — at 1y the quadratic term
  // explodes to dominate by ~100× principal which isn't useful for the
  // monotonicity assertion. Live USDCx pool uses apyIncrease=5 with daily
  // installments so realistic windows are sub-week.
  // Drift formula: principal × (m × hours²) / 8760
  //              = 100e6 × 0.0005 × 576 / 8760 ≈ 3_288
  const T = 24 * HOUR;
  const r0 = perpetualRemainingDebt({
    principal: 100_000_000n, lendDateMs: 0, nowMs: T,
    interestRate: 400, apyIncreaseLinearCoefficient: 0,
    initialGracePeriod: 0, installmentPeriod: 0, repaidInstallments: 0,
  });
  const r1 = perpetualRemainingDebt({
    principal: 100_000_000n, lendDateMs: 0, nowMs: T,
    interestRate: 400, apyIncreaseLinearCoefficient: 5,
    initialGracePeriod: 0, installmentPeriod: 0, repaidInstallments: 0,
  });
  assert.ok(r1 > r0, `with drift (${r1}) should exceed flat (${r0})`);
  const drift = r1 - r0;
  assert.ok(drift > 3_000n && drift < 3_500n, `unexpected drift magnitude ${drift}`);
});

t('perpetual: still in grace period → no interest accrued', () => {
  // 1 hour elapsed, but initialGracePeriod = 24 → passedHoursSinceLast clamps to 0.
  const r = perpetualRemainingDebt({
    principal: 1_000_000n, lendDateMs: 0, nowMs: HOUR,
    interestRate: 1000, apyIncreaseLinearCoefficient: 0,
    initialGracePeriod: 24, installmentPeriod: 0, repaidInstallments: 0,
  });
  assert.equal(r, 1_000_000n);
});

// ── amortizing installment ───────────────────────────────────────────

t('amortizing: zero-rate edge → principal/N per installment', () => {
  const inst = amortizingInstallmentAmount({
    principal: 1_200_000n,
    interestRate: 0,
    totalInstallments: 12,
    repaidInstallments: 0,
    penaltyFeeForLateRepayment: 0,
  }, false);
  assert.equal(inst, 100_000n);
});

t('amortizing: 12% rate over 12 monthly installments — annuity', () => {
  // Per-period rate = 12% / 12 / 100 = 0.01 → standard textbook annuity
  // Payment = 100000 × 0.01 × (1.01)^12 / ((1.01)^12 - 1)
  // ≈ 100000 × 0.01 × 1.12683 / 0.12683 ≈ 8884.88 → ceil → 8885
  const inst = amortizingInstallmentAmount({
    principal: 100_000n,
    interestRate: 1200,
    totalInstallments: 12,
    repaidInstallments: 0,
    penaltyFeeForLateRepayment: 0,
  }, false);
  assert.ok(inst >= 8884n && inst <= 8886n, `expected ~8885, got ${inst}`);
});

t('amortizing: late penalty adds per-mille of principal', () => {
  // Same 12%/12 setup but with 50‰ penalty applied.
  const inst = amortizingInstallmentAmount({
    principal: 100_000n,
    interestRate: 1200,
    totalInstallments: 12,
    repaidInstallments: 0,
    penaltyFeeForLateRepayment: 50,    // 5%
  }, true);
  // Without penalty: ≈ 8885. Penalty: ceil(100000 × 50 / 1000) = 5000.
  assert.ok(inst >= 13884n && inst <= 13886n);
});

// ── simple-interest installment ──────────────────────────────────────

t('simple-interest: 10% over 10 installments → principal/10 + interest/10 per', () => {
  const inst = simpleInterestInstallmentAmount({
    principal: 1_000_000n,
    interestRate: 1000,
    totalInstallments: 10,
    repaidInstallments: 0,
    penaltyFeeForLateRepayment: 0,
  }, false);
  // totalInterest = 100_000, installment = ceil(1.1e6 / 10) = 110_000
  assert.equal(inst, 110_000n);
});

t('simple-interest: zero principal → 0 installment', () => {
  const inst = simpleInterestInstallmentAmount({
    principal: 0n, interestRate: 1000, totalInstallments: 10,
    repaidInstallments: 0, penaltyFeeForLateRepayment: 0,
  }, false);
  assert.equal(inst, 0n);
});

// ── installmentRemainingDebt ─────────────────────────────────────────

t('installmentRemainingDebt: amortizing — full debt with 0 paid', () => {
  const debt = installmentRemainingDebt({
    principal: 1_200_000n,
    interestRate: 0, totalInstallments: 12, repaidInstallments: 0,
    penaltyFeeForLateRepayment: 0,
  }, true, false);
  assert.equal(debt, 1_200_000n);
});

t('installmentRemainingDebt: half paid → half debt remaining', () => {
  const debt = installmentRemainingDebt({
    principal: 1_200_000n,
    interestRate: 0, totalInstallments: 12, repaidInstallments: 6,
    penaltyFeeForLateRepayment: 0,
  }, true, false);
  assert.equal(debt, 600_000n);
});

t('installmentRemainingDebt: fully paid → 0', () => {
  const debt = installmentRemainingDebt({
    principal: 1_200_000n,
    interestRate: 0, totalInstallments: 12, repaidInstallments: 12,
    penaltyFeeForLateRepayment: 0,
  }, true, false);
  assert.equal(debt, 0n);
});

t('installmentRemainingDebt: over-paid (defensive) → 0 not negative', () => {
  const debt = installmentRemainingDebt({
    principal: 1_200_000n,
    interestRate: 0, totalInstallments: 12, repaidInstallments: 99,
    penaltyFeeForLateRepayment: 0,
  }, true, false);
  assert.equal(debt, 0n);
});

// ── isRepaymentLate ──────────────────────────────────────────────────

t('isRepaymentLate: perpetual with installmentPeriod=0 → never late', () => {
  const late = isRepaymentLate({
    isPerpetualLoan: true, nowMs: 999 * YEAR_MS,
    lendDateMs: 0, initialGracePeriod: 0, installmentPeriod: 0,
    repaidInstallments: 0, repaymentTimeWindow: 0,
  });
  assert.equal(late, false);
});

t('isRepaymentLate: installment loan within window → not late', () => {
  // installmentPeriod=720h (30d), grace=24h, window=48h.
  // Not late if now < lendDate + (24 + 1×720 + 48) hours = 792h after.
  const late = isRepaymentLate({
    isPerpetualLoan: false, nowMs: 700 * HOUR,
    lendDateMs: 0, initialGracePeriod: 24, installmentPeriod: 720,
    repaidInstallments: 0, repaymentTimeWindow: 48,
  });
  assert.equal(late, false);
});

t('isRepaymentLate: installment loan past window → late', () => {
  const late = isRepaymentLate({
    isPerpetualLoan: false, nowMs: 800 * HOUR,
    lendDateMs: 0, initialGracePeriod: 24, installmentPeriod: 720,
    repaidInstallments: 0, repaymentTimeWindow: 48,
  });
  assert.equal(late, true);
});

// ── canLiquidate ─────────────────────────────────────────────────────

t('canLiquidate: collateral 0 → always liquidatable', () => {
  const r = canLiquidate({
    remainingDebt: 0n, collateralLovelace: 0n,
    liquidationLtv: 100, lovelacePerPrincipalUnit: 1,
  });
  assert.equal(r.canLiquidate, true);
});

t('canLiquidate: 1000 ADA collateral, 50 USDCx debt at $1 → safe', () => {
  // debt in lovelace = 50e6 × (1e6 lovelace / USDCx unit) = 50e12 ... wait,
  // lovelacePerPrincipalUnit semantics: lovelace per 1 raw-unit of principal.
  // For USDCx (6-decimal) at 1 USDCx = 4M lovelace, with raw principal in
  // 6-decimal raw units (50_000_000 = 50 USDCx), the per-raw-unit rate is 4.
  const r = canLiquidate({
    remainingDebt: 50_000_000n,
    collateralLovelace: 1_000_000_000n,   // 1000 ADA
    liquidationLtv: 100,                  // 1.00× threshold
    lovelacePerPrincipalUnit: 4,          // 1 USDCx-raw = 4 lovelace
  });
  // currentLtv = (50e6 × 4) / 1e9 = 0.2 = 20% → < 100 → safe
  assert.equal(r.canLiquidate, false);
  assert.ok(r.currentLtv < 100);
});

t('canLiquidate: deeply underwater → liquidatable', () => {
  const r = canLiquidate({
    remainingDebt: 1_000_000_000n,        // 1000 USDCx
    collateralLovelace: 100_000_000n,     // 100 ADA
    liquidationLtv: 100,
    lovelacePerPrincipalUnit: 4,
  });
  // currentLtv = (1e9 × 4) / 1e8 = 40 = 4000% → way above threshold
  assert.equal(r.canLiquidate, true);
  assert.ok(r.currentLtv > 1000);
});

// ── equityInLovelace ─────────────────────────────────────────────────

t('equity: positive — 1000 ADA collateral, 100 ADA debt, 100 penalty', () => {
  const eq = equityInLovelace({
    collateralLovelace: 1_000_000_000n,
    remainingDebtLovelace: 100_000_000n,
    penaltyPerMille: 100,
  });
  // 1e9 - 1e8 - ceil(1e8 × 100/1000) = 1e9 - 1e8 - 1e7 = 890_000_000
  assert.equal(eq, 890_000_000n);
});

t('equity: zero penalty matches collateral - debt', () => {
  const eq = equityInLovelace({
    collateralLovelace: 1_000_000_000n,
    remainingDebtLovelace: 100_000_000n,
    penaltyPerMille: 0,
  });
  assert.equal(eq, 900_000_000n);
});

t('equity: negative when debt + penalty > collateral', () => {
  const eq = equityInLovelace({
    collateralLovelace: 50_000_000n,
    remainingDebtLovelace: 100_000_000n,
    penaltyPerMille: 100,
  });
  // 5e7 - 1e8 - 1e7 = -60_000_000 → caller treats as bad-debt indicator
  assert.equal(eq, -60_000_000n);
});

// ── error paths ──────────────────────────────────────────────────────

t('amortizing: throws when totalInstallments is 0', () => {
  assert.throws(() => amortizingInstallmentAmount({
    principal: 100_000n, interestRate: 1200, totalInstallments: 0,
    repaidInstallments: 0, penaltyFeeForLateRepayment: 0,
  }, false), /totalInstallments must be positive/);
});

t('simple-interest: throws when totalInstallments is 0', () => {
  assert.throws(() => simpleInterestInstallmentAmount({
    principal: 100_000n, interestRate: 1200, totalInstallments: 0,
    repaidInstallments: 0, penaltyFeeForLateRepayment: 0,
  }, false), /totalInstallments must be positive/);
});

t('perpetual: throws on negative principal', () => {
  assert.throws(() => perpetualRemainingDebt({
    principal: -1n, lendDateMs: 0, nowMs: HOUR,
    interestRate: 100, apyIncreaseLinearCoefficient: 0,
    initialGracePeriod: 0, installmentPeriod: 0, repaidInstallments: 0,
  }), /principal must be non-negative/);
});

console.log(`\n${n - fails}/${n} passed`);
process.exit(fails ? 1 : 0);
