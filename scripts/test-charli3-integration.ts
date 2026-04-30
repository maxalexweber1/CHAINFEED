/**
 * Charli3 adapter integration test — mocks the ODATANO bridge and feeds
 * synthetic oracle UTxOs/datums through the full getPrice path.
 *
 * Covers what the pure decoder test cannot:
 *   - bridge fanout + sequential tx fetch
 *   - max(timestamp) winner selection across multiple UTxOs
 *   - empty-placeholder C3AS skip (price=0 → ignored, next candidate wins)
 *   - pair inversion for ADA-USDM (on-chain feed is USDM/ADA)
 *   - isStale flag derived from datum expiry (not a heuristic, unlike Orcfax)
 *   - pair / network rejection paths
 *   - bridge call shape: filter triple is (address, policy, OracleFeed|C3AS hex)
 *
 * Run: npx tsx scripts/test-charli3-integration.ts
 */

import assert from 'node:assert/strict';
import * as CSL from '@emurgo/cardano-serialization-lib-nodejs';

// Mock the bridge BEFORE requiring the adapter (must share the same module
// instance — `export = { ... }` makes the methods mutable in place).
const bridge = require('../srv/external/odatano-bridge');

interface BuildArgs {
  price:     number | string;
  timestamp: number;
  expiry:    number;
  precision?: number;
}

function buildDatum({ price, timestamp, expiry, precision = 6 }: BuildArgs): string {
  const intData = (n: string | number) =>
    CSL.PlutusData.new_integer(CSL.BigInt.from_str(String(n)));

  const priceMap = CSL.PlutusMap.new();
  const insert = (key: number, value: CSL.PlutusData) => {
    const values = CSL.PlutusMapValues.new();
    values.add(value);
    priceMap.insert(intData(key), values);
  };
  insert(0, intData(price));
  insert(1, intData(timestamp));
  insert(2, intData(expiry));
  insert(3, intData(precision));

  // price_data = Constr 2 [ map ]
  const pdFields = CSL.PlutusList.new();
  pdFields.add(CSL.PlutusData.new_map(priceMap));
  const pd = CSL.PlutusData.new_constr_plutus_data(
    CSL.ConstrPlutusData.new(CSL.BigNum.from_str('2'), pdFields),
  );

  // outer = Constr 0 [ price_data ]
  const outerFields = CSL.PlutusList.new();
  outerFields.add(pd);
  const outer = CSL.PlutusData.new_constr_plutus_data(
    CSL.ConstrPlutusData.new(CSL.BigNum.from_str('0'), outerFields),
  );
  return outer.to_hex();
}

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

// Preprod ODV ADA-USD config — matches FEED_CONFIG.preprod['ADA-USD'].
const ADA_USD_ADDR    = 'addr_test1wq3pacs7jcrlwehpuy3ryj8kwvsqzjp9z6dpmx8txnr0vkq6vqeuu';
const ADA_USD_POLICY  = '886dcb2363e160c944e63cf544ce6f6265b22ef7c4e2478dd975078e';
const USDM_ADA_POLICY = 'fcc738fa9ae006bc8de82385ff3457a2817ccc4eaa5ce53a61334674';
const C3AS_ASSETHEX   = '43334153';                 // hex("C3AS")
const ORACLEFEED_HEX  = '4f7261636c6546656564';     // hex("OracleFeed")

async function main() {
  process.env.CHARLI3_NETWORK = 'preprod';

  const orig = {
    getUtxosWithAsset:    bridge.getUtxosWithAsset,
    getTransactionByHash: bridge.getTransactionByHash,
  };

  const charli3 = require('../srv/adapters/charli3');

  console.log('charli3 integration ────────────────────────────────────');

  const now = Date.now();

  await t('picks the freshest ADA-USD C3AS UTxO and computes price', async () => {
    const older = buildDatum({ price: 480000, timestamp: now - 5 * 60 * 1000, expiry: now + 55 * 60 * 1000 });
    const newer = buildDatum({ price: 481300, timestamp: now - 1 * 60 * 1000, expiry: now + 59 * 60 * 1000 });
    const utxos = [
      { txHash: 'aa'.repeat(32), outputIndex: 0 },
      { txHash: 'bb'.repeat(32), outputIndex: 1 },
    ];
    const datumAt: Record<string, string> = {
      [`${'aa'.repeat(32)}#0`]: older,
      [`${'bb'.repeat(32)}#1`]: newer,
    };

    let capturedFilter: { address?: string; policy?: string; assetName?: string } = {};
    bridge.getUtxosWithAsset = async (address: string, policy: string, assetName: string) => {
      capturedFilter = { address, policy, assetName };
      return utxos;
    };
    bridge.getTransactionByHash = async (hash: string) => {
      const u = utxos.find(x => x.txHash === hash);
      if (!u) return null;
      const outs: Array<{ inlineDatum?: string } | undefined> = [];
      outs[u.outputIndex] = { inlineDatum: datumAt[`${hash}#${u.outputIndex}`] };
      return { outputs: outs };
    };

    const q = await charli3.getPrice('ADA-USD');
    assert.equal(q.sourceName, 'charli3');
    assert.equal(q.pair, 'ADA-USD');
    assert.equal(q.txHash, 'bb'.repeat(32));
    assert.equal(q.price, 0.4813);
    assert.equal(q.isStale, false);
    assert.ok(q.validUntil! > q.timestamp);

    // Bridge was filtered by the right (address, policy, C3AS) triple.
    assert.equal(capturedFilter.address,   ADA_USD_ADDR);
    assert.equal(capturedFilter.policy,    ADA_USD_POLICY);
    assert.equal(capturedFilter.assetName, C3AS_ASSETHEX);

    const raw = q.rawPayload as { variant: string; inverted: boolean; rawPrice: string; precision: number };
    assert.equal(raw.variant,  'odv');
    assert.equal(raw.inverted, false);
    assert.equal(raw.rawPrice, '481300');
    assert.equal(raw.precision, 6);
  });

  await t('skips empty C3AS placeholders (price=0) and uses next candidate', async () => {
    const empty = buildDatum({ price: 0,      timestamp: now - 30_000, expiry: now + 60_000 });
    const real  = buildDatum({ price: 481300, timestamp: now - 60_000, expiry: now + 60_000 });
    const utxos = [
      { txHash: 'cc'.repeat(32), outputIndex: 0 },   // empty placeholder
      { txHash: 'dd'.repeat(32), outputIndex: 0 },   // valid feed
    ];
    const datumAt: Record<string, string> = {
      [`${'cc'.repeat(32)}#0`]: empty,
      [`${'dd'.repeat(32)}#0`]: real,
    };
    bridge.getUtxosWithAsset    = async () => utxos;
    bridge.getTransactionByHash = async (hash: string) => ({
      outputs: [{ inlineDatum: datumAt[`${hash}#0`] }],
    });

    const q = await charli3.getPrice('ADA-USD');
    assert.equal(q.txHash, 'dd'.repeat(32));
    assert.equal(q.price, 0.4813);
  });

  await t('inverts the ADA-USDM feed (on-chain USDM/ADA → exposed ADA/USDM)', async () => {
    // Charli3 publishes USDM in ADA. Say USDM ≈ 4 ADA → on-chain price 4_000_000
    // (precision 6). Inverted exposure is 1/4 = 0.25 ADA per USDM.
    const datum = buildDatum({
      price:     4_000_000,
      timestamp: now - 60_000,
      expiry:    now + 3_600_000,
    });
    let captured: { policy?: string } = {};
    bridge.getUtxosWithAsset = async (_addr: string, policy: string, _name: string) => {
      captured = { policy };
      return [{ txHash: 'ee'.repeat(32), outputIndex: 0 }];
    };
    bridge.getTransactionByHash = async () => ({ outputs: [{ inlineDatum: datum }] });

    const q = await charli3.getPrice('ADA-USDM');
    assert.equal(q.pair, 'ADA-USDM');
    assert.equal(captured.policy, USDM_ADA_POLICY);
    assert.ok(Math.abs(q.price - 0.25) < 1e-9, `inverted price was ${q.price}`);
    assert.equal((q.rawPayload as { inverted: boolean }).inverted, true);
    assert.equal((q.rawPayload as { rawPrice: string }).rawPrice, '4000000');
  });

  await t('legacy variant feeds use the OracleFeed asset name', async () => {
    process.env.CHARLI3_NETWORK = 'mainnet';
    let captured: { policy?: string; assetName?: string } = {};
    bridge.getUtxosWithAsset = async (_a: string, policy: string, assetName: string) => {
      captured = { policy, assetName };
      return [{ txHash: 'ff'.repeat(32), outputIndex: 0 }];
    };
    bridge.getTransactionByHash = async () => ({
      outputs: [{ inlineDatum: buildDatum({ price: 800000, timestamp: now, expiry: now + 1_000 }) }],
    });
    const q = await charli3.getPrice('BTC-ADA');
    assert.equal(q.sourceName, 'charli3');
    assert.equal(captured.assetName, ORACLEFEED_HEX);
    process.env.CHARLI3_NETWORK = 'preprod';
  });

  await t('flags as stale when datum expiry has passed', async () => {
    const expired = buildDatum({
      price:     481300,
      timestamp: now - 7_200_000,   // 2h ago
      expiry:    now -   600_000,   // expired 10 min ago
    });
    bridge.getUtxosWithAsset    = async () => [{ txHash: '11'.repeat(32), outputIndex: 0 }];
    bridge.getTransactionByHash = async () => ({ outputs: [{ inlineDatum: expired }] });

    const q = await charli3.getPrice('ADA-USD');
    assert.equal(q.isStale, true);
    assert.ok(q.validUntil! < Date.now());
  });

  await t('rejects when bridge returns no oracle UTxOs', async () => {
    bridge.getUtxosWithAsset = async () => [];
    await assert.rejects(
      () => charli3.getPrice('ADA-USD'),
      /no oracle UTxOs at addr_test1wq3pacs7jcrlwehpuy3ryj8kwvsqzjp9z6dpmx8txnr0vkq6vqeuu for ADA-USD on preprod/,
    );
  });

  await t('rejects when every UTxO fails to decode', async () => {
    bridge.getUtxosWithAsset    = async () => [
      { txHash: '22'.repeat(32), outputIndex: 0 },
      { txHash: '33'.repeat(32), outputIndex: 0 },
    ];
    // All outputs are empty placeholders (price=0 → decode throws).
    const empty = buildDatum({ price: 0, timestamp: now, expiry: now + 60_000 });
    bridge.getTransactionByHash = async () => ({ outputs: [{ inlineDatum: empty }] });
    await assert.rejects(
      () => charli3.getPrice('ADA-USD'),
      /no decodable feed UTxO/,
    );
  });

  await t('rejects unsupported pair', async () => {
    await assert.rejects(
      () => charli3.getPrice('FOO-BAR'),
      /pair 'FOO-BAR' is not configured on preprod/,
    );
  });

  await t('rejects unsupported network', async () => {
    process.env.CHARLI3_NETWORK = 'preview';
    await assert.rejects(
      () => charli3.getPrice('ADA-USD'),
      /unsupported network 'preview'/,
    );
    process.env.CHARLI3_NETWORK = 'preprod';
  });

  // restore
  bridge.getUtxosWithAsset    = orig.getUtxosWithAsset;
  bridge.getTransactionByHash = orig.getTransactionByHash;

  console.log(`\n${n - fails}/${n} passed`);
  process.exit(fails ? 1 : 0);
}

main().catch(err => { console.error('runner crash:', err); process.exit(2); });
