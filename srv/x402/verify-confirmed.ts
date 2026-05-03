/**
 * Post-confirmed x402-payment verifier.
 *
 * Existing path (`process.ts`): buyer hands us a signed-but-unsubmitted
 * CBOR via `X-PAYMENT` header → we settle on-chain → claim nonce.
 *
 * This module: buyer hands us a TX-HASH for a payment ALREADY ON-CHAIN.
 * We fetch it via the ODATANO bridge, verify it pays the right amount of
 * the right asset to our address on the right network, then claim nonce.
 * Useful for **subscription / pre-paid** flows where the buyer paid up
 * front (out-of-band) and now wants the back-end to associate the
 * payment with a longer-lived service grant.
 *
 * Pure-ish: depends only on the bridge for tx-fetch + nonces for replay
 * protection. No CSL / signing. The tx is presumed already-settled, so
 * the witness-presence check from validate.ts is unnecessary here — if
 * the tx is on-chain the network already accepted the witnesses.
 *
 * Returns a claim or a coded reject. Caller turns that into a 402 / 200.
 */

import bridge from '../external/odatano-bridge';
// Plain CJS for tests (test-x402-integration.ts pattern)
import noncesModule = require('./nonces');
import { Codes, type X402Code } from './errors';

const FEED_READS = 'chainfeed.FeedReads';

export interface VerifyConfirmedArgs {
  txHash: string;
  /** Required USDM units (raw, BigInt-safe string). */
  requiredUnits: string;
  /** policyId+assetNameHex concatenated, e.g. for USDM. */
  requiredAsset: string;
  /** Service receiving wallet (CHAINFEED's payTo from x402 config). */
  requiredPayTo: string;
  network: string;     // 'cardano-mainnet' | 'cardano-preprod'
  route: string;       // for nonce + audit
  consumerAddr?: string;
}

export type VerifyConfirmedResult =
  | { ok: true; txHash: string; amountUnits: string }
  | { ok: false; code: X402Code; reason: string };

interface TxOutput {
  address?: string;
  lovelace?: string | number;
  assets?: Array<{ unit?: string; quantity?: string | number }>;
}

interface TxLite {
  hash?: string;
  outputs?: TxOutput[];
}

/**
 * Sum the `unit` quantities sent to `payTo` across every output of the tx.
 * `unit === 'lovelace'` reads the lovelace field; otherwise matches by
 * `output.assets[].unit === <policy+name hex>`.
 */
function totalPaidToAddress(tx: TxLite, payTo: string, unit: string): bigint {
  let total = 0n;
  for (const o of tx.outputs ?? []) {
    if (o.address !== payTo) continue;
    if (unit === 'lovelace') {
      total += BigInt(o.lovelace ?? '0');
    } else {
      for (const a of o.assets ?? []) {
        if (a.unit === unit) total += BigInt(a.quantity ?? '0');
      }
    }
  }
  return total;
}

export async function verifyConfirmedPayment(
  args: VerifyConfirmedArgs,
): Promise<VerifyConfirmedResult> {
  if (!args.txHash || typeof args.txHash !== 'string' || args.txHash.length !== 64) {
    return { ok: false, code: Codes.INVALID_CBOR, reason: 'txHash must be 64 hex chars' };
  }
  if (!/^[0-9a-f]{64}$/i.test(args.txHash)) {
    return { ok: false, code: Codes.INVALID_CBOR, reason: 'txHash must be lowercase hex' };
  }

  // 1. Fetch from chain.
  let tx: TxLite | null;
  try {
    tx = await bridge.getTransactionByHash(args.txHash) as TxLite | null;
  } catch (err) {
    return {
      ok: false,
      code: Codes.PENDING,
      reason: `bridge.getTransactionByHash failed: ${(err as Error)?.message ?? err}`,
    };
  }
  if (!tx) {
    return {
      ok: false,
      code: Codes.PENDING,
      reason: `tx ${args.txHash} not found on-chain (network=${args.network})`,
    };
  }

  // 2. Quantity check, summed across all outputs to payTo.
  const paid = totalPaidToAddress(tx, args.requiredPayTo, args.requiredAsset);
  const required = BigInt(args.requiredUnits);
  if (paid < required) {
    return {
      ok: false,
      code: Codes.INSUFFICIENT_AMOUNT,
      reason: `paid ${paid} < required ${required} of ${args.requiredAsset} to ${args.requiredPayTo}`,
    };
  }

  // 3. Replay protection — claim nonce. DB UNIQUE on txHash means a
  //    second subscription using the same tx fails here.
  const claim = await noncesModule.claim({
    txHash:      args.txHash,
    route:       args.route,
    network:     args.network,
    amountUnits: paid.toString(),
    consumerAddr: args.consumerAddr,
  });
  if (!claim.claimed) {
    return {
      ok: false,
      code: claim.code,
      reason: `nonce.claim failed (code=${claim.code}) — txHash already used for another grant?`,
    };
  }

  return { ok: true, txHash: args.txHash, amountUnits: paid.toString() };
}

/**
 * Pricing curve for peg-break subscriptions.
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
 * Tweak the constants for live calibration; keeping them as named exports
 * makes A/B-style updates straightforward.
 */
export const BASE_USDM            = 0.5;
export const HOURLY_USDM_AT_500BPS = 0.01;
export const USDM_DECIMALS        = 6;

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
