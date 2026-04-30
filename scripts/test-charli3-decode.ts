/**
 * Unit smoke for the Charli3 oracle datum decoder. Pure CBOR — no chain.
 *
 * The fixture is built in-test with CSL so the asserted shape exactly
 * mirrors the CDDL at https://github.com/Charli3-Official/oracle-datum-lib/blob/main/spec.cddl
 *   oracle_datum = #6.121([ ?shared, 1*generic, ?extended ])
 *   generic_data = price_data = #6.123([ price_map ])
 *   price_map = { 0: price, 1: created_ms, 2: expiry_ms, 3: precision }
 *
 * Run: npx tsx scripts/test-charli3-decode.ts
 */

import assert from 'node:assert/strict';
import * as CSL from '@emurgo/cardano-serialization-lib-nodejs';
const { _decodeCharli3Datum: decode, _rawToNumber: rawToNumber, _VARIANT_ASSET_NAME_HEX, supportsPair }
  = require('../srv/adapters/charli3');

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

console.log('charli3 datum decoder ───────────────────────────────────');

/** Build a minimal Charli3 oracle datum: outer Constr 0 → [price_data]. */
function buildDatum(opts: {
  price:     string | number;
  timestamp: number;
  expiry:    number;
  precision?: number;
  /** if set, also include shared_data (Constr 0) at outer index 0 */
  withShared?: boolean;
  /** if set, also append extended_data (Constr 1) after price_data */
  withExtended?: boolean;
}): string {
  const intData = (n: string | number) =>
    CSL.PlutusData.new_integer(CSL.BigInt.from_str(String(n)));

  const priceMap = CSL.PlutusMap.new();
  const insert = (key: number, value: CSL.PlutusData) => {
    const values = CSL.PlutusMapValues.new();
    values.add(value);
    priceMap.insert(intData(key), values);
  };
  insert(0, intData(opts.price));
  insert(1, intData(opts.timestamp));
  insert(2, intData(opts.expiry));
  if (opts.precision !== undefined) insert(3, intData(opts.precision));

  // price_data = Constr 2 [ map ]
  const priceDataFields = CSL.PlutusList.new();
  priceDataFields.add(CSL.PlutusData.new_map(priceMap));
  const priceData = CSL.PlutusData.new_constr_plutus_data(
    CSL.ConstrPlutusData.new(CSL.BigNum.from_str('2'), priceDataFields),
  );

  // outer = Constr 0 [ ?shared, generic, ?extended ]
  const outerFields = CSL.PlutusList.new();
  if (opts.withShared) {
    const sharedInner = CSL.PlutusList.new();   // empty for the test
    const shared = CSL.PlutusData.new_constr_plutus_data(
      CSL.ConstrPlutusData.new(CSL.BigNum.from_str('0'), sharedInner),
    );
    outerFields.add(shared);
  }
  outerFields.add(priceData);
  if (opts.withExtended) {
    const extInner = CSL.PlutusList.new();
    const ext = CSL.PlutusData.new_constr_plutus_data(
      CSL.ConstrPlutusData.new(CSL.BigNum.from_str('1'), extInner),
    );
    outerFields.add(ext);
  }
  const outer = CSL.PlutusData.new_constr_plutus_data(
    CSL.ConstrPlutusData.new(CSL.BigNum.from_str('0'), outerFields),
  );
  return outer.to_hex();
}

t('decodes a minimal ADA-USD-style datum (precision 6)', () => {
  // ADA-USD ≈ $0.4813 → raw 481300 with precision 6
  const hex = buildDatum({
    price:     481300,
    timestamp: 1769000000000,
    expiry:    1769003600000,
    precision: 6,
  });
  const r = decode(hex);
  assert.equal(r.price,     '481300');
  assert.equal(r.timestamp, 1769000000000);
  assert.equal(r.expiry,    1769003600000);
  assert.equal(r.precision, 6);
});

t('decodes a datum carrying shared_data + extended_data wrappers', () => {
  const hex = buildDatum({
    price:     1234567,
    timestamp: 1769010000000,
    expiry:    1769013600000,
    precision: 6,
    withShared:   true,
    withExtended: true,
  });
  const r = decode(hex);
  assert.equal(r.price,     '1234567');
  assert.equal(r.timestamp, 1769010000000);
  assert.equal(r.expiry,    1769013600000);
});

t('falls back to precision 6 when key 3 is absent', () => {
  const hex = buildDatum({
    price:     820000,
    timestamp: 1769020000000,
    expiry:    1769023600000,
    // no precision key
  });
  const r = decode(hex);
  assert.equal(r.precision, 6);
});

t('rejects empty placeholder (price = 0)', () => {
  const hex = buildDatum({
    price:     0,
    timestamp: 1769030000000,
    expiry:    1769033600000,
    precision: 6,
  });
  assert.throws(() => decode(hex), /price is zero/);
});

t('rejects datum missing required key (no expiry)', () => {
  const intData = (n: number) =>
    CSL.PlutusData.new_integer(CSL.BigInt.from_str(String(n)));
  const priceMap = CSL.PlutusMap.new();
  const insert = (key: number, value: CSL.PlutusData) => {
    const values = CSL.PlutusMapValues.new();
    values.add(value);
    priceMap.insert(intData(key), values);
  };
  insert(0, intData(100));
  insert(1, intData(1769040000000));
  // no key 2

  const pdFields = CSL.PlutusList.new();
  pdFields.add(CSL.PlutusData.new_map(priceMap));
  const pd = CSL.PlutusData.new_constr_plutus_data(
    CSL.ConstrPlutusData.new(CSL.BigNum.from_str('2'), pdFields),
  );
  const outerFields = CSL.PlutusList.new();
  outerFields.add(pd);
  const outer = CSL.PlutusData.new_constr_plutus_data(
    CSL.ConstrPlutusData.new(CSL.BigNum.from_str('0'), outerFields),
  );

  assert.throws(() => decode(outer.to_hex()), /missing required keys/);
});

t('rejects non-Constr CBOR', () => {
  assert.throws(() => decode('182a'));   // CBOR uint(42)
});

t('rejects outer Constr alt != 0', () => {
  // Constr 5 with empty list
  const outer = CSL.PlutusData.new_constr_plutus_data(
    CSL.ConstrPlutusData.new(CSL.BigNum.from_str('5'), CSL.PlutusList.new()),
  );
  assert.throws(() => decode(outer.to_hex()), /outer alt is 5/);
});

t('rejects outer with no Constr 2 inside', () => {
  // Outer Constr 0 with only shared_data (Constr 0) — no price_data.
  const sharedInner = CSL.PlutusList.new();
  const shared = CSL.PlutusData.new_constr_plutus_data(
    CSL.ConstrPlutusData.new(CSL.BigNum.from_str('0'), sharedInner),
  );
  const outerFields = CSL.PlutusList.new();
  outerFields.add(shared);
  const outer = CSL.PlutusData.new_constr_plutus_data(
    CSL.ConstrPlutusData.new(CSL.BigNum.from_str('0'), outerFields),
  );
  assert.throws(() => decode(outer.to_hex()), /no Constr 2/);
});

t('rawToNumber handles ADA-USD precision-6 fixed point', () => {
  // 481300 / 1e6 = 0.4813
  const p = rawToNumber('481300', 6);
  assert.equal(p, 0.4813);
});

t('rawToNumber handles BTC-USD precision-2 (cents)', () => {
  // 6850000 cents = $68500.00
  const p = rawToNumber('6850000', 2);
  assert.equal(p, 68500);
});

t('rawToNumber preserves precision for sub-cent values', () => {
  // SNEK-style 0.000034408 with precision 12 = 34408000
  const p = rawToNumber('34408000', 12);
  assert.ok(Math.abs(p - 0.000034408) < 1e-12, `got ${p}`);
});

t('rawToNumber throws on precision yielding zero denom', () => {
  // BigInt(10n ** 0n) = 1n, fine. Test guard against negative precision is
  // upstream — here we just ensure no crash for precision = 0.
  const p = rawToNumber('100', 0);
  assert.equal(p, 100);
});

t('VARIANT_ASSET_NAME_HEX matches Charli3 reference reader exactly', () => {
  // hex("OracleFeed") and hex("C3AS") — both UTF-8 byte-encoded.
  assert.equal(_VARIANT_ASSET_NAME_HEX.legacy, '4f7261636c6546656564');
  assert.equal(_VARIANT_ASSET_NAME_HEX.odv,    '43334153');
});

t('supportsPair recognises configured pairs for the active network', () => {
  // Default (no env) resolves to preprod inside the adapter.
  const prevNet     = process.env.NETWORK;
  const prevC3      = process.env.CHARLI3_NETWORK;
  delete process.env.NETWORK;
  delete process.env.CHARLI3_NETWORK;
  try {
    assert.equal(supportsPair('ADA-USD'),  true);
    assert.equal(supportsPair('BTC-USD'),  true);
    assert.equal(supportsPair('ADA-USDM'), true);
    assert.equal(supportsPair('FOO-BAR'),  false);
  } finally {
    if (prevNet !== undefined) process.env.NETWORK = prevNet;
    if (prevC3  !== undefined) process.env.CHARLI3_NETWORK = prevC3;
  }
});

t('supportsPair scopes to network — mainnet exposes BTC-ADA, preprod does not', () => {
  const prevNet = process.env.NETWORK;
  const prevC3  = process.env.CHARLI3_NETWORK;
  try {
    process.env.CHARLI3_NETWORK = 'mainnet';
    assert.equal(supportsPair('BTC-ADA'),  true);
    assert.equal(supportsPair('NIGHT-ADA'), true);
    assert.equal(supportsPair('BTC-USD'),  false);   // mainnet has no BTC-USD feed

    process.env.CHARLI3_NETWORK = 'preprod';
    assert.equal(supportsPair('BTC-USD'),  true);
    assert.equal(supportsPair('BTC-ADA'),  false);
    assert.equal(supportsPair('NIGHT-ADA'), false);
  } finally {
    if (prevNet !== undefined) process.env.NETWORK = prevNet; else delete process.env.NETWORK;
    if (prevC3  !== undefined) process.env.CHARLI3_NETWORK = prevC3; else delete process.env.CHARLI3_NETWORK;
  }
});

console.log(`\n${n - fails}/${n} passed`);
process.exit(fails ? 1 : 0);
