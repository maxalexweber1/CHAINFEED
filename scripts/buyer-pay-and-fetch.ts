/**
 * Manual end-to-end x402 round-trip on preprod (Cardano-x402-v2).
 *
 * Uses `@odatano/x402` 0.3.0's `x402Fetch` for the 402 → pay → retry loop
 * and `createBridgePayHandler` for tx-build + signing. ~270 lines of
 * hand-rolled CSL coin-selection collapsed to ~100.
 *
 * One glue helper stays CHAINFEED-side: `signRawTx` — raw-key signing for
 * the dev wallet (the package's PayHandler delegates to a caller-supplied
 * `signTx` callback). 0.3.0 made the CAP-OData-envelope unwrap built-in,
 * so the previous `unwrappingFetch` shim is gone.
 *
 * Plays BUYER with the dev wallet (`CHAINFEED_WALLET_MNEMONIC`). Buyer
 * == seller is fine — the facilitator only inspects what's on-chain.
 *
 * Each run costs ~0.2 ADA in fees plus the price (10000 raw mock-USDM).
 * The nonce UTxO is consumed by the tx — re-running needs a fresh UTxO.
 *
 * Prereqs: CAP server running, `.env` sourced.
 *
 * Run:
 *   set -a && source .env && set +a && npx tsx scripts/buyer-pay-and-fetch.ts [host] [path] [method] [json-body]
 *
 * Examples:
 *   # GET an entity
 *   npx tsx scripts/buyer-pay-and-fetch.ts
 *
 *   # POST an OData action
 *   npx tsx scripts/buyer-pay-and-fetch.ts http://127.0.0.1:4004 /odata/v4/price/getBestPrice POST '{"pair":"ADA-USDM"}'
 */

import * as bip39 from 'bip39';
import * as CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { bridge, x402Fetch, createBridgePayHandler } from '@odatano/x402';
import type { PayHandler } from '@odatano/x402';

const HOST   = process.argv[2] ?? 'http://127.0.0.1:4004';
const PATH   = process.argv[3] ?? '/odata/v4/price/Prices';
const METHOD = (process.argv[4] ?? 'GET').toUpperCase();
const BODY   = process.argv[5] ?? null;

const harden = (n: number) => n | 0x80000000;

/**
 * Derive the dev wallet's payment + stake raw keys from BIP-39 mnemonic.
 * Path: m/1852'/1815'/0'/{0|2}/0 (CIP-1852 first account).
 */
function deriveRawKeys(mnemonic: string): { payment: CSL.PrivateKey; stake: CSL.PrivateKey } {
  const entropy = bip39.mnemonicToEntropy(mnemonic);
  const root = CSL.Bip32PrivateKey.from_bip39_entropy(
    Buffer.from(entropy, 'hex'),
    Buffer.from(''),
  );
  const account = root.derive(harden(1852)).derive(harden(1815)).derive(harden(0));
  return {
    payment: account.derive(0).derive(0).to_raw_key(),
    stake:   account.derive(2).derive(0).to_raw_key(),
  };
}

/** Bech32 base address for `payment + stake` on `networkId` (0 = testnet, 1 = mainnet). */
function bech32From(payment: CSL.PrivateKey, stake: CSL.PrivateKey, networkId = 0): string {
  return CSL.BaseAddress.new(
    networkId,
    CSL.Credential.from_keyhash(payment.to_public().hash()),
    CSL.Credential.from_keyhash(stake.to_public().hash()),
  ).to_address().to_bech32();
}

async function main() {
  const mnemonic = process.env.CHAINFEED_WALLET_MNEMONIC;
  if (!mnemonic) throw new Error('CHAINFEED_WALLET_MNEMONIC missing — source .env');

  const { payment, stake } = deriveRawKeys(mnemonic);
  const buyer = bech32From(payment, stake, 0);
  const url = HOST + PATH;

  console.log(`buyer: ${buyer}`);
  console.log(`→ ${METHOD} ${url}${BODY ? ` (body: ${BODY})` : ''}`);

  // Inner pay handler — uses @odatano/x402's bridge handler to build the
  // unsigned tx; we sign with the dev wallet's raw key.
  const bridgePay = createBridgePayHandler({
    buyerBech32: buyer,
    signTx: async (unsignedCborHex) => {
      const tx     = CSL.Transaction.from_bytes(Buffer.from(unsignedCborHex, 'hex'));
      const body   = tx.body();
      const txHash = CSL.FixedTransaction.new_from_body_bytes(body.to_bytes()).transaction_hash();
      const wits   = CSL.TransactionWitnessSet.new();
      const vk     = CSL.Vkeywitnesses.new();
      vk.add(CSL.make_vkey_witness(txHash, payment));
      wits.set_vkeys(vk);
      const signed = CSL.Transaction.new(body, wits);
      return Buffer.from(signed.to_bytes()).toString('hex');
    },
  });

  // Verbose wrapper around the handler so each phase is visible.
  const pay: PayHandler = async (req) => {
    console.log(`[402] requirements: ${req.amount} of ${req.asset} → ${req.payTo} on ${req.network}`);
    const result = await bridgePay(req);
    console.log(`[pay] signed, nonceRef = ${result.nonceRef}`);
    return result;
  };

  const paidFetch = x402Fetch({ pay });
  const res = await paidFetch(url, {
    method:  METHOD,
    headers: BODY ? { 'Content-Type': 'application/json' } : {},
    body:    BODY ?? undefined,
  });

  const text = await res.text();
  console.log(`status: ${res.status}`);

  const settlementB64 = res.headers.get('x-payment-response');
  if (settlementB64) {
    const settle = JSON.parse(Buffer.from(settlementB64, 'base64').toString('utf8'));
    console.log(`X-PAYMENT-RESPONSE: ${JSON.stringify(settle)}`);
    console.log(`Cardanoscan: https://preprod.cardanoscan.io/transaction/${settle.transaction}`);
  }
  console.log(`body: ${text.slice(0, 300)}${text.length > 300 ? '…' : ''}`);

  await bridge.shutdown();
  if (res.status !== 200) process.exit(1);
  console.log('\nSUCCESS — preprod e2e round-trip works (x402Fetch + createBridgePayHandler).');
}

main().catch(async err => {
  console.error('FAIL:', err?.stack ?? err);
  try { await bridge.shutdown(); } catch { /* ignore */ }
  process.exit(1);
});
