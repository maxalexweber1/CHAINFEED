/**
 * Stable-health judgment-layer (assessStableHealth) pure-function tests.
 *
 * Run: npx tsx scripts/test-stable-assessment.ts
 */

import assert from 'node:assert/strict';
import { assessStableHealth } from '../srv/lib/stable-assessment';
import type { StableHealthResult } from '../srv/lib/stable-health';

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

const HOUR = 60 * 60 * 1000;
const DAY  = 24 * HOUR;

/**
 * Baseline: a fully-healthy USD stable with every block available. Tests
 * override only the fields they exercise. Risk-score components are filled
 * consistently with `risk.score` so the score-threshold branches behave.
 */
function healthFixture(overrides: Partial<StableHealthResult> = {}): StableHealthResult {
  const base: StableHealthResult = {
    symbol: 'USDM',
    metadata: {
      symbol: 'USDM', peg: 'USD', backing: 'fiat-custodial',
      issuerName: 'Mehen', issuerJurisdiction: 'US', issuerCustodian: 'trust',
      policyId: 'aa', assetNameHex: 'bb', decimals: 6, liveSince: '2024-03-17',
    },
    price: { available: true, value: 1.0, sourcesUsed: 3, confidence: 0.97, deviationPct: 0.1 },
    pegDeviationBps: 12,
    reserves: {
      available: true, source: 'on-chain-attestation', value: 30_000_000,
      unit: 'usd', healthBucket: 'healthy', txHash: 'cc', ageMs: 4 * HOUR,
    },
    supply: { available: true, totalSupply: 15_000_000, circulatingSupply: 15_000_000 },
    liquidity: {
      available: true, midPrice: 1.0, depthAda: 500_000,
      depthAtMaxProbed: true, routingMonotone: true, targetSlippagePct: 1, probedPointsCount: 5,
    },
    risk: {
      score: 0.96,
      pegConfidence:        { value: 0.94, weight: 0.45, effective: 0.423 },
      reserveAdequacy:      { value: 1.0,  weight: 0.30, effective: 0.30 },
      attestationFreshness: { value: 1.0,  weight: 0.15, effective: 0.15 },
      sourceConfidence:     { value: 0.99, weight: 0.10, effective: 0.099 },
    },
    alerts: [],
    computedAt: new Date('2026-05-21T00:00:00Z').toISOString(),
  };
  return { ...base, ...overrides } as StableHealthResult;
}

console.log('stable-assessment ───────────────────────────────────────');

// ── verdict: ok ───────────────────────────────────────────────────────
t('verdict ok: healthy stable, no alerts, high score', () => {
  const a = assessStableHealth(healthFixture());
  assert.equal(a.verdict, 'ok');
  assert.equal(a.reasonCodes.length, 0);
  assert.deepEqual(a.suggestedActions, ['monitor']);
  assert.equal(a.riskScore, 0.96);
});

t('headline: factual one-liner with peg/reserves/sources', () => {
  const a = assessStableHealth(healthFixture());
  assert.equal(a.headline, 'USDM: 0.12% above peg; reserves on-chain-attestation (healthy), 4h old; 3 price sources.');
});

t('headline: below-peg direction + single source pluralisation', () => {
  const a = assessStableHealth(healthFixture({
    pegDeviationBps: -45,
    price: { available: true, value: 1, sourcesUsed: 1, confidence: 0.5, deviationPct: 0 },
  }));
  assert.ok(a.headline.includes('0.45% below peg'));
  assert.ok(a.headline.includes('1 price source.'));
});

// ── verdict: caution ──────────────────────────────────────────────────
t('verdict caution: peg-deviation-high alert', () => {
  const a = assessStableHealth(healthFixture({ alerts: ['peg-deviation-high'], pegDeviationBps: 150 }));
  assert.equal(a.verdict, 'caution');
  assert.ok(a.reasonCodes.includes('peg-deviation-high'));
  assert.ok(a.reasons.some(r => r.includes('1% off peg')));
  assert.ok(a.suggestedActions.includes('monitor'));
});

t('verdict caution: mid score (0.55) with no alerts', () => {
  const a = assessStableHealth(healthFixture({
    risk: { ...healthFixture().risk, score: 0.55 },
  }));
  assert.equal(a.verdict, 'caution');
  assert.ok(a.reasonCodes.includes('risk-score-low'));
});

t('verdict caution: reserves unavailable triggers caution + derived code', () => {
  const a = assessStableHealth(healthFixture({
    reserves: { available: false, source: null, value: null, unit: null, healthBucket: null, txHash: null, ageMs: null },
  }));
  assert.equal(a.verdict, 'caution');
  assert.ok(a.reasonCodes.includes('reserves-data-unavailable'));
  assert.ok(a.suggestedActions.includes('verify-reserves-manually'));
  assert.ok(a.headline.includes('reserves unverified'));
});

t('verdict caution: attestation-stale → verify-reserves-manually', () => {
  const a = assessStableHealth(healthFixture({
    alerts: ['attestation-stale'],
    reserves: { available: true, source: 'on-chain-attestation', value: 30_000_000, unit: 'usd', healthBucket: 'healthy', txHash: 'cc', ageMs: 10 * DAY },
  }));
  assert.equal(a.verdict, 'caution');
  assert.ok(a.suggestedActions.includes('verify-reserves-manually'));
});

// ── verdict: alert ────────────────────────────────────────────────────
t('verdict alert: peg-deviation-critical → reduce-exposure', () => {
  const a = assessStableHealth(healthFixture({
    alerts: ['peg-deviation-critical'],
    pegDeviationBps: 800,
    risk: { ...healthFixture().risk, score: 0.45 },
  }));
  assert.equal(a.verdict, 'alert');
  assert.equal(a.suggestedActions[0], 'reduce-exposure');
});

t('verdict alert: critically low score even without a critical alert', () => {
  const a = assessStableHealth(healthFixture({
    risk: { ...healthFixture().risk, score: 0.30 },
  }));
  assert.equal(a.verdict, 'alert');
  assert.ok(a.reasonCodes.includes('risk-score-critical'));
});

t('verdict alert: price-source-missing → retry-later + reduce-exposure', () => {
  const a = assessStableHealth(healthFixture({
    alerts: ['price-source-missing', 'peg-deviation-unknown'],
    pegDeviationBps: null,
    price: { available: false, value: null, sourcesUsed: 0, confidence: null, deviationPct: null },
    risk: { ...healthFixture().risk, score: 0.5 },
  }));
  assert.equal(a.verdict, 'alert');
  assert.ok(a.suggestedActions.includes('retry-later'));
  assert.ok(a.reasonCodes.includes('price-data-unavailable'));   // derived, price.available=false
  assert.ok(a.headline.includes('peg deviation unknown'));
});

// ── assessmentConfidence (distinct from riskScore) ───────────────────────
t('assessmentConfidence: full data + high source confidence → near 1.0', () => {
  const a = assessStableHealth(healthFixture());
  assert.ok(a.assessmentConfidence >= 0.98, `got ${a.assessmentConfidence}`);
});

t('assessmentConfidence: healthy stable but degraded single source → modest', () => {
  // riskScore stays high; assessmentConfidence must drop because the verdict
  // rests on one low-confidence source. This is the whole point of the split.
  const a = assessStableHealth(healthFixture({
    price: { available: true, value: 1, sourcesUsed: 1, confidence: 0.5, deviationPct: 0 },
  }));
  assert.equal(a.riskScore, 0.96);
  assert.ok(a.assessmentConfidence < 0.85, `expected < 0.85, got ${a.assessmentConfidence}`);
  assert.ok(a.assessmentConfidence > 0.5);
});

t('assessmentConfidence: price unavailable → low confidence in verdict', () => {
  const a = assessStableHealth(healthFixture({
    price: { available: false, value: null, sourcesUsed: 0, confidence: null, deviationPct: null },
  }));
  // completeness drops 0.5 (no price) and sourceFactor falls to 0.3
  assert.ok(a.assessmentConfidence <= 0.2, `expected ≤ 0.2, got ${a.assessmentConfidence}`);
});

// ── reasonCodes / reasons alignment ──────────────────────────────────────
t('reasons align 1:1 with reasonCodes', () => {
  const a = assessStableHealth(healthFixture({
    alerts: ['peg-deviation-high', 'attestation-stale'],
    pegDeviationBps: 150,
  }));
  assert.equal(a.reasons.length, a.reasonCodes.length);
  assert.ok(a.reasonCodes.length >= 2);
});

t('reasonCodes dedupe alerts ∪ derived (no duplicate when score-low also fires)', () => {
  const a = assessStableHealth(healthFixture({
    alerts: ['peg-deviation-high'],
    pegDeviationBps: 150,
    risk: { ...healthFixture().risk, score: 0.55 },
  }));
  const unique = new Set(a.reasonCodes);
  assert.equal(unique.size, a.reasonCodes.length);
  assert.ok(a.reasonCodes.includes('peg-deviation-high'));
  assert.ok(a.reasonCodes.includes('risk-score-low'));
});

t('verdict/score fields always in [0,1]', () => {
  for (const score of [0, 0.39, 0.4, 0.64, 0.65, 1]) {
    const a = assessStableHealth(healthFixture({ risk: { ...healthFixture().risk, score } }));
    assert.ok(a.assessmentConfidence >= 0 && a.assessmentConfidence <= 1);
    assert.ok(a.riskScore >= 0 && a.riskScore <= 1);
    assert.ok(['ok', 'caution', 'alert'].includes(a.verdict));
  }
});

console.log(`\n${n - fails}/${n} passed`);
process.exit(fails ? 1 : 0);
