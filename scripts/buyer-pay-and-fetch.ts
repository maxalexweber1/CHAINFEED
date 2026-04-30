/**
 * Manual end-to-end x402 round-trip on preprod.
 *
 * Plays the BUYER role using the same dev wallet that operates the
 * CHAINFEED receiver. Buyer == seller is fine for proving wire-compat —
 * the middleware only inspects what's on-chain.
 *
 * Flow:
 *   1. GET the gated resource → expect 402 with payment requirements
 *   2. Build + sign a Cardano tx paying `maxAmountRequired` mock-USDM to payTo
 *   3. Wrap as X-PAYMENT, retry GET
 *   4. Expect 200 with X-PAYMENT-RESPONSE header
 *
 * Each run costs ~0.2 ADA in fees plus the price (10000 raw mock-USDM).
 *
 * Prereqs: server running, .env.local sourced.
 *
 * Run:
 *   set -a && source .env.local && set +a && node scripts/buyer-pay-and-fetch.js [host] [path] [method] [json-body]
 *
 * Examples:
 *   # GET an entity (Phase 1 default)
 *   node scripts/buyer-pay-and-fetch.js
 *
 *   # POST an OData action
 *   node scripts/buyer-pay-and-fetch.js http://127.0.0.1:4004 /odata/v4/price/getBestPrice POST '{"pair":"ADA-USDM"}'
 */

import * as http from 'node:http';
import * as bip39 from 'bip39';
import * as CSL from '@emurgo/cardano-serialization-lib-nodejs';

const bridge = require('../srv/external/odatano-bridge');

const HOST   = process.argv[2] ?? 'http://127.0.0.1:4004';
const PATH   = process.argv[3] ?? '/odata/v4/price/Prices';
const METHOD = (process.argv[4] ?? 'GET').toUpperCase();
const BODY   = process.argv[5] ?? null;

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

function buildAddress(payment: CSL.Bip32PrivateKey, stake: CSL.Bip32PrivateKey, networkId = 0): CSL.Address {
  return CSL.BaseAddress.new(
    networkId,
    CSL.Credential.from_keyhash(payment.to_public().to_raw_key().hash()),
    CSL.Credential.from_keyhash(stake.to_public().to_raw_key().hash()),
  ).to_address();
}

interface FetchOpts {
  method?: string;
  body?: string | Buffer | null;
  headers?: Record<string, string | number>;
}

interface FetchResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function fetchOnce(url: string, opts: FetchOpts = {}): Promise<FetchResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers: Record<string, string | number> = { ...(opts.headers ?? {}) };
    let bodyBuf: Buffer | null = null;
    if (opts.body) {
      bodyBuf = Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body, 'utf8');
      headers['Content-Length'] = bodyBuf.length;
      if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
    }
    const req = http.request({
      hostname: u.hostname,
      port:     u.port,
      path:     u.pathname + u.search,
      method:   opts.method ?? 'GET',
      headers,
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({
        status:  res.statusCode ?? 0,
        headers: res.headers,
        body:    Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

interface Requirements {
  asset: string;
  payTo: string;
  network: string;
  maxAmountRequired: string;
  extra: { assetNameHex: string };
}

interface BuildPaymentArgs {
  requirements: Requirements;
  payment: CSL.Bip32PrivateKey;
  stake: CSL.Bip32PrivateKey;
}

interface UtxoLite {
  txHash: string;
  outputIndex: number;
  lovelace: string;
  assets: Array<{ unit: string; policyId: string; assetNameHex: string; quantity: string }>;
}

async function buildPaymentTx({ requirements, payment, stake }: BuildPaymentArgs) {
  const buyerAddress = buildAddress(payment, stake, 0);
  const buyerVkeyHash = payment.to_public().to_raw_key().hash();

  // Coin-select inputs: prefer the largest-ADA UTxO that also holds enough
  // of the required token. If that one carries < 3 ADA, also attach the
  // second-largest ADA-bearing UTxO at the address (token-bearing or not).
  const utxos: UtxoLite[] = await bridge.getUtxosAtAddress(buyerAddress.to_bech32());
  const usdmUnit = (requirements.asset + requirements.extra.assetNameHex).toLowerCase();
  const required = BigInt(requirements.maxAmountRequired);

  const candidates = utxos
    .filter(u => u.assets.some(a => a.unit === usdmUnit && BigInt(a.quantity) >= required))
    .sort((a, b) => (BigInt(b.lovelace) - BigInt(a.lovelace) > 0n ? 1 : -1));

  if (candidates.length === 0) {
    throw new Error(`no UTxO at ${buyerAddress.to_bech32()} with ≥ ${required} of ${usdmUnit}`);
  }

  const tokenInput = candidates[0]!;
  const inputs: UtxoLite[] = [tokenInput];
  if (BigInt(tokenInput.lovelace) < 3_000_000n) {
    // Pad with the next biggest UTxO at the address, regardless of asset content.
    const padding = utxos
      .filter(u => u !== tokenInput)
      .sort((a, b) => (BigInt(b.lovelace) - BigInt(a.lovelace) > 0n ? 1 : -1))[0];
    if (!padding) throw new Error('no second UTxO available to fund fees');
    inputs.push(padding);
  }

  // Fetch protocol params for tx-builder config
  interface ProtoParams {
    minFeeA: number | string; minFeeB: number | string;
    poolDeposit: number | string; keyDeposit: number | string;
    maxValSize: number | string; maxTxSize: number | string;
    coinsPerUtxoSize: number | string;
  }
  const params: ProtoParams = await bridge.getProtocolParameters();
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

  // Add each selected input WITH its full multi-asset payload so balance closes.
  // CSL's MultiAsset.get returns a copy, not a reference — group by policy first
  // so we only call insert once per policy.
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

  // Output to payTo: token + min-ADA
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

  // Change to buyer (residual ADA + residual tokens)
  builder.add_change_if_needed(buyerAddress);

  const txBody = builder.build();
  const txHash = CSL.FixedTransaction.new_from_body_bytes(txBody.to_bytes()).transaction_hash();

  const wits = CSL.TransactionWitnessSet.new();
  const vk   = CSL.Vkeywitnesses.new();
  vk.add(CSL.make_vkey_witness(txHash, payment.to_raw_key()));
  wits.set_vkeys(vk);

  const signed = CSL.Transaction.new(txBody, wits);
  return {
    txCborBase64: Buffer.from(signed.to_bytes()).toString('base64'),
    txHash: Buffer.from(txHash.to_bytes()).toString('hex'),
  };
}

async function main() {
  const mnemonic = process.env.CHAINFEED_WALLET_MNEMONIC;
  if (!mnemonic) throw new Error('CHAINFEED_WALLET_MNEMONIC missing — source .env.local');

  const { payment, stake } = deriveKeys(mnemonic);
  const url = HOST + PATH;

  // 1. Unpaid request
  console.log(`[1/4] ${METHOD} ${url}  (no X-PAYMENT)`);
  const r1 = await fetchOnce(url, { method: METHOD, body: BODY });
  if (r1.status !== 402) {
    console.error(`expected 402, got ${r1.status}\nbody: ${r1.body.slice(0, 300)}`);
    process.exit(1);
  }
  const body = JSON.parse(r1.body);
  const requirements = body.accepts[0];
  console.log(`      → 402, requirements:`);
  console.log(`        asset:   ${requirements.asset}`);
  console.log(`        amount:  ${requirements.maxAmountRequired} (= ${Number(requirements.maxAmountRequired) / 1e6} USDM)`);
  console.log(`        payTo:   ${requirements.payTo}`);
  console.log(`        network: ${requirements.network}`);

  // 2. Build + sign payment
  console.log(`[2/4] building + signing payment tx via ODATANO bridge ...`);
  const { txCborBase64, txHash } = await buildPaymentTx({ requirements, payment, stake });
  console.log(`      → tx hash: ${txHash}`);

  // 3. Retry with X-PAYMENT
  const xPayment = Buffer.from(JSON.stringify({
    x402Version: 1,
    scheme: 'exact',
    network: requirements.network,
    payload: { transaction: txCborBase64 },
  }), 'utf8').toString('base64');

  console.log(`[3/4] ${METHOD} ${url}  (with X-PAYMENT, ${xPayment.length}B)`);
  const r2 = await fetchOnce(url, {
    method: METHOD, body: BODY, headers: { 'X-PAYMENT': xPayment },
  });

  // 4. Assert
  console.log(`[4/4] assert response`);
  console.log(`      status: ${r2.status}`);
  console.log(`      X-PAYMENT-RESPONSE: ${r2.headers['x-payment-response'] ?? '(none)'}`);
  if (r2.status === 402) {
    console.error(`      body: ${r2.body.slice(0, 400)}`);
    process.exit(1);
  }
  if (r2.status !== 200) {
    console.error(`      unexpected status; body: ${r2.body.slice(0, 400)}`);
    process.exit(1);
  }
  if (!r2.headers['x-payment-response']) {
    console.error(`      missing X-PAYMENT-RESPONSE header`);
    process.exit(1);
  }

  const decoded = JSON.parse(Buffer.from(r2.headers['x-payment-response'] as string, 'base64').toString('utf8'));
  console.log(`      X-PAYMENT-RESPONSE decoded: ${JSON.stringify(decoded)}`);
  console.log(`      response body: ${r2.body.slice(0, 200)}`);

  console.log('\nSUCCESS — preprod e2e payment round-trip works.');
  console.log(`Cardanoscan: https://preprod.cardanoscan.io/transaction/${txHash}`);

  await bridge.shutdown();
}

main().catch(async err => {
  console.error('FAIL:', err?.stack ?? err);
  try { await bridge.shutdown(); } catch {}
  process.exit(1);
});
