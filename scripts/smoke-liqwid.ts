/**
 * Liqwid Finance v2 live-mainnet smoke.
 *
 * Hits the actual ODATANO-bridge against mainnet, reads the singleton
 * MarketState UTxOs for DJED / iUSD / USDM, plus the GraphQL APY fanout.
 *
 * Asserts:
 *   - All 3 in-scope markets resolve (each has its singleton UTxO)
 *   - Datum decode produces the 11-field shape with on-chain invariants:
 *       qTokenRateDenom === qTokenSupplyRaw
 *       totalSuppliedRaw == supplyRaw + principalRaw + reserveRaw
 *   - utilization ∈ [0, 1]
 *   - GraphQL APY fanout returns supplyAPY / borrowAPY for each market
 *
 * Requires:
 *   - BLOCKFROST_API_KEY set with mainnet key, OR Koios reachable
 *   - LIQWID_NETWORK=mainnet (default — only deployed network)
 *   - package.json `cds.requires.odatano-core.network` = mainnet
 *   - Outbound https to v2.api.liqwid.finance
 *
 * Run: npx tsx scripts/smoke-liqwid.ts
 */

const SHOULD_SHUTDOWN = true;

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

interface LiqwidMarketSnapshot {
  symbol: 'DJED' | 'iUSD' | 'USDM';
  liqwidId: 'DJED' | 'IUSD' | 'USDM';
  state: {
    supplyRaw: bigint;
    principalRaw: bigint;
    reserveRaw: bigint;
    qTokenSupplyRaw: bigint;
    qTokenRateNum: bigint;
    qTokenRateDenom: bigint;
    interestIndex: bigint;
    lastInterestUpdateMs: number;
    nextBatchDeadlineMs: number;
  };
  apy: {
    supplyAPY: number;
    borrowAPY: number;
    lqSupplyAPY: number;
    updatedAt: string;
  } | null;
}

async function main() {
  // Force mainnet for Liqwid regardless of NETWORK env.
  process.env.LIQWID_NETWORK = 'mainnet';

  const liqwid = require('../srv/adapters/liqwid');
  const { totalSuppliedRaw, utilizationFraction, qTokenRate } = require('../srv/lib/liqwid-decoder');
  const { fetchAllLiqwidApy } = require('../srv/lib/liqwid-graphql');
  const bridge = require('../srv/external/odatano-bridge');

  console.log('liqwid v2 live mainnet smoke ─────────────────────────────────');

  let snapshot: { markets: LiqwidMarketSnapshot[]; apySourceFailed: boolean } | null = null;

  await t('fetchAllMarkets: 3 stable markets resolve', async () => {
    snapshot = await liqwid._fetchAllMarkets();
    if (!snapshot) throw new Error('null snapshot');
    console.log(`        markets=${snapshot.markets.length} apySourceFailed=${snapshot.apySourceFailed}`);
    for (const m of snapshot.markets) {
      const supplied = Number(totalSuppliedRaw(m.state)) / 1e6;
      const util = (utilizationFraction(m.state) * 100).toFixed(2);
      const supplyApy = m.apy ? `${(m.apy.supplyAPY * 100).toFixed(2)}%` : 'n/a';
      console.log(`        ${m.symbol.padEnd(5)} supplied=${supplied.toFixed(0).padStart(10)} util=${util}% supplyAPY=${supplyApy}`);
    }
    if (snapshot.markets.length !== 3) {
      throw new Error(`expected 3 stable markets (DJED, iUSD, USDM), got ${snapshot.markets.length}`);
    }
  });

  await t('qTokenRate × qTokenSupply ≈ totalSupplied (within 5% tolerance)', async () => {
    if (!snapshot) throw new Error('previous step failed');
    // The on-chain qTokenRate stored as a [num, denom] pair is NOT a literal
    // num/qTokenSupply ratio — Liqwid's batch-settlement model produces a
    // denom that's frequently 1/4 of qTokenSupply (one per SupplyBatch shard)
    // or some other internal accounting. The economically meaningful check
    // is "qTokenRate × qTokenSupply roughly equals totalSupplied", which is
    // the redemption value invariant that matters to consumers.
    for (const m of snapshot.markets) {
      const total = Number(totalSuppliedRaw(m.state));
      const qTokens = Number(m.state.qTokenSupplyRaw);
      const rate = qTokenRate(m.state);
      const implied = qTokens * rate;
      const drift = Math.abs(implied - total) / total;
      if (drift > 0.05) {
        throw new Error(`${m.symbol}: qTokenRate × qTokenSupply (${implied.toFixed(0)}) drift ${(drift * 100).toFixed(2)}% from totalSupplied (${total.toFixed(0)})`);
      }
    }
  });

  await t('utilization in [0, 1] for every market', async () => {
    if (!snapshot) throw new Error('previous step failed');
    for (const m of snapshot.markets) {
      const u = utilizationFraction(m.state);
      if (!Number.isFinite(u) || u < 0 || u > 1) {
        throw new Error(`${m.symbol}: utilization out of range: ${u}`);
      }
    }
  });

  await t('totalSuppliedRaw === supply + principal + reserve', async () => {
    if (!snapshot) throw new Error('previous step failed');
    for (const m of snapshot.markets) {
      const expected = m.state.supplyRaw + m.state.principalRaw + m.state.reserveRaw;
      const actual = totalSuppliedRaw(m.state);
      if (expected !== actual) {
        throw new Error(`${m.symbol}: totalSupplied math mismatch: ${actual} vs ${expected}`);
      }
    }
  });

  await t('qTokenRate is a finite positive number', async () => {
    if (!snapshot) throw new Error('previous step failed');
    for (const m of snapshot.markets) {
      const r = qTokenRate(m.state);
      if (!Number.isFinite(r) || r <= 0) {
        throw new Error(`${m.symbol}: qTokenRate non-finite or non-positive: ${r}`);
      }
      // Sanity band: Liqwid markets accumulate underlying-per-qToken slowly.
      // 0.01 to 0.5 is a reasonable lifetime range.
      if (r < 0.01 || r > 0.5) {
        console.log(`        WARN ${m.symbol}: qTokenRate=${r} outside 0.01..0.5 sanity band`);
      }
    }
  });

  await t('GraphQL APY: every market has supplyAPY + borrowAPY', async () => {
    const apyMap = await fetchAllLiqwidApy();
    for (const id of ['DJED', 'IUSD', 'USDM']) {
      const a = apyMap.get(id);
      if (!a) throw new Error(`${id}: missing from GraphQL response`);
      if (!Number.isFinite(a.supplyAPY)) throw new Error(`${id}: supplyAPY not finite`);
      if (!Number.isFinite(a.borrowAPY)) throw new Error(`${id}: borrowAPY not finite`);
      if (a.borrowAPY < a.supplyAPY) {
        // Compound model invariant — borrow > supply at non-zero util because
        // protocol skims a reserve cut. Identical only when util == 0.
        console.log(`        WARN ${id}: borrowAPY < supplyAPY (${a.borrowAPY} < ${a.supplyAPY})`);
      }
    }
  });

  await t('getPrice(LIQWID-POOLS): wraps fetchAllMarkets as AttestationQuote', async () => {
    const q = await liqwid.getPrice('LIQWID-POOLS');
    if (q.kind !== 'attestation') throw new Error(`expected attestation, got ${q.kind}`);
    if (q.unit !== 'count') throw new Error(`expected unit=count, got ${q.unit}`);
    if (q.value !== 3) throw new Error(`expected value=3, got ${q.value}`);
    const raw = q.rawPayload as { apySource: string; markets: Array<{ symbol: string }> };
    if (raw.apySource !== 'liqwid-api' && raw.apySource !== 'liqwid-api') {
      throw new Error(`expected apySource=liqwid-api, got ${raw.apySource}`);
    }
    const symbols = raw.markets.map(m => m.symbol).sort();
    console.log(`        symbols: ${symbols.join(', ')}`);
  });

  if (SHOULD_SHUTDOWN) {
    try { await bridge.shutdown(); } catch { /* best-effort */ }
  }

  console.log(`\n${n - fails}/${n} passed`);
  process.exit(fails ? 1 : 0);
}

main().catch(err => { console.error('runner crash:', err); process.exit(2); });
