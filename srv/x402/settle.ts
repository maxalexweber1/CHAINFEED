/**
 * Submit a signed payment tx to Cardano and confirm settlement.
 *
 * Confirmation policy per ADR 0001: accept after first chain sighting
 * (i.e. when Blockfrost `/txs/{hash}` resolves the tx — that's at least
 * 1 block confirmation). For oracle-read-grade payments this is fine.
 *
 * The middleware path uses a short poll budget (~30s) so the buyer's
 * HTTP request doesn't hang. If the budget expires without sighting we
 * return `{ pending: true }`, and the spec contract is for the buyer to
 * retry the original request with the same X-PAYMENT — replay protection
 * in `nonces.ts` ensures only one of those retries actually serves data.
 */

import bridge from '../external/odatano-bridge';
import { Codes, type X402Code } from './errors';

interface SettleArgs {
  /** the buyer's signed tx (hex) */
  signedTxCborHex: string;
  /** hash from decode (cross-check vs submit response) */
  expectedTxHash: string;
  pollBudgetMs?: number;
  pollIntervalMs?: number;
}

interface SettleResult {
  confirmed: boolean;
  /** true if submitted but not yet visible */
  pending?: boolean;
  txHash?: string;
  code?: X402Code;
  reason?: string;
}

// Substrings that indicate the tx is already known to the network — either
// in mempool or already mined. In both cases we should NOT treat as failure;
// proceed straight to polling for chain visibility. Pattern catches:
//   - Blockfrost: "Transaction is already in the mempool"
//   - Cardano node: "ConwayMempoolFailure ... Transaction has probably already been included"
//   - Ouroboros: "BadInputsUTxO" with inputs-already-spent
//   - Generic: "transaction already exists"
//
// `transaction-already-included` and `inputs-spent` are different signals
// (mempool vs mined) but for the purposes of "should we poll instead of
// failing" they're identical. Match both.
const TX_ALREADY_KNOWN_RE = new RegExp(
  [
    'already (in (the )?(mempool|chain)|exists|been included)',
    'transaction has probably already been included',
    'all inputs are spent',
    'badinputsutxo',
    'valuenotconserved',
    'inputsdepleted',
  ].join('|'),
  'i',
);

async function settle({
  signedTxCborHex,
  expectedTxHash,
  pollBudgetMs = 30_000,
  pollIntervalMs = 2_500,
}: SettleArgs): Promise<SettleResult> {
  if (!signedTxCborHex) throw new TypeError('settle: signedTxCborHex required');
  if (!expectedTxHash)  throw new TypeError('settle: expectedTxHash required');

  // 1. Submit
  let submittedHash: string | undefined;
  try {
    submittedHash = await bridge.submitTransaction(signedTxCborHex);
  } catch (err) {
    const msg = String((err as { message?: unknown })?.message ?? err ?? '');
    // Idempotency: if we (or a competing client) already submitted this CBOR,
    // proceed to polling — this is not a failure.
    if (TX_ALREADY_KNOWN_RE.test(msg)) {
      submittedHash = expectedTxHash;
    } else {
      return {
        confirmed: false,
        code:      Codes.SUBMIT_FAILED,
        reason:    msg.slice(0, 200),
      };
    }
  }

  // The hash returned by Blockfrost should match the one we computed locally.
  // If it doesn't, something is structurally off — bail loudly.
  if (submittedHash && submittedHash !== expectedTxHash) {
    return {
      confirmed: false,
      code:      Codes.SUBMIT_FAILED,
      reason:    `submit returned hash ${submittedHash} but tx hashes to ${expectedTxHash}`,
    };
  }

  // 2. Poll for first chain sighting.
  const deadline = Date.now() + pollBudgetMs;
  while (Date.now() < deadline) {
    const tx = await bridge.getTransactionByHash(expectedTxHash);
    if (tx) {
      return { confirmed: true, txHash: expectedTxHash };
    }
    await new Promise(r => setTimeout(r, pollIntervalMs));
  }

  // 3. Timed out. Tx is submitted but not yet indexed — buyer should retry.
  return {
    confirmed: false,
    pending:   true,
    txHash:    expectedTxHash,
    code:      Codes.PENDING,
    reason:    'transaction submitted but not yet visible on chain',
  };
}

// Plain CJS export (not ESM `export`) so consumers — and tests in
// particular — can monkey-patch `settleModule.settle` at runtime. tsx /
// esbuild compile ESM `export` to non-configurable getters which would
// trap reassignment.
export = { settle };

