/**
 * Mint CHAINFEED's mock-USDM on preprod.
 *
 * Native-script (sig-only) policy bound to the dev wallet's payment vkey.
 * Mints 1_000_000_000_000 raw units (= 1,000,000 USDM at 6 decimals) to the
 * dev wallet. Writes the resulting policy ID into .env.local.
 *
 * Prereqs (in .env.local, sourced into env):
 *   - CHAINFEED_WALLET_MNEMONIC
 *   - BLOCKFROST_API_KEY (preprod)
 *   - NETWORK=preprod, BACKENDS=blockfrost, TX_BUILDERS=buildooor
 *
 * Run:
 *   set -a && source .env.local && set +a && node scripts/mint-mock-usdm.js
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as bip39 from 'bip39';
import * as CSL from '@emurgo/cardano-serialization-lib-nodejs';

const bridge = require('../srv/external/odatano-bridge');

const NETWORK_ID    = 0;                          // 0 = testnet (preprod/preview), 1 = mainnet
const ASSET_NAME    = process.env.X402_USDM_NAME_HEX || '0014df105553444d';
const MINT_RAW      = 1_000_000_000_000n;         // 1,000,000 USDM at 6 decimals
const ENV_LOCAL     = path.join(__dirname, '..', '.env.local');

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

function buildAddress(networkId: number, payment: CSL.Bip32PrivateKey, stake: CSL.Bip32PrivateKey): CSL.Address {
  return CSL.BaseAddress.new(
    networkId,
    CSL.Credential.from_keyhash(payment.to_public().to_raw_key().hash()),
    CSL.Credential.from_keyhash(stake.to_public().to_raw_key().hash()),
  ).to_address();
}

interface ProtoParams {
  minFeeA: number | string;
  minFeeB: number | string;
  poolDeposit: number | string;
  keyDeposit: number | string;
  maxValSize: number | string;
  maxTxSize: number | string;
  coinsPerUtxoSize: number | string;
}

function txBuilderFromParams(params: ProtoParams): CSL.TransactionBuilder {
  return CSL.TransactionBuilder.new(
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
      .build()
  );
}

function appendEnvLine(key: string, value: string): void {
  let body = '';
  if (fs.existsSync(ENV_LOCAL)) body = fs.readFileSync(ENV_LOCAL, 'utf8');
  // Drop any prior X402_USDM_POLICY line (commented-out or otherwise)
  body = body.replace(/^[#\s]*X402_USDM_POLICY=.*$\n?/m, '');
  if (!body.endsWith('\n')) body += '\n';
  body += `${key}=${value}\n`;
  fs.writeFileSync(ENV_LOCAL, body);
}

async function main() {
  const mnemonic = process.env.CHAINFEED_WALLET_MNEMONIC;
  if (!mnemonic) throw new Error('CHAINFEED_WALLET_MNEMONIC not set — source .env.local');
  if (!process.env.BLOCKFROST_API_KEY) throw new Error('BLOCKFROST_API_KEY not set');

  const { payment, stake } = deriveKeys(mnemonic);
  const paymentVkeyHash = payment.to_public().to_raw_key().hash();
  const ourAddress = buildAddress(NETWORK_ID, payment, stake);
  const ourBech32 = ourAddress.to_bech32();
  console.log('Wallet (preprod):', ourBech32);

  // Native script: a single signature requirement bound to our payment vkey.
  // Policy ID = blake2b224 of the script's serialised form.
  const sigScript = CSL.NativeScript.new_script_pubkey(
    CSL.ScriptPubkey.new(paymentVkeyHash),
  );
  const policyHash = sigScript.hash();
  const policyHex  = Buffer.from(policyHash.to_bytes()).toString('hex');
  console.log('Mock-USDM policy ID:', policyHex);
  console.log('Asset name hex:     ', ASSET_NAME);
  console.log('Mint amount (raw):  ', MINT_RAW.toString(), `(= ${Number(MINT_RAW) / 1e6} USDM)`);

  // Fetch on-chain state
  console.log('\nFetching protocol parameters + UTxOs ...');
  const [params, utxos] = await Promise.all([
    bridge.getProtocolParameters(),
    bridge.getUtxosAtAddress(ourBech32),
  ]);
  if (utxos.length === 0) throw new Error('No UTxOs at wallet — fund it first');

  // Pick a fat ADA-only UTxO as primary input (avoids partial multi-asset chunks).
  const fundingUtxo = utxos.find((u: { assets: unknown[]; lovelace: string }) =>
    u.assets.length === 0 && BigInt(u.lovelace) > 5_000_000n) ?? utxos[0];
  console.log(`Using input ${fundingUtxo.txHash}#${fundingUtxo.outputIndex} (${fundingUtxo.lovelace} lovelace)`);

  // Build the tx
  const builder = txBuilderFromParams(params);

  // Input
  builder.add_key_input(
    paymentVkeyHash,
    CSL.TransactionInput.new(
      CSL.TransactionHash.from_bytes(Buffer.from(fundingUtxo.txHash, 'hex')),
      fundingUtxo.outputIndex,
    ),
    CSL.Value.new(CSL.BigNum.from_str(fundingUtxo.lovelace)),
  );

  // Mint — modern MintBuilder API
  const mintBuilder = CSL.MintBuilder.new();
  const assetNameObj = CSL.AssetName.new(Buffer.from(ASSET_NAME, 'hex'));
  mintBuilder.add_asset(
    CSL.MintWitness.new_native_script(CSL.NativeScriptSource.new(sigScript)),
    assetNameObj,
    CSL.Int.from_str(MINT_RAW.toString()),
  );
  builder.set_mint_builder(mintBuilder);

  // Output: send the minted tokens (with min-ADA) back to ourselves.
  // Build a Value with the multi-asset payload, let CSL compute min-ADA, set coin.
  const multiAsset = CSL.MultiAsset.new();
  const assetMap   = CSL.Assets.new();
  assetMap.insert(assetNameObj, CSL.BigNum.from_str(MINT_RAW.toString()));
  multiAsset.insert(policyHash, assetMap);

  const tokenValue = CSL.Value.new(CSL.BigNum.from_str('0'));
  tokenValue.set_multiasset(multiAsset);

  // Provisional output to compute min-ADA, then bump coin to that amount.
  const provisionalOut = CSL.TransactionOutput.new(ourAddress, tokenValue);
  const minAda = CSL.min_ada_for_output(
    provisionalOut,
    CSL.DataCost.new_coins_per_byte(CSL.BigNum.from_str(String(params.coinsPerUtxoSize))),
  );
  tokenValue.set_coin(minAda);
  builder.add_output(CSL.TransactionOutput.new(ourAddress, tokenValue));

  // Change → ourselves (fee + remaining ADA)
  builder.add_change_if_needed(ourAddress);

  // Finalise + sign. Modern CSL drops `hash_transaction(body)` — go via
  // FixedTransaction which exposes `transaction_hash()` over canonical body bytes.
  const txBody  = builder.build();
  const txHash  = CSL.FixedTransaction
    .new_from_body_bytes(txBody.to_bytes())
    .transaction_hash();
  const witnesses = CSL.TransactionWitnessSet.new();

  const vkeyWits = CSL.Vkeywitnesses.new();
  vkeyWits.add(CSL.make_vkey_witness(txHash, payment.to_raw_key()));
  witnesses.set_vkeys(vkeyWits);

  const nativeScripts = CSL.NativeScripts.new();
  nativeScripts.add(sigScript);
  witnesses.set_native_scripts(nativeScripts);

  const signedTx = CSL.Transaction.new(txBody, witnesses);
  const cborHex  = Buffer.from(signedTx.to_bytes()).toString('hex');

  console.log(`\nSigned tx size: ${cborHex.length / 2} bytes`);
  console.log(`Estimated fee:  ${txBody.fee().to_str()} lovelace`);
  console.log(`Submitting ...`);

  const submittedHash = await bridge.submitTransaction(cborHex);
  console.log(`\nSUBMITTED: ${submittedHash}`);
  console.log(`Track: https://preprod.cardanoscan.io/transaction/${submittedHash}`);

  // Persist policy ID for downstream x402 work
  appendEnvLine('X402_USDM_POLICY', policyHex);
  console.log(`\nWrote X402_USDM_POLICY=${policyHex} to .env.local`);

  await bridge.shutdown();
}

main().catch(async err => {
  console.error('FAIL:', err?.stack ?? err);
  try { await bridge.shutdown(); } catch {}
  process.exit(1);
});
