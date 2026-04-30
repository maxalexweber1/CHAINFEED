/**
 * Replay-protection nonce store for x402 payments.
 *
 * Backed by the `chainfeed.X402PaymentNonces` CDS entity. The `txHash`
 * field is the primary key, so DB-level UNIQUE enforcement is what
 * prevents double-spend of the same signed CBOR payload — not a TOCTOU
 * race in JS.
 *
 * Usage:
 *   import { claim, has } from './nonces';
 *   const r = await claim({ txHash, route, network, amountUnits });
 *   if (!r.claimed) { ...reject 402... }
 */

import cds from '@sap/cds';
import { Codes, type X402Code } from './errors';

const ENTITY = 'chainfeed.X402PaymentNonces';

interface ClaimArgs {
  txHash: string;
  route?: string;
  network?: string;
  amountUnits: string | number | bigint;
  consumerAddr?: string;
}

type ClaimResult =
  | { claimed: true }
  | { claimed: false; code: X402Code };

/**
 * Detect SQL UNIQUE-constraint violations across the @cap-js/sqlite + HANA
 * surface. Both wrap the underlying driver error; we match on the message
 * since CAP's error code is not stable across DBs.
 */
function isUniqueViolation(err: unknown): boolean {
  const msg = String((err as { message?: unknown })?.message ?? '');
  if (/UNIQUE constraint failed/i.test(msg)) return true;
  if (/duplicate key value/i.test(msg)) return true;     // HANA / Postgres
  const code = (err as { code?: string })?.code;
  if (code === 'SQLITE_CONSTRAINT_UNIQUE') return true;
  if (code === 'SQLITE_CONSTRAINT') return /unique/i.test(msg);
  return false;
}

async function claim(
  { txHash, route, network, amountUnits, consumerAddr }: ClaimArgs,
): Promise<ClaimResult> {
  if (!txHash) throw new TypeError('claim: txHash required');
  try {
    await cds.run(
      INSERT.into(ENTITY).entries({
        txHash,
        claimedAt:    new Date().toISOString(),
        route:        String(route ?? '').slice(0, 200),
        consumerAddr: String(consumerAddr ?? ''),
        amountUnits:  String(amountUnits ?? '0'),
        network:      String(network ?? ''),
      }),
    );
    return { claimed: true };
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { claimed: false, code: Codes.REPLAY };
    }
    throw err;
  }
}

/**
 * Check whether a tx hash has already been claimed. NOT a replacement for
 * `claim()` — used for diagnostic queries / test assertions only. Real
 * gating relies on the atomic INSERT in `claim()`.
 */
async function has(txHash: string): Promise<boolean> {
  if (!txHash) return false;
  const row = await cds.run(
    SELECT.one.from(ENTITY).columns('txHash').where({ txHash }),
  );
  return !!row;
}

// Plain CJS export so tests can monkey-patch `claim` at runtime.
export = { claim, has, _isUniqueViolation: isUniqueViolation };
