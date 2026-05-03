/**
 * Server-side unsigned-payment-tx builder for browser-based x402 buyers.
 *
 * The browser knows the buyer's bech32 address (via CIP-30 wallet) but
 * not its private signing keys. This module mirrors the coin-selection
 * + tx-construction logic from `scripts/buyer-pay-and-fetch.ts`, stops
 * before the signing step, and returns the unsigned tx CBOR for the
 * wallet to sign in-browser.
 *
 * Why server-side instead of pure browser-side: replicating the CSL
 * coin-selection + protocol-params + change-handling pipeline in the
 * browser would mean shipping ~2 MB of WASM crypto plus a re-implementation
 * of the existing CHAINFEED tx-building logic. Server-side keeps the
 * browser bundle slim AND ensures the unsigned tx matches the same
 * patterns the existing buyer-pay-and-fetch script proves on preprod.
 *
 * **x402 spec deviation:** strict x402 has the buyer construct the tx
 * end-to-end. CHAINFEED's server-side helper is a "self-facilitator"
 * pattern — the server builds, the buyer signs, the server still
 * validates the signed tx against requirements before settling. Same
 * security model, easier browser ergonomics.
 */

import * as CSL from '@emurgo/cardano-serialization-lib-nodejs';
import bridge from '../external/odatano-bridge';
import type { PaymentRequirementEntry } from './requirements';

interface UtxoLite {
  txHash: string;
  outputIndex: number;
  lovelace: string;
  assets: Array<{ unit: string; policyId: string; assetNameHex: string; quantity: string }>;
}

interface ProtoParams {
  minFeeA:          number | string;
  minFeeB:          number | string;
  poolDeposit:      number | string;
  keyDeposit:       number | string;
  maxValSize:       number | string;
  maxTxSize:        number | string;
  coinsPerUtxoSize: number | string;
}

export interface UnsignedTxResult {
  /** CBOR-hex of the unsigned tx (empty witness set), ready for CIP-30 `signTx`. */
  unsignedTxCborHex: string;
  /** Hex tx hash (matches what the buyer's wallet will display). */
  txHashHex:         string;
  /** Buyer's payment-cred VKey hash — the wallet must sign for this. */
  requiredSignerHex: string;
  /** Echo of the inputs we picked, so the buyer's UI can show "spends these UTxOs". */
  inputs: Array<{ txHash: string; outputIndex: number; lovelace: string }>;
}

/**
 * Build an unsigned x402 payment tx for `buyerBech32`.
 *
 * Coin selection: largest-ADA UTxO that holds enough USDM. If that UTxO
 * has < 3 ADA, attach the next-largest ADA UTxO at the same address as
 * fee padding (matches the script's strategy).
 */
export async function buildUnsignedPaymentTx(
  buyerBech32: string,
  requirements: PaymentRequirementEntry,
): Promise<UnsignedTxResult> {
  // 1. Decode buyer address; derive payment-cred VKey hash for the input
  //    "required signer" hint AND for buildooor's add_key_input.
  let buyerAddress: CSL.Address;
  try {
    buyerAddress = CSL.Address.from_bech32(buyerBech32);
  } catch {
    throw new Error(`buildUnsignedPaymentTx: invalid bech32 address: ${buyerBech32}`);
  }

  // BaseAddress / EnterpriseAddress / RewardAddress all expose payment_cred()
  // through the typed wrappers. We accept any, but require it to be a key-hash
  // credential (script-payment buyers can't sign via CIP-30 anyway).
  const baseAddr       = CSL.BaseAddress.from_address(buyerAddress);
  const enterpriseAddr = CSL.EnterpriseAddress.from_address(buyerAddress);
  const paymentCred    = baseAddr?.payment_cred() ?? enterpriseAddr?.payment_cred();
  if (!paymentCred) {
    throw new Error('buildUnsignedPaymentTx: only Base / Enterprise addresses are supported');
  }
  const buyerVkeyHash = paymentCred.to_keyhash();
  if (!buyerVkeyHash) {
    throw new Error('buildUnsignedPaymentTx: payment credential must be a VKey hash, not a script');
  }
  const requiredSignerHex = Buffer.from(buyerVkeyHash.to_bytes()).toString('hex');

  // 2. Query buyer's UTxOs via the bridge.
  const utxos: UtxoLite[] = await bridge.getUtxosAtAddress(buyerBech32);
  if (!Array.isArray(utxos) || utxos.length === 0) {
    throw new Error(`buildUnsignedPaymentTx: no UTxOs at ${buyerBech32}`);
  }
  const usdmUnit = (requirements.asset + requirements.extra.assetNameHex).toLowerCase();
  const required = BigInt(requirements.maxAmountRequired);

  const candidates = utxos
    .filter(u => u.assets.some(a => a.unit === usdmUnit && BigInt(a.quantity) >= required))
    .sort((a, b) => (BigInt(b.lovelace) - BigInt(a.lovelace) > 0n ? 1 : -1));
  if (candidates.length === 0) {
    throw new Error(
      `buildUnsignedPaymentTx: no UTxO at ${buyerBech32} holds ≥ ${required} of ${usdmUnit}`,
    );
  }

  const tokenInput = candidates[0]!;
  const inputs: UtxoLite[] = [tokenInput];
  if (BigInt(tokenInput.lovelace) < 3_000_000n) {
    const padding = utxos
      .filter(u => u !== tokenInput)
      .sort((a, b) => (BigInt(b.lovelace) - BigInt(a.lovelace) > 0n ? 1 : -1))[0];
    if (!padding) {
      throw new Error('buildUnsignedPaymentTx: no second UTxO available to fund fees');
    }
    inputs.push(padding);
  }

  // 3. Tx-builder config from live protocol params.
  const params = (await bridge.getProtocolParameters()) as ProtoParams;
  const builder = CSL.TransactionBuilder.new(
    CSL.TransactionBuilderConfigBuilder.new()
      .fee_algo(CSL.LinearFee.new(
        CSL.BigNum.from_str(String(params.minFeeA)),
        CSL.BigNum.from_str(String(params.minFeeB)),
      ))
      .pool_deposit(CSL.BigNum.from_str(String(params.poolDeposit)))
      .key_deposit(CSL.BigNum.from_str(String(params.keyDeposit)))
      .max_value_size(Number(params.maxValSize))
      .max_tx_size(Number(params.maxTxSize))
      .coins_per_utxo_byte(CSL.BigNum.from_str(String(params.coinsPerUtxoSize)))
      .build(),
  );

  // 4. Inputs — preserve full multi-asset payload.
  for (const u of inputs) {
    const inMa = CSL.MultiAsset.new();
    const byPolicy = new Map<string, Array<{ name: string; qty: string }>>();
    for (const a of u.assets) {
      const arr = byPolicy.get(a.policyId) ?? [];
      arr.push({ name: a.assetNameHex, qty: a.quantity });
      byPolicy.set(a.policyId, arr);
    }
    for (const [policyHex, items] of byPolicy) {
      const policyHash = CSL.ScriptHash.from_bytes(Buffer.from(policyHex, 'hex'));
      const assetMap = CSL.Assets.new();
      for (const { name, qty } of items) {
        assetMap.insert(
          CSL.AssetName.new(Buffer.from(name, 'hex')),
          CSL.BigNum.from_str(qty),
        );
      }
      inMa.insert(policyHash, assetMap);
    }

    const inV = CSL.Value.new(CSL.BigNum.from_str(u.lovelace));
    if (u.assets.length) inV.set_multiasset(inMa);

    builder.add_key_input(
      buyerVkeyHash,
      CSL.TransactionInput.new(
        CSL.TransactionHash.from_bytes(Buffer.from(u.txHash, 'hex')),
        u.outputIndex,
      ),
      inV,
    );
  }

  // 5. Output to payTo: token + min-ADA.
  const payToAddr = CSL.Address.from_bech32(requirements.payTo);
  const payOutMa  = CSL.MultiAsset.new();
  const payAssets = CSL.Assets.new();
  const policyHash = CSL.ScriptHash.from_bytes(Buffer.from(requirements.asset, 'hex'));
  payAssets.insert(
    CSL.AssetName.new(Buffer.from(requirements.extra.assetNameHex, 'hex')),
    CSL.BigNum.from_str(String(required)),
  );
  payOutMa.insert(policyHash, payAssets);

  const payOutV = CSL.Value.new(CSL.BigNum.from_str('0'));
  payOutV.set_multiasset(payOutMa);
  const provisional = CSL.TransactionOutput.new(payToAddr, payOutV);
  const minAda = CSL.min_ada_for_output(
    provisional,
    CSL.DataCost.new_coins_per_byte(CSL.BigNum.from_str(String(params.coinsPerUtxoSize))),
  );
  payOutV.set_coin(minAda);
  builder.add_output(CSL.TransactionOutput.new(payToAddr, payOutV));

  // 6. Change to buyer (residual ADA + residual tokens).
  builder.add_change_if_needed(buyerAddress);

  // 7. Build body, hash for the wallet to display, return unsigned tx.
  const txBody = builder.build();
  const txHash = CSL.FixedTransaction.new_from_body_bytes(txBody.to_bytes()).transaction_hash();

  const emptyWits = CSL.TransactionWitnessSet.new();
  const unsigned  = CSL.Transaction.new(txBody, emptyWits);

  return {
    unsignedTxCborHex: Buffer.from(unsigned.to_bytes()).toString('hex'),
    txHashHex:         Buffer.from(txHash.to_bytes()).toString('hex'),
    requiredSignerHex,
    inputs: inputs.map(i => ({ txHash: i.txHash, outputIndex: i.outputIndex, lovelace: i.lovelace })),
  };
}
