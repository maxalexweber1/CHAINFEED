/**
 * Aiken stop_loss demo — end-to-end on preprod.
 *
 * Demonstrates the full CHAINFEED-as-on-chain-oracle pattern:
 *   1. Compute the stop_loss script address from the compiled plutus.json.
 *   2. Lock 5 tADA into that script with our datum (owner = wallet,
 *      liquidator = wallet for demo, threshold = 0.30 USD, pubkey = test
 *      pubkey, max_age = 5 min).
 *   3. Build a CHAINFEED-signed quote (price = 0.50 USD, valid 5 min).
 *   4. Submit the spend tx with the signed-quote redeemer (Withdraw action).
 *   5. Print both preprod tx hashes — these are the artifacts referenced in
 *      the README + pitch deck as proof-of-concept.
 *
 * Phases (run independently so you don't burn fees on every run):
 *
 *   npx tsx scripts/demo-aiken-flow.ts derive   # show script addr + datum/redeemer JSON
 *   npx tsx scripts/demo-aiken-flow.ts lock     # submit lock tx (5 tADA)
 *   npx tsx scripts/demo-aiken-flow.ts spend    # submit spend tx
 *
 * Prereqs (in .env, sourced at boot):
 *   - CHAINFEED_WALLET_MNEMONIC   (preprod-funded dev wallet)
 *   - BLOCKFROST_API_KEY          (preprod key — swap from MAINNET)
 *   - NETWORK=preprod, BACKENDS=blockfrost
 *
 * The demo uses a fresh ephemeral CHAINFEED signing key each run unless
 * CHAINFEED_SIGNING_PRIVATE_KEY_HEX is set. For a stable on-chain artifact,
 * pin the key.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as bip39 from 'bip39';
import { randomBytes } from 'node:crypto';
import * as CSL from '@emurgo/cardano-serialization-lib-nodejs';
import {
  signQuote, publicKeyHexFromPrivate,
  type ChainfeedQuote,
} from '../srv/lib/aiken-quote-encoder';

const bridge = require('../srv/external/odatano-bridge');

const NETWORK_ID = 0;  // preprod
const PLUTUS_JSON_PATH = path.join(__dirname, '..', 'contracts', 'plutus.json');
const LOCK_LOVELACE = 5_000_000n;  // 5 tADA
const SPEND_RECIPIENT_LOVELACE = 4_500_000n;  // leave 0.5 tADA for fees

// Demo policy parameters
const LIQUIDATION_THRESHOLD_MILLI = 300_000n;  // $0.30
const QUOTE_PRICE_MILLI            = 500_000n; // $0.50 — above threshold → Withdraw path passes
const MAX_QUOTE_AGE_MS             = 5n * 60n * 1000n;
const QUOTE_TTL_MS                 = 10n * 60n * 1000n;

const harden = (n: number) => n | 0x80000000;

interface KeyPair {
  payment: CSL.Bip32PrivateKey;
  stake:   CSL.Bip32PrivateKey;
}

function deriveKeys(mnemonic: string): KeyPair {
  const entropy = bip39.mnemonicToEntropy(mnemonic);
  const root = CSL.Bip32PrivateKey.from_bip39_entropy(Buffer.from(entropy, 'hex'), Buffer.from(''));
  const account = root.derive(harden(1852)).derive(harden(1815)).derive(harden(0));
  return {
    payment: account.derive(0).derive(0),
    stake:   account.derive(2).derive(0),
  };
}

function buildAddress(networkId: number, payment: CSL.Bip32PrivateKey, stake: CSL.Bip32PrivateKey): CSL.Address {
  return CSL.BaseAddress.new(
    networkId,
    CSL.Credential.from_keyhash(payment.to_raw_key().to_public().hash()),
    CSL.Credential.from_keyhash(stake.to_raw_key().to_public().hash()),
  ).to_address();
}

function loadValidatorScript(): { cborHex: string; hashHex: string } {
  if (!fs.existsSync(PLUTUS_JSON_PATH)) {
    throw new Error(
      `plutus.json missing — run \`cd contracts && aiken build\` first.`,
    );
  }
  const plutus = JSON.parse(fs.readFileSync(PLUTUS_JSON_PATH, 'utf8'));
  const validator = plutus.validators?.find((v: { title: string }) => v.title === 'stop_loss.stop_loss.spend');
  if (!validator) throw new Error('stop_loss.spend validator not found in plutus.json');
  return { cborHex: validator.compiledCode, hashHex: validator.hash };
}

function deriveScriptAddress(scriptHashHex: string, networkId: number): string {
  const scriptHash = CSL.ScriptHash.from_bytes(Buffer.from(scriptHashHex, 'hex'));
  const enterprise = CSL.EnterpriseAddress.new(networkId, CSL.Credential.from_scripthash(scriptHash));
  return enterprise.to_address().to_bech32();
}

function chainfeedSigningKeyHex(): string {
  const fromEnv = process.env.CHAINFEED_SIGNING_PRIVATE_KEY_HEX;
  if (fromEnv && /^[0-9a-f]{64}$/i.test(fromEnv)) return fromEnv.toLowerCase();
  // Ephemeral: not stable across runs. Stable key: set the env var.
  const eph = randomBytes(32).toString('hex');
  console.log('NOTE: CHAINFEED_SIGNING_PRIVATE_KEY_HEX not set — using ephemeral key:');
  console.log(`      priv: ${eph}`);
  console.log(`      pub:  ${publicKeyHexFromPrivate(eph)}`);
  console.log('      (pin one in .env for stable demo artifacts)');
  return eph;
}

// ── PlutusData → cardano-cli DetailedSchema JSON helpers ──────────────────
//
// ODATANO's BuildSimpleAdaTransaction / BuildPlutusSpendTransaction expect
// PlutusData expressed as DetailedSchema JSON. Note: the "constructor" key
// (CSL convention) collides with JS Object.prototype.constructor in TS, so
// the helpers below build via Record<string, unknown> and we serialize
// directly. ODATANO normalises "constructor" → "constr" for Buildooor
// internally (srv/utils/plutus-placeholders.ts handles the rename).

type DJson = Record<string, unknown>;

function constr(idx: number, fields: DJson[]): DJson {
  return { constructor: idx, fields };
}
function bytes(hex: string): DJson { return { bytes: hex }; }
function intVal(n: bigint | number): DJson { return { int: n.toString() }; }

function quoteToDSchema(q: ChainfeedQuote): DJson {
  return constr(0, [
    bytes(Buffer.from(q.pair, 'utf8').toString('hex')),
    intVal(q.priceMilliUnits),
    intVal(q.validUntilMs),
    intVal(q.signedAtMs),
  ]);
}

function signedQuoteToDSchema(q: ChainfeedQuote, sigHex: string): DJson {
  return constr(0, [quoteToDSchema(q), bytes(sigHex)]);
}

function stopLossRedeemerDSchema(action: 'withdraw' | 'liquidate', q: ChainfeedQuote, sigHex: string): DJson {
  return constr(0, [
    constr(action === 'withdraw' ? 0 : 1, []),
    signedQuoteToDSchema(q, sigHex),
  ]);
}

function stopLossDatumDSchema(datum: {
  ownerPkhHex: string;
  liquidatorPkhHex: string;
  liquidationPriceMilliUnits: bigint;
  chainfeedPubkeyHex: string;
  maxQuoteAgeMs: bigint;
}): DJson {
  return constr(0, [
    bytes(datum.ownerPkhHex),
    bytes(datum.liquidatorPkhHex),
    intVal(datum.liquidationPriceMilliUnits),
    bytes(datum.chainfeedPubkeyHex),
    intVal(datum.maxQuoteAgeMs),
  ]);
}

// ── Phases ────────────────────────────────────────────────────────────────

async function deriveAndShow() {
  const mnemonic = process.env.CHAINFEED_WALLET_MNEMONIC;
  if (!mnemonic) throw new Error('CHAINFEED_WALLET_MNEMONIC missing — source .env');

  const { payment, stake } = deriveKeys(mnemonic);
  const ourAddr = buildAddress(NETWORK_ID, payment, stake).to_bech32();
  const ourPkhHex = Buffer.from(payment.to_raw_key().to_public().hash().to_bytes()).toString('hex');

  const { hashHex } = loadValidatorScript();
  const scriptAddr = deriveScriptAddress(hashHex, NETWORK_ID);

  const cfPriv = chainfeedSigningKeyHex();
  const cfPub  = publicKeyHexFromPrivate(cfPriv);

  console.log('\n── Wallet ───────────────────────────────────────────────');
  console.log('Address (preprod):', ourAddr);
  console.log('PaymentKeyHash:   ', ourPkhHex);

  console.log('\n── Aiken validator ──────────────────────────────────────');
  console.log('Script hash:    ', hashHex);
  console.log('Script address: ', scriptAddr);

  console.log('\n── Demo policy ──────────────────────────────────────────');
  console.log(`Liquidation threshold: $${Number(LIQUIDATION_THRESHOLD_MILLI) / 1_000_000}`);
  console.log(`Quote price (Withdraw path): $${Number(QUOTE_PRICE_MILLI) / 1_000_000}`);
  console.log(`Max quote age: ${MAX_QUOTE_AGE_MS}ms`);
  console.log(`Quote TTL:     ${QUOTE_TTL_MS}ms`);

  console.log('\n── Datum (DetailedSchema JSON) ──────────────────────────');
  const datum = stopLossDatumDSchema({
    ownerPkhHex: ourPkhHex,
    liquidatorPkhHex: ourPkhHex,
    liquidationPriceMilliUnits: LIQUIDATION_THRESHOLD_MILLI,
    chainfeedPubkeyHex: cfPub,
    maxQuoteAgeMs: MAX_QUOTE_AGE_MS,
  });
  console.log(JSON.stringify(datum, null, 2));

  console.log('\n── Redeemer (Withdraw, signed quote) ────────────────────');
  const now = BigInt(Date.now());
  const quote: ChainfeedQuote = {
    pair: 'ADA-USD',
    priceMilliUnits: QUOTE_PRICE_MILLI,
    validUntilMs:    now + QUOTE_TTL_MS,
    signedAtMs:      now,
  };
  const signed = signQuote(quote, cfPriv);
  const redeemer = stopLossRedeemerDSchema('withdraw', quote, signed.signatureHex);
  console.log(JSON.stringify(redeemer, null, 2));

  console.log('\n── Next ─────────────────────────────────────────────────');
  console.log('Run `npx tsx scripts/demo-aiken-flow.ts lock` to submit the lock tx.');
}

async function lock() {
  const mnemonic = process.env.CHAINFEED_WALLET_MNEMONIC;
  if (!mnemonic) throw new Error('CHAINFEED_WALLET_MNEMONIC missing');

  const { payment, stake } = deriveKeys(mnemonic);
  const ourAddr = buildAddress(NETWORK_ID, payment, stake).to_bech32();
  const ourPkhHex = Buffer.from(payment.to_raw_key().to_public().hash().to_bytes()).toString('hex');

  const { hashHex } = loadValidatorScript();
  const scriptAddr = deriveScriptAddress(hashHex, NETWORK_ID);

  const cfPriv = chainfeedSigningKeyHex();
  const cfPub  = publicKeyHexFromPrivate(cfPriv);

  console.log(`Locking ${Number(LOCK_LOVELACE) / 1e6} tADA into ${scriptAddr}`);
  console.log(`CHAINFEED pubkey pinned: ${cfPub}`);

  const datum = stopLossDatumDSchema({
    ownerPkhHex: ourPkhHex,
    liquidatorPkhHex: ourPkhHex,
    liquidationPriceMilliUnits: LIQUIDATION_THRESHOLD_MILLI,
    chainfeedPubkeyHex: cfPub,
    maxQuoteAgeMs: MAX_QUOTE_AGE_MS,
  });

  // Build via ODATANO Buildooor TxBuilder (high-level — handles UTxO fetch + coin selection)
  const { client, txBuilder } = await initOdatano();
  const protocolParams = await client.getProtocolParameters();
  await txBuilder.init(protocolParams);

  const built = await txBuilder.buildSimpleAdaTransaction(
    {
      senderAddress:    ourAddr,
      recipientAddress: scriptAddr,
      lovelaceAmount:   LOCK_LOVELACE.toString(),
      changeAddress:    ourAddr,
      outputDatum:      datum,
    },
    protocolParams,
  );

  console.log(`Built unsigned tx, ${built.unsignedTxCbor.length / 2} bytes`);

  const signedHex = signCborWithKey(built.unsignedTxCbor, payment);
  console.log(`Signed, submitting ...`);

  const submittedHash = await bridge.submitTransaction(signedHex);
  console.log(`\n✓ LOCK SUBMITTED: ${submittedHash}`);
  console.log(`   https://preprod.cardanoscan.io/transaction/${submittedHash}`);
  console.log(`\nWait ~30s for confirmation, then run:`);
  console.log(`   npm run demo:aiken spend ${submittedHash}`);
}

async function spend(lockTxHash: string) {
  const mnemonic = process.env.CHAINFEED_WALLET_MNEMONIC;
  if (!mnemonic) throw new Error('CHAINFEED_WALLET_MNEMONIC missing');

  const { payment, stake } = deriveKeys(mnemonic);
  const ourAddr = buildAddress(NETWORK_ID, payment, stake).to_bech32();
  const ourPkhHex = Buffer.from(payment.to_raw_key().to_public().hash().to_bytes()).toString('hex');

  const { cborHex: validatorScriptHex } = loadValidatorScript();

  const cfPriv = chainfeedSigningKeyHex();
  const now = BigInt(Date.now());
  const quote: ChainfeedQuote = {
    pair: 'ADA-USD',
    priceMilliUnits: QUOTE_PRICE_MILLI,
    validUntilMs:    now + QUOTE_TTL_MS,
    signedAtMs:      now,
  };
  const signed = signQuote(quote, cfPriv);
  const redeemer = stopLossRedeemerDSchema('withdraw', quote, signed.signatureHex);

  console.log(`Spending UTxO at ${lockTxHash}#0 with Withdraw redeemer (price=$${Number(QUOTE_PRICE_MILLI)/1e6})`);

  const { client, txBuilder } = await initOdatano();
  const protocolParams = await client.getProtocolParameters();
  await txBuilder.init(protocolParams);

  // Re-derive the datum so the script knows what's at the locked UTxO.
  // The validator can read it from the UTxO itself (inline datum), but
  // ODATANO's tx-builder needs it explicit for cost-model + min-ADA calc.
  const cfPub = publicKeyHexFromPrivate(cfPriv);
  const datum = stopLossDatumDSchema({
    ownerPkhHex: ourPkhHex,
    liquidatorPkhHex: ourPkhHex,
    liquidationPriceMilliUnits: LIQUIDATION_THRESHOLD_MILLI,
    chainfeedPubkeyHex: cfPub,
    maxQuoteAgeMs: MAX_QUOTE_AGE_MS,
  });

  // Tight validity range: upper bound must be within max_quote_age_ms of
  // the quote's signed_at_ms or Aiken's is_fresh() check fails. Build a
  // 2-min window centered on signing time.
  const nowNum = Number(now);
  const built = await txBuilder.buildPlutusSpendTransaction(
    {
      senderAddress:    ourAddr,
      recipientAddress: ourAddr,
      lovelaceAmount:   SPEND_RECIPIENT_LOVELACE.toString(),
      changeAddress:    ourAddr,
      validityStartMs:  (nowNum - 60_000).toString(),
      validityEndMs:    (nowNum + 120_000).toString(),
      plutusScriptExecution: {
        validatorScript: validatorScriptHex,
        scriptUtxo: { txHash: lockTxHash, outputIndex: 0 },
        redeemer,
        // Omit datum — script UTxO has inline datum, ODATANO reads it from chain
      },
      requiredSigners: [ourPkhHex],
    },
    protocolParams,
  );

  console.log(`Built unsigned tx, ${built.unsignedTxCbor.length / 2} bytes`);

  const signedHex = signCborWithKey(built.unsignedTxCbor, payment);
  console.log(`Signed, submitting ...`);

  const submittedHash = await bridge.submitTransaction(signedHex);
  console.log(`\n✓ SPEND SUBMITTED: ${submittedHash}`);
  console.log(`   https://preprod.cardanoscan.io/transaction/${submittedHash}`);
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Initialize ODATANO core enough to use its CardanoClient + TxBuilder
 * without booting CAP. We don't need any CDS services for the demo —
 * the bridge plus tx-builder primitives are sufficient.
 */
async function initOdatano(): Promise<{
  client: any;
  txBuilder: any;
}> {
  const core = require('@odatano/core');
  await core.initialize();
  return {
    client:    core.getCardanoClient(),
    txBuilder: core.getCardanoTxBuilder(),
  };
}

function signCborWithKey(unsignedCborHex: string, payment: CSL.Bip32PrivateKey): string {
  // Parse the unsigned tx, attach a vkey witness over the body hash, re-serialise.
  const fixedTx = CSL.FixedTransaction.from_bytes(Buffer.from(unsignedCborHex, 'hex'));
  const txHash = fixedTx.transaction_hash();
  const vkeyWit = CSL.make_vkey_witness(txHash, payment.to_raw_key());
  fixedTx.add_vkey_witness(vkeyWit);
  return Buffer.from(fixedTx.to_bytes()).toString('hex');
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const phase = process.argv[2] ?? 'derive';
  try {
    if (phase === 'derive') {
      await deriveAndShow();
    } else if (phase === 'lock') {
      await lock();
    } else if (phase === 'spend') {
      const txHash = process.argv[3];
      if (!txHash || !/^[0-9a-f]{64}$/i.test(txHash)) {
        throw new Error('Usage: spend <lock-tx-hash>');
      }
      await spend(txHash);
    } else {
      console.error(`Unknown phase '${phase}'. Use: derive | lock | spend <txHash>`);
      process.exit(1);
    }
  } finally {
    try { await bridge.shutdown(); } catch { /* ignore */ }
  }
}

main().catch(err => {
  console.error('FAIL:', (err as Error)?.stack ?? err);
  process.exit(1);
});
