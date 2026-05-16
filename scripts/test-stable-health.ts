/**
 * `computeStableHealth` orchestration test — drives the synthesis function
 * directly with mocked fanout / attestation / supply dependencies. No
 * CDS boot, no real HTTP, just the pure orchestration logic.
 *
 * Coverage:
 *   - happy-path composition for an on-chain-attestation stable (USDM)
 *   - happy-path for an overcollateralized stable (DJED, ratio_pct path)
 *   - graceful degradation: each sub-fetch failing in turn should
 *     null-out the corresponding block, surface alerts, NOT throw
 *   - peg-deviation off-peg → bps + alert
 *   - missing reservesPair (USDA/USDCx today) → reserves.available=false
 *     + 'reserves-unsubstantiated' alert
 *
 * Run: npx tsx scripts/test-stable-health.ts
 */

import assert from 'node:assert/strict';
import { computeStableHealth } from '../srv/lib/stable-health';
import { STABLE_METADATA } from '../srv/lib/stable-metadata';
import type { PriceQuote, AttestationQuote } from '../srv/adapters/types';
import type { StableSupply } from '../srv/lib/stable-supply';
import type { FanoutLike, StableHealthDeps } from '../srv/lib/stable-health';

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

const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

// ── helpers ──────────────────────────────────────────────────────────
function priceQuote(source: string, pair: string, price: number, ts = Date.now()): PriceQuote {
  return { kind: 'price', sourceName: source, pair, price, timestamp: ts, rawPayload: { stub: true } };
}

function attestQuote(source: string, pair: string, value: number, unit: string, opts: {
  ts?: number; healthBucket?: string; txHash?: string;
} = {}): AttestationQuote {
  return {
    kind: 'attestation',
    sourceName: source,
    pair,
    value,
    unit,
    timestamp: opts.ts ?? Date.now(),
    txHash: opts.txHash,
    rawPayload: opts.healthBucket ? { healthBucket: opts.healthBucket } : { stub: true },
  };
}

function emptyFanout<Q>(): FanoutLike<Q> {
  return { quotes: [], errors: [] };
}

function buildDeps(overrides: Partial<StableHealthDeps>): StableHealthDeps {
  return {
    fanout: async () => emptyFanout(),
    attestationFanout: async () => emptyFanout(),
    fetchSupply: async (): Promise<StableSupply> => ({
      totalSupply: null, circulatingSupply: null, source: 'minswap-metrics', fetchedAt: Date.now(),
    }),
    log: () => {},
    now: () => Date.now(),
    ...overrides,
  };
}

async function main() {
console.log('stable-health orchestration ─────────────────────────────');

// ── happy path: USDM (on-chain attestation, fiat-custodial) ──────────
await t('USDM: on-chain attestation + 2x cover + fresh + 3 sources → score ≥ 0.85', async () => {
  const FROZEN_NOW = 1_800_000_000_000;
  const deps = buildDeps({
    fanout: async (pair: string) => {
      if (pair === 'ADA-USDM') return { quotes: [
        priceQuote('orcfax',  'ADA-USDM', 0.247, FROZEN_NOW - 60_000),
        priceQuote('charli3', 'ADA-USDM', 0.2475, FROZEN_NOW - 30_000),
        priceQuote('sundae',  'ADA-USDM', 0.246,  FROZEN_NOW - 10_000),
      ], errors: [] };
      if (pair === 'ADA-USD') return { quotes: [
        priceQuote('orcfax', 'ADA-USD', 0.247),
        priceQuote('minswap', 'ADA-USD', 0.2469),
        priceQuote('charli3', 'ADA-USD', 0.2471),
      ], errors: [] };
      return emptyFanout();
    },
    attestationFanout: async (pair: string) => {
      if (pair === 'USDM-RESERVES') return { quotes: [
        attestQuote('charli3', 'USDM-RESERVES', 30_000_000, 'usd', {
          ts: FROZEN_NOW - 2 * 60 * 60 * 1000,    // 2h fresh
          txHash: 'aa'.repeat(32),
        }),
      ], errors: [] };
      return emptyFanout();
    },
    fetchSupply: async () => ({
      totalSupply: 15_000_000, circulatingSupply: 14_500_000,
      source: 'minswap-metrics', fetchedAt: FROZEN_NOW,
    }),
    now: () => FROZEN_NOW,
  });

  const r = await computeStableHealth(STABLE_METADATA.USDM!, deps);

  assert.equal(r.symbol, 'USDM');
  assert.equal(r.metadata.peg, 'USD');
  assert.equal(r.metadata.backing, 'fiat-custodial');
  assert.equal(r.metadata.issuerName, 'Mehen');

  // Price block — median of [0.246, 0.247, 0.2475] = 0.247
  assert.equal(r.price.available, true);
  assert.equal(r.price.sourcesUsed, 3);
  assert.ok(r.price.value !== null && Math.abs(r.price.value - 0.247) < 0.001);

  // Reserves block
  assert.equal(r.reserves.available, true);
  assert.equal(r.reserves.source, 'on-chain-attestation');
  assert.equal(r.reserves.unit, 'usd');
  assert.equal(r.reserves.value, 30_000_000);
  assert.equal(r.reserves.txHash, 'aa'.repeat(32));
  // age ~ 2h
  assert.ok(r.reserves.ageMs !== null && Math.abs(r.reserves.ageMs - 2*60*60*1000) < 1000);

  // Supply block
  assert.equal(r.supply.available, true);
  assert.equal(r.supply.circulatingSupply, 14_500_000);

  // No liquidity dep injected → placeholder
  assert.equal(r.liquidity.available, false);
  assert.equal(r.liquidity.depthAda, null);

  // Risk score: ideal-ish (all components high)
  assert.ok(r.risk.score >= 0.85, `expected ≥ 0.85, got ${r.risk.score}`);
  // Components present and within [0, 1]
  for (const c of [r.risk.pegConfidence, r.risk.reserveAdequacy, r.risk.attestationFreshness, r.risk.sourceConfidence]) {
    assert.ok(c.value >= 0 && c.value <= 1);
  }

  // No critical alerts
  assert.equal(r.alerts.includes('peg-deviation-critical'), false);
  assert.equal(r.alerts.includes('reserves-unsubstantiated'), false);
});

// ── happy path: DJED (collateral aggregate, overcollateralized) ──────
await t('DJED: 260% coverage + small peg drift → reserves.unit=ratio_pct, healthBucket forwarded', async () => {
  const FROZEN_NOW = 1_800_000_000_000;
  const deps = buildDeps({
    fanout: async (pair: string) => {
      if (pair === 'ADA-DJED') return { quotes: [
        priceQuote('orcfax',     'ADA-DJED', 0.249),
        priceQuote('minswap-v2',  'ADA-DJED', 0.245),
      ], errors: [] };
      if (pair === 'ADA-USD') return { quotes: [
        priceQuote('orcfax', 'ADA-USD', 0.247),
      ], errors: [] };
      return emptyFanout();
    },
    attestationFanout: async (pair: string) => {
      if (pair === 'DJED-RESERVES') return { quotes: [
        attestQuote('djed-reserves', 'DJED-RESERVES', 260, 'ratio_pct', {
          ts: FROZEN_NOW - 60_000,
          healthBucket: 'alert',
        }),
      ], errors: [] };
      return emptyFanout();
    },
    fetchSupply: async () => ({
      totalSupply: 3_428_786, circulatingSupply: 3_428_786,
      source: 'minswap-metrics', fetchedAt: FROZEN_NOW,
    }),
    now: () => FROZEN_NOW,
  });

  const r = await computeStableHealth(STABLE_METADATA.DJED!, deps);

  assert.equal(r.symbol, 'DJED');
  assert.equal(r.reserves.available, true);
  assert.equal(r.reserves.source, 'on-chain-collateral-aggregate');
  assert.equal(r.reserves.unit, 'ratio_pct');
  assert.equal(r.reserves.value, 260);
  assert.equal(r.reserves.healthBucket, 'alert');

  // 260% < 400% (warn) but > 200% — no warning alert from us; the
  // adapter-level bucket is just informational. (Our alert thresholds
  // for stable-health are 200 / 110 — see srv/lib/stable-risk-score.ts.)
  assert.equal(r.alerts.includes('reserve-coverage-warning'), false);
  assert.equal(r.alerts.includes('reserve-coverage-critical'), false);
});

// ── reservesPair-less stable (USDA): unsubstantiated alert ───────────
await t('USDA: no reservesPair → reserves.available=false, reserves-unsubstantiated alert', async () => {
  const deps = buildDeps({
    fanout: async (pair: string) => ({
      quotes: pair === 'ADA-USDA' || pair === 'ADA-USD'
        ? [priceQuote('minswap-v2', pair, 0.247)] : [],
      errors: [],
    }),
    fetchSupply: async () => ({
      totalSupply: 8_650_000, circulatingSupply: 8_650_000,
      source: 'minswap-metrics', fetchedAt: Date.now(),
    }),
  });

  const r = await computeStableHealth(STABLE_METADATA.USDA!, deps);
  assert.equal(r.reserves.available, false);
  assert.equal(r.reserves.source, null);
  assert.ok(r.alerts.includes('reserves-unsubstantiated'),
    `expected reserves-unsubstantiated alert, got: ${r.alerts.join(',')}`);
  // Reserve adequacy stays neutral 0.5
  assert.equal(r.risk.reserveAdequacy.value, 0.5);
});

// ── peg deviation surfaces correctly ─────────────────────────────────
await t('off-peg by 200 bps → pegDeviationBps surfaces + peg-deviation-high alert', async () => {
  const deps = buildDeps({
    fanout: async (pair: string) => {
      if (pair === 'ADA-USDM') return { quotes: [
        priceQuote('orcfax', 'ADA-USDM', 0.252),    // USDM cheaper than peg
      ], errors: [] };
      if (pair === 'ADA-USD') return { quotes: [
        priceQuote('orcfax', 'ADA-USD', 0.247),
      ], errors: [] };
      return emptyFanout();
    },
    attestationFanout: async () => ({
      quotes: [attestQuote('charli3', 'USDM-RESERVES', 14_500_000, 'usd', { ts: Date.now() - 60_000 })],
      errors: [],
    }),
    fetchSupply: async () => ({ totalSupply: 14_500_000, circulatingSupply: 14_500_000, source: 'minswap-metrics', fetchedAt: Date.now() }),
  });

  const r = await computeStableHealth(STABLE_METADATA.USDM!, deps);
  // ada-usd / ada-usdm = 0.247/0.252 = 0.9802 → -198 bps (USDM below peg)
  assert.ok(r.pegDeviationBps !== null && r.pegDeviationBps < 0);
  assert.ok(close(r.pegDeviationBps!, -198.4, 1));
  assert.ok(r.alerts.includes('peg-deviation-high'),
    `expected peg-deviation-high alert, got: ${r.alerts.join(',')}`);
});

// ── graceful degradation: each sub-fetch failing in isolation ────────
await t('price fanout rejects → price.available=false, no throw', async () => {
  const deps = buildDeps({
    fanout: async (pair: string) => {
      if (pair === 'ADA-USDM') throw new Error('orcfax-down');
      if (pair === 'ADA-USD')  return { quotes: [priceQuote('orcfax', 'ADA-USD', 0.247)], errors: [] };
      return emptyFanout();
    },
    attestationFanout: async () => ({
      quotes: [attestQuote('charli3', 'USDM-RESERVES', 14_500_000, 'usd')],
      errors: [],
    }),
  });
  const r = await computeStableHealth(STABLE_METADATA.USDM!, deps);
  assert.equal(r.price.available, false);
  assert.equal(r.price.value, null);
  assert.equal(r.pegDeviationBps, null);     // can't compute without pair price
  // Price-source-related alerts present
  assert.ok(r.alerts.includes('peg-deviation-unknown') || r.alerts.includes('price-source-missing'));
});

await t('attestation fanout rejects → reserves.available=false', async () => {
  const deps = buildDeps({
    fanout: async (pair: string) => ({
      quotes: [priceQuote('orcfax', pair, 0.247)], errors: [],
    }),
    attestationFanout: async () => { throw new Error('koios-down'); },
    fetchSupply: async () => ({ totalSupply: 14_500_000, circulatingSupply: 14_500_000, source: 'minswap-metrics', fetchedAt: Date.now() }),
  });
  const r = await computeStableHealth(STABLE_METADATA.USDM!, deps);
  assert.equal(r.reserves.available, false);
  // Price still works
  assert.equal(r.price.available, true);
});

await t('supply fetcher rejects → supply.available=false, rest still works', async () => {
  const deps = buildDeps({
    fanout: async (pair: string) => ({
      quotes: [priceQuote('orcfax', pair, 0.247)], errors: [],
    }),
    attestationFanout: async () => ({
      quotes: [attestQuote('charli3', 'USDM-RESERVES', 14_500_000, 'usd', { ts: Date.now() - 60_000 })],
      errors: [],
    }),
    fetchSupply: async () => { throw new Error('minswap-down'); },
  });
  const r = await computeStableHealth(STABLE_METADATA.USDM!, deps);
  assert.equal(r.supply.available, false);
  assert.equal(r.price.available, true);
  assert.equal(r.reserves.available, true);
});

await t('all sub-fetches fail → response still valid, full alert set', async () => {
  const deps = buildDeps({
    fanout: async () => { throw new Error('all-down'); },
    attestationFanout: async () => { throw new Error('all-down'); },
    fetchSupply: async () => { throw new Error('all-down'); },
  });
  const r = await computeStableHealth(STABLE_METADATA.USDM!, deps);
  assert.equal(r.price.available, false);
  assert.equal(r.reserves.available, false);
  assert.equal(r.supply.available, false);
  assert.ok(r.alerts.length > 0);
  // Score should be the neutral 0.5 area (no signal in either direction)
  assert.ok(r.risk.score >= 0.4 && r.risk.score <= 0.6,
    `expected neutral score with no data, got ${r.risk.score}`);
});

// ── USDCx with off-chain Circle attestation (Day 9) ──────────────────
await t('USDCx: off-chain attestation-binary → reserves.source=off-chain-pdf, reserveAdequacy=0.6', async () => {
  const FROZEN_NOW = 1_800_000_000_000;
  const deps = buildDeps({
    fanout: async (pair: string) => ({
      quotes: pair === 'ADA-USDCx' || pair === 'ADA-USD'
        ? [priceQuote('orcfax', pair, 0.247, FROZEN_NOW - 60_000)] : [],
      errors: [],
    }),
    attestationFanout: async (pair: string) => {
      if (pair === 'USDCx-ATTESTATION') return { quotes: [
        attestQuote('circle-usdc-attestation', 'USDCx-ATTESTATION', 1.0, 'attestation-binary', {
          ts: FROZEN_NOW - 5 * 24 * 60 * 60 * 1000,    // 5 days ago = within "fresh" window
        }),
      ], errors: [] };
      return emptyFanout();
    },
    fetchSupply: async () => ({
      totalSupply: 17_557_521, circulatingSupply: 17_557_521,
      source: 'minswap-metrics', fetchedAt: FROZEN_NOW,
    }),
    now: () => FROZEN_NOW,
  });

  const r = await computeStableHealth(STABLE_METADATA.USDCx!, deps);
  assert.equal(r.reserves.available, true);
  assert.equal(r.reserves.source, 'off-chain-pdf');
  assert.equal(r.reserves.unit, 'attestation-binary');
  assert.equal(r.reserves.value, 1.0);
  // 5 days old → just inside stale window (>24h cliff but well under 7d cliff)
  assert.ok(r.reserves.ageMs! > 24 * 60 * 60 * 1000);
  assert.ok(r.reserves.ageMs! < 7 * 24 * 60 * 60 * 1000);
  // Reserve adequacy = 0.6 fixed (binary attestation present)
  assert.equal(r.risk.reserveAdequacy.value, 0.6);
  // No 'reserves-unsubstantiated' alert anymore — attestation IS now substantiated
  assert.equal(r.alerts.includes('reserves-unsubstantiated'), false);
});

// ── Liquidity probe injection ────────────────────────────────────────
await t('liquidity probe wired in → liquidity block populated', async () => {
  const deps = buildDeps({
    fanout: async (pair: string) => ({
      quotes: [priceQuote('orcfax', pair, 0.247)], errors: [],
    }),
    attestationFanout: async () => ({
      quotes: [attestQuote('charli3', 'USDM-RESERVES', 14_500_000, 'usd', { ts: Date.now() - 60_000 })],
      errors: [],
    }),
    fetchSupply: async () => ({ totalSupply: 14_500_000, circulatingSupply: 14_500_000, source: 'minswap-metrics', fetchedAt: Date.now() }),
    fetchLiquidityDepth: async (tokenId: string) => {
      // Verify the orchestrator passes the right token-id (policy + assetName).
      assert.equal(tokenId, STABLE_METADATA.USDM!.policyId + STABLE_METADATA.USDM!.assetNameHex);
      return {
        marginalPrice: 0.247,
        midPrice: 0.247,
        depthAda: 50_000,
        depthAtMaxProbed: false,
        routingMonotone: true,
        targetSlippagePct: 1.0,
        probedPoints: [
          { amountAda: 100,    effectivePrice: 0.247, slippagePct: 0 },
          { amountAda: 1000,   effectivePrice: 0.246, slippagePct: 0.4 },
          { amountAda: 10000,  effectivePrice: 0.244, slippagePct: 1.2 },
          { amountAda: 100000, effectivePrice: 0.234, slippagePct: 5.3 },
          { amountAda: 1_000_000, effectivePrice: 0.20, slippagePct: 19 },
        ],
        pools: [
          { source: 'minswap-v2', adaReserve: 4_000_000, tokenReserve: 1_000_000 },
          { source: 'wingriders', adaReserve: 2_000_000, tokenReserve:   500_000 },
        ],
      };
    },
  });
  const r = await computeStableHealth(STABLE_METADATA.USDM!, deps);
  assert.equal(r.liquidity.available, true);
  assert.equal(r.liquidity.midPrice, 0.247);
  assert.equal(r.liquidity.depthAda, 50_000);
  assert.equal(r.liquidity.depthAtMaxProbed, false);
  assert.equal(r.liquidity.routingMonotone, true);
  assert.equal(r.liquidity.targetSlippagePct, 1.0);
  assert.equal(r.liquidity.probedPointsCount, 5);
});

await t('liquidity probe rejects → liquidity block degrades to all-nulls', async () => {
  const deps = buildDeps({
    fanout: async (pair: string) => ({
      quotes: [priceQuote('orcfax', pair, 0.247)], errors: [],
    }),
    fetchLiquidityDepth: async () => { throw new Error('liquidity-depth-down'); },
  });
  const r = await computeStableHealth(STABLE_METADATA.USDM!, deps);
  assert.equal(r.liquidity.available, false);
  assert.equal(r.liquidity.depthAda, null);
  assert.equal(r.liquidity.midPrice, null);
  // Other blocks unaffected by liquidity failure.
  assert.equal(r.price.available, true);
});

console.log(`\n${n - fails}/${n} passed`);
process.exit(fails ? 1 : 0);
}

main().catch(err => { console.error('runner crash:', err); process.exit(2); });
