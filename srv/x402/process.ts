/**
 * Shared x402 request-processing pipeline.
 *
 * Input:  the raw `X-PAYMENT` header value + payment requirements.
 * Output: a discriminated result the Express / CAP wrappers translate into
 * their own HTTP/CDS reject shapes. This module is transport-agnostic.
 *
 * Pipeline:
 *   decode → validate → settle → claim nonce → audit → success
 *
 * Settle BEFORE claim so a failed/pending settle does not consume the
 * nonce — buyer can retry the same X-PAYMENT. The DB UNIQUE on `txHash`
 * resolves the inevitable settle-then-claim race between concurrent
 * retries: exactly one wins, others get `replay_detected`.
 */

import cds from '@sap/cds';
import { decode } from './decode';
import { validatePayment } from './validate';
// CJS-style require so tests can monkey-patch settle/claim at runtime.
import settleModule = require('./settle');
import noncesModule = require('./nonces');
import { Codes, X402Error, type X402Code } from './errors';
import { flatRequirements, type PaymentRequirementsBody } from './requirements';
import type { PaymentClaim } from './validate';

const FEED_READS = 'chainfeed.FeedReads';

export type ProcessKind = 'accepted' | 'rejected' | 'pending';

export interface ProcessArgs {
  /** the raw header (undefined if missing) */
  xPaymentHeader: string | string[] | undefined;
  /** full 402 body */
  requirementsBody: PaymentRequirementsBody;
  /** audit tag — e.g. 'aggregated' | 'provider' */
  feedKind?: string;
  /** audit ref — e.g. pair name or feed id */
  feedRef?: string;
}

export type ProcessResult =
  | {
      kind: 'accepted';
      txHash: string;
      payment: PaymentClaim;
      paymentResponseB64: string;
    }
  | {
      kind: 'rejected';
      code: X402Code;
      reason: string;
      requirementsBody: PaymentRequirementsBody;
    }
  | {
      kind: 'pending';
      code: X402Code;
      reason?: string;
      txHash?: string;
      requirementsBody: PaymentRequirementsBody;
    };

function paymentResponseHeaderB64(network: string, txHash: string): string {
  return Buffer.from(JSON.stringify({
    success: true, network, transaction: txHash,
  }), 'utf8').toString('base64');
}

interface WriteFeedReadArgs {
  feedKind: string | undefined;
  feedRef: string | undefined;
  claim: PaymentClaim;
}

async function writeFeedRead({ feedKind, feedRef, claim }: WriteFeedReadArgs): Promise<void> {
  // Audit-only — failures here must not block serving the response.
  // We log and swallow; the canonical record of payment is on-chain anyway.
  try {
    await cds.run(
      INSERT.into(FEED_READS).entries({
        feedKind:        String(feedKind ?? 'unknown'),
        feedRef:         String(feedRef ?? '').slice(0, 100),
        consumerWallet:  String(claim.payerAddr ?? ''),
        amountPaidUSDM:  Number(claim.amountUnits) / 1_000_000,  // 6dp
        paymentTxHash:   claim.txHash,
        servedAt:        new Date().toISOString(),
        responsePayload: '',  // future: capture downstream response
      }),
    );
  } catch (err) {
    cds.log('x402').warn('FeedReads insert failed (non-fatal):', (err as { message?: string })?.message ?? err);
  }
}

export async function process(
  { xPaymentHeader, requirementsBody, feedKind, feedRef }: ProcessArgs,
): Promise<ProcessResult> {
  const headerStr = Array.isArray(xPaymentHeader) ? xPaymentHeader[0] : xPaymentHeader;

  if (!headerStr) {
    return {
      kind: 'rejected',
      code: Codes.MISSING_HEADER,
      reason: 'X-PAYMENT header is required',
      requirementsBody,
    };
  }

  // 1. Decode
  let decoded;
  try {
    decoded = decode(headerStr);
  } catch (err) {
    if (err instanceof X402Error) {
      return {
        kind: 'rejected',
        code: err.code as X402Code,
        reason: err.message,
        requirementsBody,
      };
    }
    throw err;
  }

  // 2. Validate (pure)
  const requirements = flatRequirements(requirementsBody);
  const v = validatePayment(decoded, requirements);
  if (!v.ok) {
    return { kind: 'rejected', code: v.code, reason: v.reason, requirementsBody };
  }

  // 3. Settle (chain). NB: the CBOR we give settle is the same hex we
  // already decoded — no point re-base64-decoding the X-PAYMENT envelope.
  // 60s budget covers preprod's worst-case block time (≈20s) plus
  // Blockfrost indexer lag, with some margin. Past 60s we return 402-pending
  // and the buyer retries with the same X-PAYMENT (nonce table ensures only
  // one retry serves data).
  const settled = await settleModule.settle({
    signedTxCborHex: decoded.txCborHex,
    expectedTxHash:  decoded.txHash,
    pollBudgetMs:    60_000,
  });
  if (!settled.confirmed) {
    if (settled.pending) {
      return {
        kind: 'pending',
        code: settled.code ?? Codes.PENDING,
        reason: settled.reason,
        txHash: settled.txHash,
        requirementsBody,
      };
    }
    return {
      kind: 'rejected',
      code: settled.code ?? Codes.SUBMIT_FAILED,
      reason: settled.reason ?? 'submit failed',
      requirementsBody,
    };
  }

  // 4. Claim nonce. UNIQUE PK on txHash means concurrent retries with the
  // same X-PAYMENT collapse to exactly one winner here.
  const claimed = await noncesModule.claim({
    txHash:       v.claim.txHash,
    route:        requirements.resource,
    network:      v.claim.network,
    amountUnits:  v.claim.amountUnits,
    consumerAddr: v.claim.payerAddr,
  });
  if (!claimed.claimed) {
    return {
      kind: 'rejected',
      code: claimed.code ?? Codes.REPLAY,
      reason: 'this payment tx has already been redeemed',
      requirementsBody,
    };
  }

  // 5. Audit (best-effort)
  await writeFeedRead({ feedKind, feedRef, claim: v.claim });

  // 6. Success.
  return {
    kind: 'accepted',
    txHash: v.claim.txHash,
    payment: v.claim,
    paymentResponseB64: paymentResponseHeaderB64(v.claim.network, v.claim.txHash),
  };
}
