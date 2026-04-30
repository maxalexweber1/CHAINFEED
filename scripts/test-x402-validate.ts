/**
 * Quick unit smoke for validate.ts. Pure, no chain, no DB.
 * Run: npx tsx scripts/test-x402-validate.ts
 */

import assert from 'node:assert/strict';
import { validatePayment } from '../srv/x402/validate';
import type { PaymentRequirementEntry } from '../srv/x402/requirements';
import type { DecodedPayment } from '../srv/x402/decode';
import { Codes } from '../srv/x402/errors';

const PAY_TO  = 'addr_test1qpw6y2yq73qhxycl73snjgf9anc879tqvqg4rvssjms3y6kwnd9ygjx5ds9sc69u2sk7z6g72fupwvtnxx4j5vwr0t7skzugf0';
const POLICY  = 'a62434701e2b8904096511fe2879efc920d18559ea1ae7a9dd52bd72';
const NAME    = '0014df105553444d';
const UNIT    = (POLICY + NAME).toLowerCase();
const NETWORK = 'cardano-preprod';

function reqs(over: Partial<PaymentRequirementEntry> = {}): PaymentRequirementEntry {
  return {
    scheme:            'exact',
    network:           NETWORK,
    maxAmountRequired: '100000',  // 0.1 mock-USDM
    asset:             POLICY,
    payTo:             PAY_TO,
    resource:          '/odata/v4/price/Prices',
    description:       'test',
    mimeType:          'application/json',
    outputSchema:      null,
    maxTimeoutSeconds: 600,
    extra:             { assetNameHex: NAME, decimals: 6 },
    ...over,
  };
}

function decoded(over: Partial<DecodedPayment> = {}): DecodedPayment {
  return {
    x402Version: 1,
    scheme:  'exact',
    network: NETWORK,
    txHash:  'aa'.repeat(32),
    txCborHex: 'deadbeef',
    inputs: [{ txHash: 'bb'.repeat(32), outputIndex: 0 }],
    vkeyWitnessCount: 1,
    outputs: [
      {
        outputIndex: 0,
        address: PAY_TO,
        lovelace: '1500000',
        assets: [{ unit: UNIT, policyId: POLICY, assetNameHex: NAME, quantity: '100000' }],
      },
    ],
    ...over,
  };
}

let n = 0, fails = 0;
function t(name: string, fn: () => void) {
  n++;
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) { fails++; console.log(`FAIL  ${name}\n      ${(e as Error).message}`); }
}

console.log('validatePayment ─────────────────────────────────────');

t('valid payment passes', () => {
  const r = validatePayment(decoded(), reqs());
  assert.equal(r.ok, true);
  assert.equal(r.claim.txHash, 'aa'.repeat(32));
  assert.equal(r.claim.amountUnits, '100000');
  assert.equal(r.claim.network, NETWORK);
  assert.equal(r.claim.asset, UNIT);
  assert.equal(r.claim.route, '/odata/v4/price/Prices');
});

t('overpayment passes (paid > required)', () => {
  const d = decoded({
    outputs: [{
      outputIndex: 0, address: PAY_TO, lovelace: '1500000',
      assets: [{ unit: UNIT, policyId: POLICY, assetNameHex: NAME, quantity: '500000' }],
    }],
  });
  const r = validatePayment(d, reqs());
  assert.equal(r.ok, true);
  assert.equal(r.claim.amountUnits, '500000');
});

t('payment summed across multiple outputs to payTo', () => {
  const d = decoded({
    outputs: [
      { outputIndex: 0, address: PAY_TO, lovelace: '1200000',
        assets: [{ unit: UNIT, policyId: POLICY, assetNameHex: NAME, quantity: '60000' }] },
      { outputIndex: 1, address: PAY_TO, lovelace: '1200000',
        assets: [{ unit: UNIT, policyId: POLICY, assetNameHex: NAME, quantity: '40000' }] },
    ],
  });
  const r = validatePayment(d, reqs());
  assert.equal(r.ok, true);
  assert.equal(r.claim.amountUnits, '100000');
});

t('network mismatch rejects', () => {
  const r = validatePayment(decoded({ network: 'cardano-mainnet' }), reqs());
  assert.equal(r.ok, false);
  assert.equal(r.code, Codes.NETWORK_MISMATCH);
});

t('unsigned tx rejects', () => {
  const r = validatePayment(decoded({ vkeyWitnessCount: 0 }), reqs());
  assert.equal(r.ok, false);
  assert.equal(r.code, Codes.UNSIGNED_TRANSACTION);
});

t('no output to payTo rejects', () => {
  const stranger = 'addr_test1qzzzzz' + 'a'.repeat(98);
  const r = validatePayment(decoded({
    outputs: [{ outputIndex: 0, address: stranger, lovelace: '1500000',
      assets: [{ unit: UNIT, policyId: POLICY, assetNameHex: NAME, quantity: '999999999' }] }],
  }), reqs());
  assert.equal(r.ok, false);
  assert.equal(r.code, Codes.WRONG_RECIPIENT);
});

t('output to payTo without the asset rejects', () => {
  const r = validatePayment(decoded({
    outputs: [{ outputIndex: 0, address: PAY_TO, lovelace: '5000000', assets: [] }],
  }), reqs());
  assert.equal(r.ok, false);
  assert.equal(r.code, Codes.WRONG_ASSET);
});

t('output with wrong policy rejects', () => {
  const fakeUnit = 'cc'.repeat(28) + NAME;
  const r = validatePayment(decoded({
    outputs: [{ outputIndex: 0, address: PAY_TO, lovelace: '1500000',
      assets: [{ unit: fakeUnit, policyId: 'cc'.repeat(28), assetNameHex: NAME, quantity: '100000' }] }],
  }), reqs());
  assert.equal(r.ok, false);
  assert.equal(r.code, Codes.WRONG_ASSET);
});

t('insufficient amount rejects', () => {
  const r = validatePayment(decoded({
    outputs: [{ outputIndex: 0, address: PAY_TO, lovelace: '1500000',
      assets: [{ unit: UNIT, policyId: POLICY, assetNameHex: NAME, quantity: '50000' }] }],
  }), reqs());
  assert.equal(r.ok, false);
  assert.equal(r.code, Codes.INSUFFICIENT_AMOUNT);
});

t('ada-only payment with asset==lovelace works', () => {
  const r = validatePayment(decoded({
    outputs: [{ outputIndex: 0, address: PAY_TO, lovelace: '5000000', assets: [] }],
  }), reqs({ asset: 'lovelace', maxAmountRequired: '1000000', extra: undefined }));
  assert.equal(r.ok, true);
  assert.equal(r.claim.amountUnits, '5000000');
});

console.log(`\n${n - fails}/${n} passed`);
process.exit(fails ? 1 : 0);
