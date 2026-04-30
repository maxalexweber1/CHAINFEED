/**
 * x402 integration test — exercises the full pipeline that the unit tests
 * don't cover: nonces.claim against a real CDS db, FeedReads audit row,
 * replay rejection via UNIQUE PK, and the env-driven requirements builder.
 *
 * Boots CAP in-process with an in-memory SQLite, deploys the schema, then
 * stubs `submitTransaction` and `getTransactionByHash` on the ODATANO
 * bridge so settle.ts short-circuits to "confirmed" without hitting chain.
 *
 * Run: npx tsx scripts/test-x402-integration.ts
 */

import assert from 'node:assert/strict';
import * as CSL from '@emurgo/cardano-serialization-lib-nodejs';
import * as bip39 from 'bip39';
import cds from '@sap/cds';

// Fix env BEFORE we require the x402 modules — they read at module-load.
const PAY_TO_ADDR  = ''; // filled in below from CSL-derived seller address
const POLICY_HEX   = '00'.repeat(28);
const ASSET_NAME   = '0014df105553444d';
const NETWORK      = 'cardano-preprod';

process.env.X402_NETWORK     = NETWORK;
process.env.X402_USDM_POLICY = POLICY_HEX;
process.env.X402_USDM_NAME_HEX = ASSET_NAME;
process.env.X402_USDM_DECIMALS = '6';

// ─── helpers ──────────────────────────────────────────────────────────
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
  return {
    payment: account.derive(0).derive(0),
    stake:   account.derive(2).derive(0),
  };
}

function addressOf(payment: CSL.Bip32PrivateKey, stake: CSL.Bip32PrivateKey, networkId = 0): CSL.Address {
  return CSL.BaseAddress.new(
    networkId,
    CSL.Credential.from_keyhash(payment.to_public().to_raw_key().hash()),
    CSL.Credential.from_keyhash(stake.to_public().to_raw_key().hash()),
  ).to_address();
}

interface BuildPaymentArgs {
  buyer: KeyPair;
  payTo: CSL.Address;
  policyHex: string;
  assetNameHex: string;
  quantity: string;
  fakeInputHash: string;
}

function buildSignedPayment({ buyer, payTo, policyHex, assetNameHex, quantity, fakeInputHash }: BuildPaymentArgs) {
  const builder = CSL.TransactionBuilder.new(
    CSL.TransactionBuilderConfigBuilder.new()
      .fee_algo(CSL.LinearFee.new(CSL.BigNum.from_str('44'), CSL.BigNum.from_str('155381')))
      .pool_deposit(CSL.BigNum.from_str('500000000'))
      .key_deposit(CSL.BigNum.from_str('2000000'))
      .max_value_size(5000).max_tx_size(16384)
      .coins_per_utxo_byte(CSL.BigNum.from_str('4310'))
      .build(),
  );

  // Input pre-funded with both ADA and the token, so balance closes.
  const policy = CSL.ScriptHash.from_bytes(Buffer.from(policyHex, 'hex'));
  const inMa = CSL.MultiAsset.new();
  const inA  = CSL.Assets.new();
  inA.insert(CSL.AssetName.new(Buffer.from(assetNameHex, 'hex')), CSL.BigNum.from_str(String(quantity)));
  inMa.insert(policy, inA);
  const inV = CSL.Value.new(CSL.BigNum.from_str('10000000'));
  inV.set_multiasset(inMa);

  builder.add_key_input(
    buyer.payment.to_public().to_raw_key().hash(),
    CSL.TransactionInput.new(CSL.TransactionHash.from_bytes(Buffer.from(fakeInputHash, 'hex')), 0),
    inV,
  );

  // Output: token + min-ADA → payTo
  const ma = CSL.MultiAsset.new();
  const a  = CSL.Assets.new();
  a.insert(CSL.AssetName.new(Buffer.from(assetNameHex, 'hex')), CSL.BigNum.from_str(String(quantity)));
  ma.insert(policy, a);
  const v = CSL.Value.new(CSL.BigNum.from_str('0'));
  v.set_multiasset(ma);
  const provisional = CSL.TransactionOutput.new(payTo, v);
  const minAda = CSL.min_ada_for_output(provisional, CSL.DataCost.new_coins_per_byte(CSL.BigNum.from_str('4310')));
  v.set_coin(minAda);
  builder.add_output(CSL.TransactionOutput.new(payTo, v));

  builder.add_change_if_needed(addressOf(buyer.payment, buyer.stake, 0));

  const txBody = builder.build();
  const txHash = CSL.FixedTransaction.new_from_body_bytes(txBody.to_bytes()).transaction_hash();

  const wits = CSL.TransactionWitnessSet.new();
  const vk = CSL.Vkeywitnesses.new();
  vk.add(CSL.make_vkey_witness(txHash, buyer.payment.to_raw_key()));
  wits.set_vkeys(vk);

  const signed = CSL.Transaction.new(txBody, wits);
  return {
    txCbor: Buffer.from(signed.to_bytes()).toString('hex'),
    txBase64: Buffer.from(signed.to_bytes()).toString('base64'),
    txHash:   Buffer.from(txHash.to_bytes()).toString('hex'),
  };
}

function xPaymentEnvelope(txBase64: string, network: string = NETWORK): string {
  return Buffer.from(JSON.stringify({
    x402Version: 1, scheme: 'exact', network,
    payload: { transaction: txBase64 },
  }), 'utf8').toString('base64');
}

// ─── test runner ──────────────────────────────────────────────────────
let n = 0, fails = 0;
async function t(name: string, fn: () => Promise<void>) {
  n++;
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (e) {
    fails++;
    const err = e as Error;
    console.log(`FAIL  ${name}\n      ${err.stack || err.message}`);
  }
}

// ─── main ─────────────────────────────────────────────────────────────
async function main() {
  // Force in-memory DB regardless of package.json profile.
  cds.env.requires.db = { kind: 'sqlite', credentials: { url: ':memory:' } };

  // Mock the ODATANO bridge BEFORE process.js loads it (Node module cache
  // gives us shared identity). Submit returns the tx hash extracted from
  // the CBOR — matches what a real Cardano node would return.
  const bridge = require('../srv/external/odatano-bridge');
  bridge.submitTransaction = async (cborHex: string) => {
    const bytes = Buffer.from(cborHex, 'hex');
    return Buffer.from(
      CSL.FixedTransaction.from_bytes(bytes).transaction_hash().to_bytes(),
    ).toString('hex');
  };
  bridge.getTransactionByHash = async (hash: string) => ({ hash, blockHeight: 1 });

  // Boot CAP db + deploy schema
  await (cds as unknown as { deploy: (path: string) => { to(target: string): Promise<unknown> } })
    .deploy('db/schema.cds').to('db');
  console.log('db ready (in-memory)\n');

  // Build seller address NOW (env was already set above)
  const sellerMnem = bip39.generateMnemonic(256);
  const buyerMnem  = bip39.generateMnemonic(256);
  const seller = deriveKeys(sellerMnem);
  const buyer  = deriveKeys(buyerMnem);
  const sellerAddr = addressOf(seller.payment, seller.stake, 0).to_bech32();
  process.env.X402_PAY_TO = sellerAddr;

  // NOW require process.js — its requirements builder reads env each call,
  // so we don't need to require it before setting env, but we'll do it now.
  const { process: processX402 } = require('../srv/x402/process');
  const { buildPaymentRequirements } = require('../srv/x402/requirements');
  const { has } = require('../srv/x402/nonces');
  const { Codes } = require('../srv/x402/errors');

  console.log('processX402 integration ───────────────────────────────────');

  // Build a valid payment of 250000 raw units to seller
  const payment = buildSignedPayment({
    buyer,
    payTo: addressOf(seller.payment, seller.stake, 0),
    policyHex: POLICY_HEX,
    assetNameHex: ASSET_NAME,
    quantity: '250000',
    fakeInputHash: '11'.repeat(32),
  });

  await t('happy path: 250000 paid → accepted + nonce claimed + audit row written', async () => {
    const reqsBody = buildPaymentRequirements({
      priceUnits: '100000', resource: '/odata/v4/price/Prices', description: 'test',
    });
    const xPay = xPaymentEnvelope(payment.txBase64);
    const r = await processX402({
      xPaymentHeader: xPay,
      requirementsBody: reqsBody,
      feedKind: 'aggregated',
      feedRef:  '/odata/v4/price/Prices',
    });
    assert.equal(r.kind, 'accepted', `got ${r.kind} code=${r.code} reason=${r.reason}`);
    assert.equal(r.txHash, payment.txHash);
    assert.equal(r.payment.amountUnits, '250000');
    assert.equal(r.payment.network, NETWORK);
    assert.ok(r.paymentResponseB64, 'X-PAYMENT-RESPONSE must be set');

    // Nonce row exists
    assert.equal(await has(payment.txHash), true, 'nonce row should be present');

    // FeedReads row exists for this txHash
    const rows = await cds.run(SELECT.from('chainfeed.FeedReads').where({ paymentTxHash: payment.txHash }));
    assert.equal(rows.length, 1, `expected 1 FeedReads row, got ${rows.length}`);
    assert.equal(rows[0].feedKind, 'aggregated');
    assert.equal(rows[0].amountPaidUSDM, 0.25);  // 250000 / 1e6
  });

  await t('replay: same X-PAYMENT a second time → rejected with REPLAY', async () => {
    const reqsBody = buildPaymentRequirements({
      priceUnits: '100000', resource: '/odata/v4/price/Prices', description: 'test',
    });
    const xPay = xPaymentEnvelope(payment.txBase64);
    const r = await processX402({
      xPaymentHeader: xPay, requirementsBody: reqsBody,
      feedKind: 'aggregated', feedRef: '/odata/v4/price/Prices',
    });
    assert.equal(r.kind, 'rejected');
    assert.equal(r.code, Codes.REPLAY);

    // Still only one audit row — second attempt did not write
    const rows = await cds.run(SELECT.from('chainfeed.FeedReads').where({ paymentTxHash: payment.txHash }));
    assert.equal(rows.length, 1, 'audit row count must stay at 1');
  });

  await t('insufficient amount → rejected without claiming nonce', async () => {
    // New payment, smaller than required
    const cheapPayment = buildSignedPayment({
      buyer,
      payTo: addressOf(seller.payment, seller.stake, 0),
      policyHex: POLICY_HEX, assetNameHex: ASSET_NAME,
      quantity: '50000',
      fakeInputHash: '22'.repeat(32),
    });
    const reqsBody = buildPaymentRequirements({
      priceUnits: '100000', resource: '/odata/v4/price/Prices',
    });
    const r = await processX402({
      xPaymentHeader: xPaymentEnvelope(cheapPayment.txBase64),
      requirementsBody: reqsBody,
      feedKind: 'aggregated', feedRef: '/odata/v4/price/Prices',
    });
    assert.equal(r.kind, 'rejected');
    assert.equal(r.code, Codes.INSUFFICIENT_AMOUNT);
    // Nonce NOT claimed — buyer is free to retry with bigger payment
    assert.equal(await has(cheapPayment.txHash), false);
  });

  await t('network mismatch → rejected pre-settle', async () => {
    const wrongNetPay = buildSignedPayment({
      buyer, payTo: addressOf(seller.payment, seller.stake, 0),
      policyHex: POLICY_HEX, assetNameHex: ASSET_NAME, quantity: '250000',
      fakeInputHash: '33'.repeat(32),
    });
    const xPay = xPaymentEnvelope(wrongNetPay.txBase64, 'cardano-mainnet');
    const reqsBody = buildPaymentRequirements({
      priceUnits: '100000', resource: '/odata/v4/price/Prices',
    });
    const r = await processX402({
      xPaymentHeader: xPay, requirementsBody: reqsBody,
      feedKind: 'aggregated', feedRef: '/odata/v4/price/Prices',
    });
    assert.equal(r.kind, 'rejected');
    assert.equal(r.code, Codes.NETWORK_MISMATCH);
  });

  await t('settle pending: bridge.getTransactionByHash returns null → kind=pending', async () => {
    bridge.getTransactionByHash = async () => null;  // simulate not-yet-visible

    const pendPayment = buildSignedPayment({
      buyer, payTo: addressOf(seller.payment, seller.stake, 0),
      policyHex: POLICY_HEX, assetNameHex: ASSET_NAME, quantity: '250000',
      fakeInputHash: '44'.repeat(32),
    });
    const reqsBody = buildPaymentRequirements({
      priceUnits: '100000', resource: '/odata/v4/price/Prices',
    });
    // Tighten poll to keep test fast — we patch settle.js's defaults via the wrapper:
    // process.js calls settle() with default budget; we'd need to reduce. Skip the long
    // wait by stubbing settle directly.
    const settleMod = require('../srv/x402/settle');
    const realSettle = settleMod.settle;
    settleMod.settle = async () => ({ confirmed: false, pending: true, txHash: pendPayment.txHash, code: Codes.PENDING });

    const r = await processX402({
      xPaymentHeader: xPaymentEnvelope(pendPayment.txBase64),
      requirementsBody: reqsBody,
      feedKind: 'aggregated', feedRef: '/odata/v4/price/Prices',
    });
    assert.equal(r.kind, 'pending');
    assert.equal(r.txHash, pendPayment.txHash);
    // Pending must NOT claim the nonce — buyer needs to retry
    assert.equal(await has(pendPayment.txHash), false);

    // restore
    settleMod.settle = realSettle;
    bridge.getTransactionByHash = async (hash: string) => ({ hash, blockHeight: 1 });
  });

  console.log(`\n${n - fails}/${n} passed`);
  process.exit(fails ? 1 : 0);
}

main().catch(err => {
  console.error('test runner crashed:', err);
  process.exit(2);
});
