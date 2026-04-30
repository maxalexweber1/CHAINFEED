/**
 * Validate a decoded x402 payment against payment requirements.
 *
 * Pure function. No DB, no chain — replay protection lives in `nonces.ts`,
 * settlement confirmation in `settle.ts`. This module only inspects what
 * the buyer told us, against what we asked for.
 *
 * Returns `{ ok: true, claim }` or `{ ok: false, code, reason }`.
 */

import { Codes, type X402Code } from './errors';
import type { DecodedPayment, DecodedOutput } from './decode';
import type { PaymentRequirementEntry } from './requirements';

export interface PaymentClaim {
  txHash: string;
  amountUnits: string;
  network: string;
  route: string;
  asset: string;
  /** payerAddr: not extractable without resolving inputs — see nonces.ts */
  payerAddr: string | undefined;
}

export type ValidationResult =
  | { ok: true; claim: PaymentClaim }
  | { ok: false; code: X402Code; reason: string };

function quantityOf(output: DecodedOutput, unit: string): bigint {
  if (unit === 'lovelace') return BigInt(output.lovelace);
  const a = output.assets.find(x => x.unit === unit);
  return a ? BigInt(a.quantity) : 0n;
}

/**
 * Total amount of `unit` paid to `payTo`, summed across ALL matching
 * outputs. Summing rather than picking-the-first is important: a wallet
 * may split a payment across multiple outputs (e.g. token + change), and
 * we want to credit the full amount sent to our address.
 */
function totalPaid(
  decoded: DecodedPayment,
  payTo: string,
  unit: string,
): { total: bigint; anyOutputToRecipient: boolean } {
  let total = 0n;
  let anyOutputToRecipient = false;
  for (const o of decoded.outputs) {
    if (o.address !== payTo) continue;
    anyOutputToRecipient = true;
    total += quantityOf(o, unit);
  }
  return { total, anyOutputToRecipient };
}

export function validatePayment(
  decoded: DecodedPayment,
  requirements: PaymentRequirementEntry,
): ValidationResult {
  // 1. Network
  if (decoded.network !== requirements.network) {
    return {
      ok: false,
      code: Codes.NETWORK_MISMATCH,
      reason: `payment network '${decoded.network}' does not match requirements '${requirements.network}'`,
    };
  }

  // 2. Witness present (sanity — an unsigned tx is useless)
  if (!decoded.vkeyWitnessCount || decoded.vkeyWitnessCount < 1) {
    return {
      ok: false,
      code: Codes.UNSIGNED_TRANSACTION,
      reason: 'transaction has no vkey witnesses',
    };
  }

  // 3. Asset + quantity, summed across all outputs to payTo.
  // Unit construction: ADA payments use the literal 'lovelace' marker;
  // native-asset payments use policyId concatenated with assetNameHex.
  let unit: string;
  if (requirements.asset === 'lovelace') {
    unit = 'lovelace';
  } else {
    const nameHex = requirements.extra?.assetNameHex ?? '';
    unit = (requirements.asset + nameHex).toLowerCase();
  }

  const required = BigInt(requirements.maxAmountRequired);
  const { total: got, anyOutputToRecipient } = totalPaid(decoded, requirements.payTo, unit);

  if (!anyOutputToRecipient) {
    return {
      ok: false,
      code: Codes.WRONG_RECIPIENT,
      reason: `no output to payTo address ${requirements.payTo}`,
    };
  }
  if (got === 0n) {
    return {
      ok: false,
      code: Codes.WRONG_ASSET,
      reason: `outputs to payTo do not contain asset ${unit}`,
    };
  }
  if (got < required) {
    return {
      ok: false,
      code: Codes.INSUFFICIENT_AMOUNT,
      reason: `paid ${got.toString()} < required ${required.toString()} (asset ${unit})`,
    };
  }

  // All structural checks pass. The claim object is what `nonces.claim()`
  // and `FeedReads` will record.
  return {
    ok: true,
    claim: {
      txHash:      decoded.txHash,
      amountUnits: got.toString(),
      network:     decoded.network,
      route:       requirements.resource,
      asset:       unit,
      payerAddr:   undefined,
    },
  };
}
