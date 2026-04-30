/**
 * Orcfax adapter integration test — mocks the ODATANO bridge with a
 * synthetic FS UTxO list and the captured CBLP-ADA datum sample.
 *
 * Run: npx tsx scripts/test-orcfax-integration.ts
 */

import assert from 'node:assert/strict';
import * as CSL from '@emurgo/cardano-serialization-lib-nodejs';

// Mock the bridge BEFORE requiring the adapter.
const bridge = require('../srv/external/odatano-bridge');

// Sample datum hex from docs/research/orcfax-feeds.md §7
const CBLP_DATUM = 'd8799fd8799f4e4345522f43424c502d4144412f331b0000019bf6f0a165d8799f19d41d1a4a817c80ffffd8799f581c3c12f6735ef87655c5b27bced3f828d857d0a27fd20f2cda18ebf2fbffff';

interface BuildDatumArgs { createdAtMs: number; num: number | string; denom: number | string }

function buildAdaUsdDatum({ createdAtMs, num, denom }: BuildDatumArgs): string {
  const feedIdBytes = Buffer.from('CER/ADA-USD/3', 'utf8');
  const stmtList = CSL.PlutusList.new();
  stmtList.add(CSL.PlutusData.new_bytes(feedIdBytes));
  stmtList.add(CSL.PlutusData.new_integer(CSL.BigInt.from_str(String(createdAtMs))));
  // body = Constr 0 [num, denom]
  const bodyList = CSL.PlutusList.new();
  bodyList.add(CSL.PlutusData.new_integer(CSL.BigInt.from_str(String(num))));
  bodyList.add(CSL.PlutusData.new_integer(CSL.BigInt.from_str(String(denom))));
  const bodyConstr = CSL.PlutusData.new_constr_plutus_data(
    CSL.ConstrPlutusData.new(CSL.BigNum.from_str('0'), bodyList),
  );
  stmtList.add(bodyConstr);
  const stmt = CSL.PlutusData.new_constr_plutus_data(
    CSL.ConstrPlutusData.new(CSL.BigNum.from_str('0'), stmtList),
  );

  // outer = Constr 0 [stmt, context]
  const ctxList = CSL.PlutusList.new();
  ctxList.add(CSL.PlutusData.new_bytes(Buffer.from('00'.repeat(28), 'hex')));
  const ctx = CSL.PlutusData.new_constr_plutus_data(
    CSL.ConstrPlutusData.new(CSL.BigNum.from_str('0'), ctxList),
  );
  const outerList = CSL.PlutusList.new();
  outerList.add(stmt);
  outerList.add(ctx);
  const outer = CSL.PlutusData.new_constr_plutus_data(
    CSL.ConstrPlutusData.new(CSL.BigNum.from_str('0'), outerList),
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

async function main() {
  // Force network to preprod so adapter uses preprod config.
  process.env.ORCFAX_NETWORK = 'preprod';

  // Capture original bridge methods so we can restore after.
  const orig = {
    getUtxosWithAsset: bridge.getUtxosWithAsset,
    getTransactionByHash: bridge.getTransactionByHash,
  };

  const orcfax = require('../srv/adapters/orcfax');

  console.log('orcfax integration ─────────────────────────────────────');

  // Build two ADA-USD datums (older + newer), one CBLP-ADA datum (ignored), one junk.
  const older   = buildAdaUsdDatum({ createdAtMs: Date.now() - 10 * 60 * 1000, num: 4500, denom: 10000 });
  const newer   = buildAdaUsdDatum({ createdAtMs: Date.now() -  2 * 60 * 1000, num: 4813, denom: 10000 });
  const cblp    = CBLP_DATUM;            // CER/CBLP-ADA/3 — should be filtered out
  const junkHex = 'd87980';              // Constr 0 [] — decode fails

  const utxos = [
    { txHash: 'aa'.repeat(32), outputIndex: 0, address: 'x', lovelace: '1500000', assets: [] },  // older ADA-USD
    { txHash: 'bb'.repeat(32), outputIndex: 0, address: 'x', lovelace: '1500000', assets: [] },  // newer ADA-USD
    { txHash: 'cc'.repeat(32), outputIndex: 0, address: 'x', lovelace: '1500000', assets: [] },  // CBLP-ADA
    { txHash: 'dd'.repeat(32), outputIndex: 0, address: 'x', lovelace: '1500000', assets: [] },  // junk
  ];
  const datumByTx = {
    [`${'aa'.repeat(32)}#0`]: older,
    [`${'bb'.repeat(32)}#0`]: newer,
    [`${'cc'.repeat(32)}#0`]: cblp,
    [`${'dd'.repeat(32)}#0`]: junkHex,
  };

  bridge.getUtxosWithAsset = async () => utxos;
  bridge.getTransactionByHash = async (hash: string) => {
    const u = utxos.find(x => x.txHash === hash);
    if (!u) return null;
    return {
      hash,
      outputs: [{ inlineDatum: datumByTx[`${hash}#0`] }],
    };
  };

  await t('picks the newest ADA-USD UTxO across stale + alien feeds', async () => {
    const q = await orcfax.getPrice('ADA-USD');
    assert.equal(q.sourceName, 'orcfax');
    assert.equal(q.pair, 'ADA-USD');
    assert.equal(q.txHash, 'bb'.repeat(32));
    assert.equal(q.price, 0.4813);   // 4813 / 10000
    assert.equal(q.isStale, false);  // 2 min old << 1.5 * 3600s
    assert.ok(q.validUntil > q.timestamp);
    assert.equal((q.rawPayload as { feedId: string }).feedId, 'CER/ADA-USD/3');
  });

  await t('rejects when no UTxOs match the feed prefix', async () => {
    bridge.getUtxosWithAsset = async () => [utxos[2]]; // only the CBLP one
    bridge.getTransactionByHash = async (hash: string) => ({
      hash, outputs: [{ inlineDatum: datumByTx[`${hash}#0`] }],
    });
    await assert.rejects(
      () => orcfax.getPrice('ADA-USD'),
      /no UTxO at .* matched feed prefix 'CER\/ADA-USD\/' on preprod/,
    );
  });

  await t('rejects when there are no FS-token UTxOs at all', async () => {
    bridge.getUtxosWithAsset = async () => [];
    await assert.rejects(
      () => orcfax.getPrice('ADA-USD'),
      /no FS UTxOs at addr_test1wraqlpezmu3h9n9mxey6y03u2sdd0e8cyx9n2qxscz6staczrlnuj on preprod/,
    );
  });

  await t('rejects unsupported pair', async () => {
    await assert.rejects(
      () => orcfax.getPrice('FOO-BAR'),
      /pair 'FOO-BAR' is not configured/,
    );
  });

  await t('flags as stale when newest datum is older than 1.5*interval', async () => {
    const veryOld = buildAdaUsdDatum({
      createdAtMs: Date.now() - 2 * 3600 * 1000,  // 2 hours old
      num: 4500, denom: 10000,
    });
    bridge.getUtxosWithAsset = async () => [{ ...utxos[0] }];
    bridge.getTransactionByHash = async (hash: string) => ({
      hash, outputs: [{ inlineDatum: veryOld }],
    });
    const q = await orcfax.getPrice('ADA-USD');
    assert.equal(q.isStale, true);
  });

  // restore (good test hygiene even if process exits)
  bridge.getUtxosWithAsset = orig.getUtxosWithAsset;
  bridge.getTransactionByHash = orig.getTransactionByHash;

  console.log(`\n${n - fails}/${n} passed`);
  process.exit(fails ? 1 : 0);
}

main().catch(err => { console.error('runner crash:', err); process.exit(2); });
