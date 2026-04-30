/**
 * Decode round-trip smoke. Builds a minimal signed Cardano Transaction
 * with CSL, wraps it in the x402 X-PAYMENT envelope, decodes it, and
 * runs validate end-to-end. No chain, no DB.
 *
 * Run: npx tsx scripts/test-x402-decode.ts
 */

import assert from 'node:assert/strict';
import * as CSL from '@emurgo/cardano-serialization-lib-nodejs';
import * as bip39 from 'bip39';
import { decode } from '../srv/x402/decode';
import { validatePayment } from '../srv/x402/validate';
import { Codes, X402Error } from '../srv/x402/errors';

const NETWORK = 'cardano-preprod';
const ASSET_NAME = '0014df105553444d';
const harden = (n: number) => n | 0x80000000;

interface KeyPair {
  payment: CSL.Bip32PrivateKey;
  stake: CSL.Bip32PrivateKey;
}

function deriveKeys(mnemonic: string): KeyPair {
  const entropy = bip39.mnemonicToEntropy(mnemonic);
  const root = CSL.Bip32PrivateKey.from_bip39_entropy(
    Buffer.from(entropy, 'hex'),
    Buffer.from(''),
  );
  const account = root.derive(harden(1852)).derive(harden(1815)).derive(harden(0));
  return { payment: account.derive(0).derive(0), stake: account.derive(2).derive(0) };
}

function buildAddress(payment: CSL.Bip32PrivateKey, stake: CSL.Bip32PrivateKey, networkId = 0): CSL.Address {
  return CSL.BaseAddress.new(
    networkId,
    CSL.Credential.from_keyhash(payment.to_public().to_raw_key().hash()),
    CSL.Credential.from_keyhash(stake.to_public().to_raw_key().hash()),
  ).to_address();
}

interface BuildSignedTxArgs {
  buyer: KeyPair;
  payTo: CSL.Address;
  policyHex: string;
  assetNameHex: string;
  quantity: string;
  fakeInputHash: string;
}

function buildSignedPaymentTx({ buyer, payTo, policyHex, assetNameHex, quantity, fakeInputHash }: BuildSignedTxArgs): string {
  const builder = CSL.TransactionBuilder.new(
    CSL.TransactionBuilderConfigBuilder.new()
      .fee_algo(CSL.LinearFee.new(CSL.BigNum.from_str('44'), CSL.BigNum.from_str('155381')))
      .pool_deposit(CSL.BigNum.from_str('500000000'))
      .key_deposit(CSL.BigNum.from_str('2000000'))
      .max_value_size(5000)
      .max_tx_size(16384)
      .coins_per_utxo_byte(CSL.BigNum.from_str('4310'))
      .build(),
  );

  // Synthetic input that already holds the token + 10 ADA, so balance
  // closes when we ship `quantity` of the asset to payTo.
  const inputMa = CSL.MultiAsset.new();
  const inputAssets = CSL.Assets.new();
  const policyForInput = CSL.ScriptHash.from_bytes(Buffer.from(policyHex, 'hex'));
  inputAssets.insert(
    CSL.AssetName.new(Buffer.from(assetNameHex, 'hex')),
    CSL.BigNum.from_str(String(quantity)),
  );
  inputMa.insert(policyForInput, inputAssets);
  const inputValue = CSL.Value.new(CSL.BigNum.from_str('10000000'));
  inputValue.set_multiasset(inputMa);

  builder.add_key_input(
    buyer.payment.to_public().to_raw_key().hash(),
    CSL.TransactionInput.new(
      CSL.TransactionHash.from_bytes(Buffer.from(fakeInputHash, 'hex')),
      0,
    ),
    inputValue,
  );

  // Output to payTo: token + min-ADA
  const ma = CSL.MultiAsset.new();
  const assets = CSL.Assets.new();
  const policy = CSL.ScriptHash.from_bytes(Buffer.from(policyHex, 'hex'));
  assets.insert(
    CSL.AssetName.new(Buffer.from(assetNameHex, 'hex')),
    CSL.BigNum.from_str(String(quantity)),
  );
  ma.insert(policy, assets);
  const value = CSL.Value.new(CSL.BigNum.from_str('0'));
  value.set_multiasset(ma);
  const provisional = CSL.TransactionOutput.new(payTo, value);
  const minAda = CSL.min_ada_for_output(
    provisional,
    CSL.DataCost.new_coins_per_byte(CSL.BigNum.from_str('4310')),
  );
  value.set_coin(minAda);
  builder.add_output(CSL.TransactionOutput.new(payTo, value));

  builder.add_change_if_needed(buildAddress(buyer.payment, buyer.stake, 0));

  const txBody = builder.build();
  const txHash = CSL.FixedTransaction.new_from_body_bytes(txBody.to_bytes()).transaction_hash();

  const witnesses = CSL.TransactionWitnessSet.new();
  const vkeyWits = CSL.Vkeywitnesses.new();
  vkeyWits.add(CSL.make_vkey_witness(txHash, buyer.payment.to_raw_key()));
  witnesses.set_vkeys(vkeyWits);

  const signedTx = CSL.Transaction.new(txBody, witnesses);
  return Buffer.from(signedTx.to_bytes()).toString('base64');
}

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

console.log('decode + validate ─────────────────────────────────────');

// --- malformed input rejection ---
t('missing header → MISSING_HEADER', () => {
  try { decode(undefined); throw new Error('should have thrown'); }
  catch (e) { assert(e instanceof X402Error); assert.equal((e as X402Error).code, Codes.MISSING_HEADER); }
});

t('non-base64 garbage → INVALID_BASE64', () => {
  try { decode('!!!notbase64!!!'); throw new Error('should have thrown'); }
  catch (e) { assert.equal((e as X402Error).code, Codes.INVALID_BASE64); }
});

t('valid base64 but invalid JSON → INVALID_JSON', () => {
  const b64 = Buffer.from('not json', 'utf8').toString('base64');
  try { decode(b64); throw new Error('should have thrown'); }
  catch (e) { assert.equal((e as X402Error).code, Codes.INVALID_JSON); }
});

t('missing field → MISSING_FIELD', () => {
  const b64 = Buffer.from(JSON.stringify({ x402Version: 1, scheme: 'exact', network: 'cardano-preprod' }), 'utf8').toString('base64');
  try { decode(b64); throw new Error('should have thrown'); }
  catch (e) { assert.equal((e as X402Error).code, Codes.MISSING_FIELD); }
});

t('unsupported version → UNSUPPORTED_VERSION', () => {
  const body = { x402Version: 99, scheme: 'exact', network: 'cardano-preprod', payload: { transaction: 'AA==' } };
  const b64 = Buffer.from(JSON.stringify(body), 'utf8').toString('base64');
  try { decode(b64); throw new Error('should have thrown'); }
  catch (e) { assert.equal((e as X402Error).code, Codes.UNSUPPORTED_VERSION); }
});

// --- happy path with real CBOR ---
const buyerMnemonic  = bip39.generateMnemonic(256);
const sellerMnemonic = bip39.generateMnemonic(256);
const buyer  = deriveKeys(buyerMnemonic);
const seller = deriveKeys(sellerMnemonic);
const sellerAddr = buildAddress(seller.payment, seller.stake, 0);
const sellerBech32 = sellerAddr.to_bech32();

const policyHex = '00'.repeat(28); // synthetic policy — not real, just for format
const QUANTITY  = '250000';        // 0.25 mock-USDM
const fakeInputHash = '11'.repeat(32);

const txBase64 = buildSignedPaymentTx({
  buyer, payTo: sellerAddr,
  policyHex, assetNameHex: ASSET_NAME, quantity: QUANTITY,
  fakeInputHash,
});
const xPayment = Buffer.from(JSON.stringify({
  x402Version: 1, scheme: 'exact', network: NETWORK,
  payload: { transaction: txBase64 },
}), 'utf8').toString('base64');

t('round-trip: built tx decodes cleanly', () => {
  const d = decode(xPayment);
  assert.equal(d.x402Version, 1);
  assert.equal(d.scheme, 'exact');
  assert.equal(d.network, NETWORK);
  assert.equal(d.txHash.length, 64);
  assert.equal(d.vkeyWitnessCount, 1);
  assert.ok(d.outputs.length >= 1);
  const sellerOut = d.outputs.find(o => o.address === sellerBech32);
  assert.ok(sellerOut, 'seller output present');
  const tokenAsset = sellerOut!.assets.find(a => a.policyId === policyHex.toLowerCase());
  assert.ok(tokenAsset, 'token asset present in seller output');
  assert.equal(tokenAsset!.quantity, QUANTITY);
});

t('round-trip + validate: payment passes', () => {
  const d = decode(xPayment);
  const r = validatePayment(d, {
    scheme: 'exact', network: NETWORK,
    maxAmountRequired: QUANTITY,
    asset: policyHex, payTo: sellerBech32,
    resource: '/test',
    description: 'test', mimeType: 'application/json', outputSchema: null, maxTimeoutSeconds: 600,
    extra: { assetNameHex: ASSET_NAME, decimals: 6 },
  });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.claim.amountUnits, QUANTITY);
});

t('round-trip + validate: insufficient when requirement higher', () => {
  const d = decode(xPayment);
  const r = validatePayment(d, {
    scheme: 'exact', network: NETWORK,
    maxAmountRequired: '999999999',
    asset: policyHex, payTo: sellerBech32,
    resource: '/test',
    description: 'test', mimeType: 'application/json', outputSchema: null, maxTimeoutSeconds: 600,
    extra: { assetNameHex: ASSET_NAME, decimals: 6 },
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, Codes.INSUFFICIENT_AMOUNT);
});

console.log(`\n${n - fails}/${n} passed`);
process.exit(fails ? 1 : 0);
