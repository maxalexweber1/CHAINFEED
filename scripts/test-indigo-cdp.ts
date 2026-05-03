/**
 * Indigo CDP-aggregator integration test.
 *
 * Patches `globalThis.fetch` to stub the two HTTP endpoints (Koios
 * credential_utxos + Minswap ada-price) and asserts the adapter:
 *   - decodes a real-shape datum and aggregates correctly
 *   - skips IAssetDatum registry entries (Constr 1)
 *   - skips spent UTxOs and UTxOs without inline_datum
 *   - filters to iUSD only when other iAssets present
 *   - bucket health correctly
 *   - rejects unsupported pair / empty UTxO list / malformed ADA-USD
 *
 * The decoder itself is also unit-tested here against the live sample
 * datum captured 2026-05-02 — locks the schema in.
 *
 * Run: npx tsx scripts/test-indigo-cdp.ts
 */

import assert from 'node:assert/strict';
import * as CSL from '@emurgo/cardano-serialization-lib-nodejs';

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

type FetchStub = { ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> };
const jsonResp = (body: unknown): FetchStub => ({
  ok: true, status: 200,
  json: async () => body,
  text: async () => JSON.stringify(body),
});
const errResp  = (status: number, body: string): FetchStub => ({
  ok: false, status,
  json: async () => { throw new Error('not json'); },
  text: async () => body,
});

/** Build a CDP datum (Constr 0 wrapping Constr 0 with [owner, iAsset, debt, snapshot]). */
function buildCdpDatum(opts: {
  ownerPkhHex?: string | null;       // null = frozen (Maybe Nothing)
  iAssetAscii: string;               // 'iUSD', 'iBTC', etc.
  debtRaw: bigint;
  /** if true, append the v2 interest-snapshot field at idx 3 */
  withSnapshot?: boolean;
}): string {
  const intData = (n: bigint) => CSL.PlutusData.new_integer(CSL.BigInt.from_str(n.toString()));
  const bytesData = (hex: string) =>
    CSL.PlutusData.new_bytes(Buffer.from(hex, 'hex'));

  // owner: Constr 0 [pkhBytes] (Just) or Constr 1 [] (Nothing)
  let owner: CSL.PlutusData;
  if (opts.ownerPkhHex) {
    const inner = CSL.PlutusList.new();
    inner.add(bytesData(opts.ownerPkhHex));
    owner = CSL.PlutusData.new_constr_plutus_data(
      CSL.ConstrPlutusData.new(CSL.BigNum.from_str('0'), inner),
    );
  } else {
    owner = CSL.PlutusData.new_constr_plutus_data(
      CSL.ConstrPlutusData.new(CSL.BigNum.from_str('1'), CSL.PlutusList.new()),
    );
  }

  const iAssetHex = Buffer.from(opts.iAssetAscii, 'utf8').toString('hex');

  const recordFields = CSL.PlutusList.new();
  recordFields.add(owner);
  recordFields.add(bytesData(iAssetHex));
  recordFields.add(intData(opts.debtRaw));
  if (opts.withSnapshot) {
    const snap = CSL.PlutusList.new();
    snap.add(intData(BigInt(Date.now())));
    snap.add(intData(0n));
    recordFields.add(CSL.PlutusData.new_constr_plutus_data(
      CSL.ConstrPlutusData.new(CSL.BigNum.from_str('0'), snap),
    ));
  }

  const cdpRecord = CSL.PlutusData.new_constr_plutus_data(
    CSL.ConstrPlutusData.new(CSL.BigNum.from_str('0'), recordFields),
  );

  const outerFields = CSL.PlutusList.new();
  outerFields.add(cdpRecord);
  const outer = CSL.PlutusData.new_constr_plutus_data(
    CSL.ConstrPlutusData.new(CSL.BigNum.from_str('0'), outerFields),
  );
  return outer.to_hex();
}

/** Build an IAssetDatum (Constr 1) — registry entry, NOT a user CDP. */
function buildIAssetDatum(): string {
  // Constr 1 with empty list — the actual schema is more complex but our
  // decoder rejects it on outer.alternative != 0, so contents don't matter.
  const c = CSL.PlutusData.new_constr_plutus_data(
    CSL.ConstrPlutusData.new(CSL.BigNum.from_str('1'), CSL.PlutusList.new()),
  );
  return c.to_hex();
}

async function main() {
  const bridge = require('../srv/external/odatano-bridge');
  const orig = {
    fetch: globalThis.fetch,
    getUtxosAtCredential: bridge.getUtxosAtCredential,
  };

  // Bridge mock: monkey-patch `getUtxosAtCredential` since the bridge
  // uses `export = { ... }` (CJS). Tests set `nextUtxos` per-case.
  let nextUtxos: Array<Record<string, unknown>> | Error = [];
  bridge.getUtxosAtCredential = async () => {
    if (nextUtxos instanceof Error) throw nextUtxos;
    return nextUtxos;
  };

  // HTTP mock: ADA-USD reference still goes through `getJson` → fetch.
  let responses: Map<string, FetchStub | Error> = new Map();
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);
    const r = responses.get(url);
    if (r === undefined) throw new Error(`mock fetch: no stub for ${url}`);
    if (r instanceof Error) throw r;
    return r as unknown as Response;
  }) as typeof globalThis.fetch;

  const indigo = require('../srv/adapters/indigo-cdp');
  const decode = indigo._decodeIndigoCdpDatum as (hex: string) => { iAssetHex: string; debt: bigint; ownerPkh: string | null } | null;
  const ADA_PRICE_URL = indigo._MINSWAP_ADA_PRICE_URL as string;

  /** Helper: build a bridge-shape UTxO. */
  function bridgeUtxo(opts: { txHash?: string; outputIndex?: number; lovelace: string; datumHex?: string | null; spent?: boolean }) {
    if (opts.spent) return null;   // emulate Koios filtering at API layer
    return {
      txHash:         opts.txHash ?? '00'.repeat(32),
      outputIndex:    opts.outputIndex ?? 0,
      lovelace:       opts.lovelace,
      inlineDatumHex: opts.datumHex ?? undefined,
    };
  }

  console.log('indigo-cdp decoder + integration ────────────────────────');

  // ── decoder unit checks (no fetch needed) ────────────────────────────
  t('decoder: agent-captured iUSD live sample → 3.603418 iUSD debt', () => {
    const SAMPLE = 'd8799fd8799fd8799f581c2c8289fa153e466b0f43429b9b18d9bfe040d80f07fe7d636c5657e4ff44695553441a0036fbdad8799f1b0000019267f47900c3490188106bcdd819e409ffffff';
    const r = decode(SAMPLE);
    assert.ok(r, 'expected decoded record');
    assert.equal(r!.iAssetHex, '69555344');                  // "iUSD"
    assert.equal(r!.debt, 3603418n);                          // 3.603418 iUSD
    assert.equal(r!.ownerPkh, '2c8289fa153e466b0f43429b9b18d9bfe040d80f07fe7d636c5657e4');
  });

  t('decoder: synthetic v1 (3-field, no snapshot) iUSD CDP', () => {
    const hex = buildCdpDatum({
      ownerPkhHex: 'aa'.repeat(28),
      iAssetAscii: 'iUSD',
      debtRaw:     5_000_000n,         // 5 iUSD
    });
    const r = decode(hex);
    assert.ok(r);
    assert.equal(r!.iAssetHex, '69555344');
    assert.equal(r!.debt, 5_000_000n);
    assert.equal(r!.ownerPkh, 'aa'.repeat(28));
  });

  t('decoder: synthetic v2 (4-field, with snapshot) iBTC CDP', () => {
    const hex = buildCdpDatum({
      ownerPkhHex: 'bb'.repeat(28),
      iAssetAscii: 'iBTC',
      debtRaw:     12_345n,
      withSnapshot: true,
    });
    const r = decode(hex);
    assert.ok(r);
    assert.equal(r!.iAssetHex, '69425443');
    assert.equal(r!.debt, 12_345n);
  });

  t('decoder: frozen CDP (Maybe Nothing owner) → ownerPkh=null', () => {
    const hex = buildCdpDatum({
      ownerPkhHex: null,
      iAssetAscii: 'iUSD',
      debtRaw:     1_000_000n,
    });
    const r = decode(hex);
    assert.ok(r);
    assert.equal(r!.ownerPkh, null);
    assert.equal(r!.debt, 1_000_000n);
  });

  t('decoder: rejects IAssetDatum (Constr 1) registry entry', () => {
    assert.equal(decode(buildIAssetDatum()), null);
  });

  t('decoder: rejects garbage CBOR', () => {
    assert.equal(decode('182a'), null);     // CBOR uint(42) — not a Constr
    assert.equal(decode('zzzz'), null);     // unparseable
  });

  // ── adapter integration with mocked Koios + Minswap ──────────────────
  await t('adapter: 4-CDP system → correct iUSD-only aggregate + ratio', async () => {
    // Build 4 mock bridge UTxOs:
    //   [0] iUSD CDP, 100 ADA collateral, 5 iUSD debt (CR ≈ 100×$0.247 / 5 = 494%)
    //   [1] iUSD CDP, 200 ADA collateral, 10 iUSD debt
    //   [2] iBTC CDP, 1000 ADA collateral — should NOT count toward iUSD aggregate
    //   [3] IAssetDatum (Constr 1 registry) — should be skipped
    nextUtxos = [
      bridgeUtxo({ txHash: 'aa'.repeat(32), lovelace: '100000000',
        datumHex: buildCdpDatum({ ownerPkhHex: 'aa'.repeat(28), iAssetAscii: 'iUSD', debtRaw: 5_000_000n, withSnapshot: true }) })!,
      bridgeUtxo({ txHash: 'bb'.repeat(32), lovelace: '200000000',
        datumHex: buildCdpDatum({ ownerPkhHex: 'bb'.repeat(28), iAssetAscii: 'iUSD', debtRaw: 10_000_000n, withSnapshot: true }) })!,
      bridgeUtxo({ txHash: 'cc'.repeat(32), lovelace: '1000000000',
        datumHex: buildCdpDatum({ ownerPkhHex: 'cc'.repeat(28), iAssetAscii: 'iBTC', debtRaw: 1n, withSnapshot: true }) })!,
      bridgeUtxo({ txHash: 'dd'.repeat(32), lovelace: '2000000', datumHex: buildIAssetDatum() })!,
    ];
    responses = new Map<string, FetchStub | Error>([
      [ADA_PRICE_URL, jsonResp({ value: { price: 0.247 } })],
    ]);

    const q = await indigo.getPrice('iUSD-COLLATERAL');
    assert.equal(q.kind, 'attestation');
    assert.equal(q.unit, 'ratio_pct');
    assert.equal(q.pair, 'iUSD-COLLATERAL');

    const raw = q.rawPayload as {
      cdpCount: number; collateralAda: number; debtUnits: number;
      iAsset: string; isUsdPegged: boolean;
      adaUsdReference: number; healthBucket: string;
      perAssetSummary: Record<string, { count: number; collateralAda: number; debtRaw: string }>;
      utxoStats: { totalUnspent: number; skippedNoDatum: number; skippedNonCdp: number; decodedCdps: number };
    };
    // iUSD aggregate: 300 ADA collateral, 15 iUSD debt
    assert.equal(raw.iAsset,       'iUSD');
    assert.equal(raw.isUsdPegged,  true);
    assert.equal(raw.cdpCount,     2);
    assert.equal(raw.collateralAda, 300);
    assert.equal(raw.debtUnits,    15);
    // ratio = 300×0.247/15 ≈ 494%  → 'healthy' (>=300)
    assert.ok(Math.abs(q.value - 494) < 1, `expected ~494%, got ${q.value}`);
    assert.equal(raw.healthBucket, 'healthy');

    // Per-asset breakdown: both iUSD CDPs grouped, plus iBTC bucket exists separately
    assert.equal(raw.perAssetSummary['iUSD']!.count,   2);
    assert.equal(raw.perAssetSummary['iUSD']!.collateralAda, 300);
    assert.equal(raw.perAssetSummary['iBTC']!.count,   1);

    // UTxO stats: 4 total, 1 IAssetDatum skipped, 3 decoded as CDPs
    assert.equal(raw.utxoStats.totalUnspent,  4);
    assert.equal(raw.utxoStats.skippedNoDatum, 0);
    assert.equal(raw.utxoStats.skippedNonCdp, 1);     // the IAssetDatum
    assert.equal(raw.utxoStats.decodedCdps,   3);
  });

  await t('adapter: no-datum UTxOs counted as skippedNoDatum', async () => {
    // Spent UTxOs are filtered at the bridge layer (Koios server-side),
    // so we don't pass them in the mock. Test: a UTxO without inline datum
    // gets counted as "skippedNoDatum"; a valid CDP gets aggregated.
    nextUtxos = [
      bridgeUtxo({ txHash: '22'.repeat(32), lovelace: '50000000', datumHex: null })!,
      bridgeUtxo({ txHash: '33'.repeat(32), lovelace: '500000000',
        datumHex: buildCdpDatum({ ownerPkhHex: 'aa'.repeat(28), iAssetAscii: 'iUSD', debtRaw: 100_000_000n, withSnapshot: true }) })!,
    ];
    responses = new Map<string, FetchStub | Error>([
      [ADA_PRICE_URL, jsonResp({ value: { price: 0.247 } })],
    ]);
    const q = await indigo.getPrice('iUSD-COLLATERAL');
    const raw = q.rawPayload as {
      cdpCount: number; collateralAda: number; debtUnits: number;
      utxoStats: { totalUnspent: number; skippedNoDatum: number };
    };
    assert.equal(raw.cdpCount,      1);
    assert.equal(raw.collateralAda, 500);
    assert.equal(raw.debtUnits,     100);
    assert.equal(raw.utxoStats.totalUnspent,   2);
    assert.equal(raw.utxoStats.skippedNoDatum, 1);
  });

  await t('adapter: iBTC-COLLATERAL → unit=synthetic_debt, healthBucket=null', async () => {
    // 2 iBTC CDPs: 1000 ADA + 5000 ADA collateral, 0.005 + 0.02 iBTC debt.
    nextUtxos = [
      bridgeUtxo({ txHash: '44'.repeat(32), lovelace: '1000000000',
        datumHex: buildCdpDatum({ ownerPkhHex: 'aa'.repeat(28), iAssetAscii: 'iBTC', debtRaw: 5_000n,  withSnapshot: true }) })!,
      bridgeUtxo({ txHash: '55'.repeat(32), lovelace: '5000000000',
        datumHex: buildCdpDatum({ ownerPkhHex: 'bb'.repeat(28), iAssetAscii: 'iBTC', debtRaw: 20_000n, withSnapshot: true }) })!,
      // An iUSD CDP that should NOT contribute to the iBTC aggregate.
      bridgeUtxo({ txHash: '66'.repeat(32), lovelace: '999999999999',
        datumHex: buildCdpDatum({ ownerPkhHex: 'cc'.repeat(28), iAssetAscii: 'iUSD', debtRaw: 1_000_000n, withSnapshot: true }) })!,
    ];
    responses = new Map<string, FetchStub | Error>([
      [ADA_PRICE_URL, jsonResp({ value: { price: 0.247 } })],
    ]);
    const q = await indigo.getPrice('iBTC-COLLATERAL');
    assert.equal(q.unit, 'synthetic_debt');
    // value = total debt in synthetic units = (5000 + 20000) / 1e6 = 0.025 iBTC
    assert.equal(q.value, 0.025);
    const raw = q.rawPayload as {
      iAsset: string; isUsdPegged: boolean; healthBucket: string | null;
      cdpCount: number; collateralAda: number; debtUnits: number; thresholds: unknown;
    };
    assert.equal(raw.iAsset, 'iBTC');
    assert.equal(raw.isUsdPegged, false);
    assert.equal(raw.healthBucket, null);   // can't compute bucket without external BTC price
    assert.equal(raw.thresholds, null);
    assert.equal(raw.cdpCount, 2);
    assert.equal(raw.collateralAda, 6000);  // 1000 + 5000
    assert.equal(raw.debtUnits, 0.025);
  });

  await t('adapter: warning bucket at 250% CR', async () => {
    nextUtxos = [bridgeUtxo({ txHash: '44'.repeat(32), lovelace: '101000000',
      datumHex: buildCdpDatum({ ownerPkhHex: 'aa'.repeat(28), iAssetAscii: 'iUSD', debtRaw: 100_000_000n, withSnapshot: true }) })!];
    responses = new Map<string, FetchStub | Error>([
      [ADA_PRICE_URL, jsonResp({ value: { price: 2.50 } })],   // ADA at $2.50
    ]);
    const q = await indigo.getPrice('iUSD-COLLATERAL');
    // 101 × $2.50 / (100 × $1) × 100 = 252.5%
    assert.ok(q.value >= 200 && q.value < 300, `expected 200-300%, got ${q.value}`);
    assert.equal((q.rawPayload as { healthBucket: string }).healthBucket, 'warning');
  });

  await t('adapter: critical bucket below 150% CR', async () => {
    nextUtxos = [bridgeUtxo({ txHash: '55'.repeat(32), lovelace: '100000000',
      datumHex: buildCdpDatum({ ownerPkhHex: 'aa'.repeat(28), iAssetAscii: 'iUSD', debtRaw: 100_000_000n, withSnapshot: true }) })!];
    responses = new Map<string, FetchStub | Error>([
      [ADA_PRICE_URL, jsonResp({ value: { price: 1.20 } })],   // 120% CR
    ]);
    const q = await indigo.getPrice('iUSD-COLLATERAL');
    assert.ok(q.value < 150, `expected <150%, got ${q.value}`);
    assert.equal((q.rawPayload as { healthBucket: string }).healthBucket, 'critical');
  });

  await t('adapter: rejects unsupported pair', async () => {
    await assert.rejects(() => indigo.getPrice('FOO-BAR'), /pair 'FOO-BAR' not supported/);
  });

  await t('adapter: rejects when bridge returns empty list', async () => {
    nextUtxos = [];
    await assert.rejects(() => indigo.getPrice('iUSD-COLLATERAL'), /returned no UTxOs/);
  });

  await t('adapter: rejects when no iUSD CDPs found (only iBTC)', async () => {
    nextUtxos = [bridgeUtxo({ txHash: '66'.repeat(32), lovelace: '100000000',
      datumHex: buildCdpDatum({ ownerPkhHex: 'aa'.repeat(28), iAssetAscii: 'iBTC', debtRaw: 1n, withSnapshot: true }) })!];
    responses = new Map<string, FetchStub | Error>([
      [ADA_PRICE_URL, jsonResp({ value: { price: 0.247 } })],
    ]);
    await assert.rejects(() => indigo.getPrice('iUSD-COLLATERAL'), /no iUSD CDPs decoded/);
  });

  await t('adapter: rejects when ADA-USD reference is malformed', async () => {
    nextUtxos = [bridgeUtxo({ txHash: '77'.repeat(32), lovelace: '100000000',
      datumHex: buildCdpDatum({ ownerPkhHex: 'aa'.repeat(28), iAssetAscii: 'iUSD', debtRaw: 1_000_000n, withSnapshot: true }) })!];
    responses = new Map<string, FetchStub | Error>([
      [ADA_PRICE_URL, jsonResp({ value: { price: 'nope' } })],
    ]);
    await assert.rejects(() => indigo.getPrice('iUSD-COLLATERAL'), /invalid ADA-USD reference/);
  });

  await t('adapter: propagates bridge errors', async () => {
    nextUtxos = new Error('bridge-koios-down');
    await assert.rejects(() => indigo.getPrice('iUSD-COLLATERAL'), /bridge-koios-down/);
  });

  await t('supportsPair: all 4 Indigo iAsset pairs', () => {
    assert.equal(indigo.supportsPair('iUSD-COLLATERAL'), true);
    assert.equal(indigo.supportsPair('iBTC-COLLATERAL'), true);
    assert.equal(indigo.supportsPair('iETH-COLLATERAL'), true);
    assert.equal(indigo.supportsPair('iSOL-COLLATERAL'), true);
    assert.equal(indigo.supportsPair('USDM-RESERVES'),   false);
    assert.equal(indigo.supportsPair('ADA-iUSD'),        false);
    assert.equal(indigo.supportsPair(''),                false);
  });

  globalThis.fetch = orig.fetch;
  bridge.getUtxosAtCredential = orig.getUtxosAtCredential;

  console.log(`\n${n - fails}/${n} passed`);
  process.exit(fails ? 1 : 0);
}

main().catch(err => { console.error('runner crash:', err); process.exit(2); });
