/**
 * Decode an `X-PAYMENT` header value into a structured payment payload.
 *
 * Wire format (per Masumi `scheme_exact_cardano.md`):
 *   X-PAYMENT: base64(JSON.stringify({
 *     x402Version: 1,
 *     scheme: 'exact',
 *     network: 'cardano-preprod' | 'cardano-mainnet',
 *     payload: { transaction: '<base64 CBOR of signed tx>' }
 *   }))
 */

import * as CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { X402Error, Codes, type X402Code } from './errors';

const SUPPORTED_VERSION = 1;
const SUPPORTED_SCHEME  = 'exact';

export interface DecodedAsset {
  unit: string;
  policyId: string;
  assetNameHex: string;
  quantity: string;
}

export interface DecodedOutput {
  outputIndex: number;
  address: string;
  lovelace: string;
  assets: DecodedAsset[];
}

export interface DecodedInput {
  txHash: string;
  outputIndex: number;
}

export interface DecodedPayment {
  x402Version: number;
  scheme: string;
  network: string;
  /** hex of the signed tx CBOR */
  txCborHex: string;
  /** 32-byte hex */
  txHash: string;
  outputs: DecodedOutput[];
  inputs: DecodedInput[];
  vkeyWitnessCount: number;
}

function decodeBase64ToBuffer(s: string, errCode: X402Code): Buffer {
  // Strict base64 — node's Buffer.from is lenient (silently drops bad chars),
  // so we re-encode and compare to catch malformed input early.
  const buf = Buffer.from(s, 'base64');
  if (buf.toString('base64').replace(/=+$/, '') !== String(s).replace(/=+$/, '')) {
    throw new X402Error(errCode, 'malformed base64 payload');
  }
  return buf;
}

/**
 * Extract a flat output list from a CSL Transaction body.
 * Each output is mapped to { address, lovelace, assets[{unit,quantity}] }.
 *
 * Note: this does NOT decode inline datums or scripts — x402 validation
 * only cares about who-paid-whom-what.
 */
function extractOutputs(txBody: CSL.TransactionBody): DecodedOutput[] {
  const out = txBody.outputs();
  const result: DecodedOutput[] = [];
  for (let i = 0; i < out.len(); i++) {
    const o = out.get(i);
    const addr = o.address().to_bech32();
    const value = o.amount();
    const lovelace = value.coin().to_str();

    const assets: DecodedAsset[] = [];
    const ma = value.multiasset();
    if (ma) {
      const policies = ma.keys();
      for (let p = 0; p < policies.len(); p++) {
        const policy = policies.get(p);
        const policyHex = Buffer.from(policy.to_bytes()).toString('hex');
        const assetMap = ma.get(policy);
        if (!assetMap) continue;
        const names = assetMap.keys();
        for (let n = 0; n < names.len(); n++) {
          const name = names.get(n);
          const nameHex = Buffer.from(name.name()).toString('hex');
          const qty = assetMap.get(name);
          if (!qty) continue;
          assets.push({
            unit:         (policyHex + nameHex).toLowerCase(),
            policyId:     policyHex.toLowerCase(),
            assetNameHex: nameHex.toLowerCase(),
            quantity:     qty.to_str(),
          });
        }
      }
    }
    result.push({ outputIndex: i, address: addr, lovelace, assets });
  }
  return result;
}

function extractInputs(txBody: CSL.TransactionBody): DecodedInput[] {
  const ins = txBody.inputs();
  const result: DecodedInput[] = [];
  for (let i = 0; i < ins.len(); i++) {
    const inp = ins.get(i);
    result.push({
      txHash:      Buffer.from(inp.transaction_id().to_bytes()).toString('hex'),
      outputIndex: inp.index(),
    });
  }
  return result;
}

interface RawX402Body {
  x402Version?: number;
  scheme?: string;
  network?: string;
  payload?: { transaction?: string };
}

export function decode(xPaymentHeader: string | undefined | null): DecodedPayment {
  if (!xPaymentHeader || typeof xPaymentHeader !== 'string') {
    throw new X402Error(Codes.MISSING_HEADER);
  }

  // 1. base64 → JSON
  const outerBuf = decodeBase64ToBuffer(xPaymentHeader, Codes.INVALID_BASE64);
  let body: RawX402Body;
  try { body = JSON.parse(outerBuf.toString('utf8')) as RawX402Body; }
  catch { throw new X402Error(Codes.INVALID_JSON, 'X-PAYMENT body is not valid JSON'); }

  // 2. Field shape checks
  for (const f of ['x402Version', 'scheme', 'network', 'payload'] as const) {
    if (!(f in body)) throw new X402Error(Codes.MISSING_FIELD, `missing field: ${f}`);
  }
  if (body.x402Version !== SUPPORTED_VERSION) {
    throw new X402Error(Codes.UNSUPPORTED_VERSION, `x402Version ${body.x402Version} not supported`);
  }
  if (body.scheme !== SUPPORTED_SCHEME) {
    throw new X402Error(Codes.UNSUPPORTED_SCHEME, `scheme '${body.scheme}' not supported (only 'exact')`);
  }
  if (!body.payload || typeof body.payload.transaction !== 'string') {
    throw new X402Error(Codes.MISSING_FIELD, 'payload.transaction is required');
  }

  // 3. Tx CBOR → CSL Transaction
  const txBuf = decodeBase64ToBuffer(body.payload.transaction, Codes.INVALID_CBOR);
  let tx: CSL.Transaction;
  try { tx = CSL.Transaction.from_bytes(txBuf); }
  catch { throw new X402Error(Codes.INVALID_CBOR, 'transaction CBOR did not decode'); }

  // 4. Extract diagnostics
  const txBody = tx.body();
  const wits   = tx.witness_set();
  const vkeys  = wits.vkeys();
  const vkeyWitnessCount = vkeys ? vkeys.len() : 0;

  const txHashBytes = CSL.FixedTransaction
    .from_bytes(txBuf)
    .transaction_hash()
    .to_bytes();
  const txHash = Buffer.from(txHashBytes).toString('hex');

  return {
    x402Version: body.x402Version!,
    scheme:      body.scheme!,
    network:     body.network!,
    txCborHex:   Buffer.from(txBuf).toString('hex'),
    txHash,
    outputs:     extractOutputs(txBody),
    inputs:      extractInputs(txBody),
    vkeyWitnessCount,
  };
}
