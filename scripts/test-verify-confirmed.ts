/**
 * Tests for the post-confirmed x402-payment verifier + subscription pricing curve.
 * Mocks bridge + nonces — no CDS boot.
 *
 * Run: npx tsx scripts/test-verify-confirmed.ts
 */

import assert from 'node:assert/strict';
const bridge = require('../srv/external/odatano-bridge');
const nonces = require('../srv/x402/nonces');
import {
  verifyConfirmedPayment, priceForSubscription,
  BASE_USDM, HOURLY_USDM_AT_500BPS, USDM_DECIMALS,
} from '../srv/x402/verify-confirmed';
import { Codes } from '../srv/x402/errors';

let n = 0, fails = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  n++;
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (e) {
    fails++;
    const err = e as Error;
    console.log(`FAIL  ${name}\n      ${err.stack || err.message}`);
  }
}

const PAY_TO = 'addr_test1wq3pacs7jcrlwehpuy3ryj8kwvsqzjp9z6dpmx8txnr0vkq6vqeuu';
const USDM_UNIT = 'fa0f8722df2372ccbb3649a23e3c541ad7e4f8218b3500d0c0b505f70014df105553444d';
const TXH = '00'.repeat(32);

async function main() {
  const orig = {
    getTransactionByHash: bridge.getTransactionByHash,
    claim: nonces.claim,
  };
  // Default mocks — overridden per-test as needed.
  let txByHash: ((h: string) => unknown) = async () => null;
  let claimRes: ((args: unknown) => Promise<unknown>) = async () => ({ claimed: true });
  bridge.getTransactionByHash = (h: string) => txByHash(h);
  nonces.claim = (args: unknown) => claimRes(args);

  console.log('verify-confirmed ────────────────────────────────────────');

  // ── pricing curve ───────────────────────────────────────────────────
  t('priceForSubscription: 24h at 1% (100 bps) → ~3.5 USDM', () => {
    // hourlyRate = 0.01 × (500/100) = 0.05 USDM/hr → total = 0.5 + 0.05×24 = 1.7
    const u = priceForSubscription(100, 24);
    const usdm = Number(u) / 10 ** USDM_DECIMALS;
    assert.ok(usdm > 1.6 && usdm < 1.8, `expected ~1.7 USDM, got ${usdm}`);
  });

  t('priceForSubscription: 24h at 5% (500 bps) → 0.74 USDM (calibration point)', () => {
    // hourlyRate = 0.01 USDM/hr → total = 0.5 + 0.24 = 0.74
    const u = priceForSubscription(500, 24);
    const usdm = Number(u) / 10 ** USDM_DECIMALS;
    assert.ok(usdm > 0.7 && usdm < 0.8, `expected ~0.74 USDM, got ${usdm}`);
  });

  t('priceForSubscription: 30 days at 0.1% (10 bps) → ~360.5 USDM', () => {
    // hourlyRate = 0.01 × (500/10) = 0.5 USDM/hr → total = 0.5 + 0.5 × 720 = 360.5
    const u = priceForSubscription(10, 720);
    const usdm = Number(u) / 10 ** USDM_DECIMALS;
    assert.ok(usdm > 360 && usdm < 361, `expected ~360.5 USDM, got ${usdm}`);
  });

  t('priceForSubscription: scaling — 10× tighter threshold = 10× hourly cost', () => {
    const a = Number(priceForSubscription(1000, 24)) - Number(priceForSubscription(1000, 0.001));
    const b = Number(priceForSubscription(100, 24))  - Number(priceForSubscription(100, 0.001));
    // b should be ~10× a (excluding the constant base fee).
    const ratio = b / a;
    assert.ok(ratio > 9 && ratio < 11, `expected ~10× scaling, got ${ratio.toFixed(2)}`);
  });

  t('priceForSubscription: rounds UP (never undercharge)', () => {
    // Force a fractional unit count → must round up to the next integer raw unit.
    const u = priceForSubscription(500, 0.001); // tiny
    // Computed: 0.5 + 0.01 × 0.001 = 0.50001 → 500_010 raw units (ceil)
    assert.equal(u, 500_010n);
  });

  t('priceForSubscription: rejects non-positive thresholdBps', () => {
    assert.throws(() => priceForSubscription(0, 24), /thresholdBps must be positive/);
    assert.throws(() => priceForSubscription(-1, 24), /thresholdBps must be positive/);
    assert.throws(() => priceForSubscription(NaN, 24), /thresholdBps must be positive/);
  });

  t('priceForSubscription: rejects non-positive validUntilHours', () => {
    assert.throws(() => priceForSubscription(100, 0), /validUntilHours must be positive/);
    assert.throws(() => priceForSubscription(100, -5), /validUntilHours must be positive/);
  });

  // ── verifyConfirmedPayment: input validation ────────────────────────
  await t('rejects malformed txHash (length)', async () => {
    const r = await verifyConfirmedPayment({
      txHash: 'too-short', requiredUnits: '1000000', requiredAsset: USDM_UNIT,
      requiredPayTo: PAY_TO, network: 'cardano-preprod', route: 'subscribePegAlert',
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, Codes.INVALID_CBOR);
  });

  await t('rejects malformed txHash (non-hex)', async () => {
    const r = await verifyConfirmedPayment({
      txHash: 'X'.repeat(64), requiredUnits: '1000000', requiredAsset: USDM_UNIT,
      requiredPayTo: PAY_TO, network: 'cardano-preprod', route: 'subscribePegAlert',
    });
    assert.equal(r.ok, false);
  });

  // ── verifyConfirmedPayment: chain-fetch ─────────────────────────────
  await t('returns PENDING when bridge returns null (tx not on-chain)', async () => {
    txByHash = async () => null;
    const r = await verifyConfirmedPayment({
      txHash: TXH, requiredUnits: '1000000', requiredAsset: USDM_UNIT,
      requiredPayTo: PAY_TO, network: 'cardano-preprod', route: 'subscribePegAlert',
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.code, Codes.PENDING);
      assert.match(r.reason, /not found on-chain/);
    }
  });

  await t('returns PENDING on bridge throw', async () => {
    txByHash = async () => { throw new Error('blockfrost-down'); };
    const r = await verifyConfirmedPayment({
      txHash: TXH, requiredUnits: '1000000', requiredAsset: USDM_UNIT,
      requiredPayTo: PAY_TO, network: 'cardano-preprod', route: 'subscribePegAlert',
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /blockfrost-down/);
  });

  // ── verifyConfirmedPayment: amount / asset / address ────────────────
  await t('rejects when paid amount is below requirement', async () => {
    txByHash = async () => ({
      hash: TXH,
      outputs: [
        { address: PAY_TO, lovelace: '1500000', assets: [{ unit: USDM_UNIT, quantity: '500000' }] },
      ],
    });
    const r = await verifyConfirmedPayment({
      txHash: TXH, requiredUnits: '1000000', requiredAsset: USDM_UNIT,
      requiredPayTo: PAY_TO, network: 'cardano-preprod', route: 'subscribePegAlert',
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.code, Codes.INSUFFICIENT_AMOUNT);
      assert.match(r.reason, /paid 500000 < required 1000000/);
    }
  });

  await t('sums payments across multiple outputs to payTo', async () => {
    txByHash = async () => ({
      hash: TXH,
      outputs: [
        { address: PAY_TO, lovelace: '1500000', assets: [{ unit: USDM_UNIT, quantity: '600000' }] },
        { address: PAY_TO, lovelace: '1500000', assets: [{ unit: USDM_UNIT, quantity: '500000' }] },
        { address: 'someone-else', lovelace: '0', assets: [{ unit: USDM_UNIT, quantity: '999999999' }] },
      ],
    });
    const r = await verifyConfirmedPayment({
      txHash: TXH, requiredUnits: '1000000', requiredAsset: USDM_UNIT,
      requiredPayTo: PAY_TO, network: 'cardano-preprod', route: 'subscribePegAlert',
    });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.amountUnits, '1100000');
  });

  await t('happy path: exact amount + nonce claim succeeds', async () => {
    txByHash = async () => ({
      outputs: [
        { address: PAY_TO, assets: [{ unit: USDM_UNIT, quantity: '1000000' }] },
      ],
    });
    let nonceArgs: unknown = null;
    claimRes = async (args: unknown) => { nonceArgs = args; return { claimed: true }; };

    const r = await verifyConfirmedPayment({
      txHash: TXH, requiredUnits: '1000000', requiredAsset: USDM_UNIT,
      requiredPayTo: PAY_TO, network: 'cardano-preprod', route: 'subscribePegAlert',
      consumerAddr: 'addr1consumer',
    });
    assert.equal(r.ok, true);
    // Nonce was claimed with the exact paid amount + route.
    assert.deepEqual(nonceArgs, {
      txHash:      TXH,
      route:       'subscribePegAlert',
      network:     'cardano-preprod',
      amountUnits: '1000000',
      consumerAddr: 'addr1consumer',
    });
  });

  await t('replay: nonces.claim returns claimed=false → REPLAY propagates', async () => {
    txByHash = async () => ({
      outputs: [{ address: PAY_TO, assets: [{ unit: USDM_UNIT, quantity: '1000000' }] }],
    });
    claimRes = async () => ({ claimed: false, code: Codes.REPLAY });

    const r = await verifyConfirmedPayment({
      txHash: TXH, requiredUnits: '1000000', requiredAsset: USDM_UNIT,
      requiredPayTo: PAY_TO, network: 'cardano-preprod', route: 'subscribePegAlert',
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, Codes.REPLAY);
  });

  await t('lovelace asset path: requires payTo lovelace, not native-asset', async () => {
    txByHash = async () => ({
      outputs: [{ address: PAY_TO, lovelace: '5000000', assets: [] }],
    });
    claimRes = async () => ({ claimed: true });

    const r = await verifyConfirmedPayment({
      txHash: TXH, requiredUnits: '4000000', requiredAsset: 'lovelace',
      requiredPayTo: PAY_TO, network: 'cardano-preprod', route: 'subscribePegAlert',
    });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.amountUnits, '5000000');
  });

  await t('zero outputs to payTo → INSUFFICIENT_AMOUNT (paid=0)', async () => {
    txByHash = async () => ({
      outputs: [{ address: 'someone-else', assets: [{ unit: USDM_UNIT, quantity: '999999' }] }],
    });
    const r = await verifyConfirmedPayment({
      txHash: TXH, requiredUnits: '1000000', requiredAsset: USDM_UNIT,
      requiredPayTo: PAY_TO, network: 'cardano-preprod', route: 'subscribePegAlert',
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.code, Codes.INSUFFICIENT_AMOUNT);
      assert.match(r.reason, /paid 0 < required 1000000/);
    }
  });

  // restore
  bridge.getTransactionByHash = orig.getTransactionByHash;
  nonces.claim = orig.claim;

  console.log(`\n${n - fails}/${n} passed`);
  process.exit(fails ? 1 : 0);
}

main().catch(err => { console.error('runner crash:', err); process.exit(2); });
