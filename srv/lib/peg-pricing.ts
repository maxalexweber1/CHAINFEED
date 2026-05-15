/**
 * Pricing curve for peg-break alert subscriptions.
 *
 * Components:
 *   BASE_USDM         = 0.5    flat setup fee (always charged)
 *   HOURLY_AT_500_BPS = 0.01   hourly rate at thresholdBps=500 (5%)
 *
 * The hourly rate scales inversely with threshold: tighter threshold →
 * more alerts likely → higher hourly. We use 500-bps as the calibration
 * point, so:
 *   - thresholdBps = 5000 (50% — practically never fires)  → 0.001 USDM/hr
 *   - thresholdBps =  500 ( 5% — fires on real depegs)      → 0.01  USDM/hr  (calibration)
 *   - thresholdBps =  100 ( 1% — fires on noise + depegs)   → 0.05  USDM/hr
 *   - thresholdBps =   10 (0.1% — fires constantly)         → 0.5   USDM/hr
 *
 * Examples (24h subscription):
 *   - default (1%, 24h):  0.5 + 0.05 × 24 = 1.7 USDM
 *   - paranoid (0.1%, 7d): 0.5 + 0.5 × 168 = 84.5 USDM
 *   - chill (10%, 30d):    0.5 + 0.005 × 720 = 4.1 USDM
 *
 * Moved here from `srv/x402/verify-confirmed.ts` during the @odatano/x402
 * v2 migration — this is CHAINFEED domain logic, not x402 plumbing.
 */

export const BASE_USDM             = 0.5;
export const HOURLY_USDM_AT_500BPS = 0.01;
export const USDM_DECIMALS         = 6;

export function priceForSubscription(thresholdBps: number, validUntilHours: number): bigint {
  if (!Number.isFinite(thresholdBps) || thresholdBps <= 0) {
    throw new Error(`priceForSubscription: thresholdBps must be positive (got ${thresholdBps})`);
  }
  if (!Number.isFinite(validUntilHours) || validUntilHours <= 0) {
    throw new Error(`priceForSubscription: validUntilHours must be positive (got ${validUntilHours})`);
  }
  const hourlyRate = HOURLY_USDM_AT_500BPS * (500 / thresholdBps);
  const totalUsdm  = BASE_USDM + hourlyRate * validUntilHours;
  // Round UP — never undercharge. USDM has 6 decimals.
  return BigInt(Math.ceil(totalUsdm * 10 ** USDM_DECIMALS));
}
