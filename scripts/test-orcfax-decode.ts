/**
 * Unit smoke for the Orcfax v1 datum decoder. Pure CBOR — no chain.
 * Source CBOR: `docs/research/orcfax-feeds.md` §7 (CBLP-ADA sample from
 * Orcfax's own consume.md).
 *
 * Run: npx tsx scripts/test-orcfax-decode.ts
 */

import assert from 'node:assert/strict';
const { _decodeStatementDatum: decode, _rationalToNumber: rationalToNumber, supportsPair }
  = require('../srv/adapters/orcfax');

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

console.log('orcfax v1 datum decoder ─────────────────────────────────');

const SAMPLE_CBLP_ADA = 'd8799fd8799f4e4345522f43424c502d4144412f331b0000019bf6f0a165d8799f19d41d1a4a817c80ffffd8799f581c3c12f6735ef87655c5b27bced3f828d857d0a27fd20f2cda18ebf2fbffff';

t('decodes CBLP-ADA sample to {feed_id, created_at, num, denom}', () => {
  const r = decode(SAMPLE_CBLP_ADA);
  assert.equal(r.feedId,    'CER/CBLP-ADA/3');
  assert.equal(r.feedIdHex, '4345522f43424c502d4144412f33');
  assert.equal(r.createdAt, 1769374523749);
  assert.equal(r.num,       '54301');
  assert.equal(r.denom,     '1250000000');
});

t('rationalToNumber handles the CBLP price correctly', () => {
  // 54301 / 1_250_000_000 ≈ 4.34408e-5
  const price = rationalToNumber('54301', '1250000000');
  assert.ok(Math.abs(price - 4.34408e-5) < 1e-9, `got ${price}`);
});

t('rationalToNumber preserves precision on a typical USD-like price', () => {
  // ADA-USD ≈ 0.4813 (the v0 sample). Express as 4813/10000.
  const price = rationalToNumber('4813', '10000');
  assert.equal(price, 0.4813);
});

t('rationalToNumber throws on zero denom', () => {
  assert.throws(() => rationalToNumber('1', '0'), /denom is zero/);
});

t('decode rejects non-Constr CBOR', () => {
  // Plain integer 42 in Plutus CBOR
  const intHex = '182a';   // CBOR uint(42)
  assert.throws(() => decode(intHex));
});

t('decode rejects Constr 0 with too few fields', () => {
  // Constr 0 with empty list — d87980 is `Constr 0 []`
  assert.throws(() => decode('d87980'));
});

t('supportsPair recognises configured pairs', () => {
  // Post-pivot scope: only stable-denominated ADA pairs.
  assert.equal(supportsPair('ADA-USD'),  true);
  assert.equal(supportsPair('ADA-USDM'), true);
  assert.equal(supportsPair('ADA-DJED'), true);
  assert.equal(supportsPair('ADA-iUSD'), true);
  // Removed in pivot — should not be recognised any more.
  assert.equal(supportsPair('FACT-ADA'),  false);
  assert.equal(supportsPair('SNEK-ADA'),  false);
  assert.equal(supportsPair('FOO-BAR'),   false);
});

console.log(`\n${n - fails}/${n} passed`);
process.exit(fails ? 1 : 0);
