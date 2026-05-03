/**
 * Stable-health risk-score pure-function tests.
 *
 * Run: npx tsx scripts/test-stable-risk-score.ts
 */

import assert from 'node:assert/strict';
import {
  pegConfidenceScore, reserveAdequacyScore, attestationFreshnessScore,
  sourceConfidenceScore, alertsFor, computeRiskScore,
  type RiskScoreInputs,
} from '../srv/lib/stable-risk-score';

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

const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

console.log('stable-risk-score ───────────────────────────────────────');

// ── pegConfidenceScore ────────────────────────────────────────────────
t('pegConfidence: 0 bps → 1.0', () => {
  assert.equal(pegConfidenceScore(0), 1);
});
t('pegConfidence: ±200 bps → 0.0 (cliff)', () => {
  assert.equal(pegConfidenceScore(200), 0);
  assert.equal(pegConfidenceScore(-200), 0);
});
t('pegConfidence: 100 bps → 0.5 (linear midpoint)', () => {
  assert.ok(close(pegConfidenceScore(100), 0.5));
  assert.ok(close(pegConfidenceScore(-100), 0.5));
});
t('pegConfidence: > 200 bps clamped at 0', () => {
  assert.equal(pegConfidenceScore(2400), 0);   // Wanchain USDT off-peg ≈ +2400 bps
});
t('pegConfidence: null → 0.5 neutral', () => {
  assert.equal(pegConfidenceScore(null), 0.5);
});

// ── reserveAdequacyScore ─────────────────────────────────────────────
t('reserveAdequacy: overcollateralized at 100% ratio → 0', () => {
  assert.equal(reserveAdequacyScore({
    reservesKind: 'on-chain-collateral-aggregate',
    reservesValue: 100,
    circulatingSupplyUsd: null,
  }), 0);
});
t('reserveAdequacy: overcollateralized at 500% → 1.0', () => {
  assert.equal(reserveAdequacyScore({
    reservesKind: 'on-chain-collateral-aggregate',
    reservesValue: 500,
    circulatingSupplyUsd: null,
  }), 1);
});
t('reserveAdequacy: overcollateralized at 260% (DJED live) → 0.4', () => {
  // (260 - 100) / 400 = 0.4
  assert.ok(close(reserveAdequacyScore({
    reservesKind: 'on-chain-collateral-aggregate',
    reservesValue: 260,
    circulatingSupplyUsd: null,
  }), 0.4));
});
t('reserveAdequacy: overcollateralized at 50% → 0 (clamped)', () => {
  assert.equal(reserveAdequacyScore({
    reservesKind: 'on-chain-collateral-aggregate',
    reservesValue: 50,
    circulatingSupplyUsd: null,
  }), 0);
});
t('reserveAdequacy: on-chain attestation 1.0× cover → 0.5', () => {
  assert.equal(reserveAdequacyScore({
    reservesKind: 'on-chain-attestation',
    reservesValue: 14_500_000,
    circulatingSupplyUsd: 14_500_000,
  }), 0.5);
});
t('reserveAdequacy: on-chain attestation 2.0× cover → 1.0', () => {
  assert.equal(reserveAdequacyScore({
    reservesKind: 'on-chain-attestation',
    reservesValue: 30_000_000,
    circulatingSupplyUsd: 15_000_000,
  }), 1);
});
t('reserveAdequacy: on-chain attestation 0.5× cover → 0.25', () => {
  assert.equal(reserveAdequacyScore({
    reservesKind: 'on-chain-attestation',
    reservesValue:    7_500_000,
    circulatingSupplyUsd: 15_000_000,
  }), 0.25);
});
t('reserveAdequacy: off-chain PDF capped at 0.85 even at 10× cover', () => {
  assert.ok(reserveAdequacyScore({
    reservesKind: 'off-chain-pdf',
    reservesValue: 100_000_000,
    circulatingSupplyUsd: 10_000_000,
  }) <= 0.85);
});
t('reserveAdequacy: off-chain PDF with no parsed value (binary attestation) → 0.6', () => {
  // Circle/BitGo PDFs that we hash-seal but don't parse the body of.
  // Adapter signals via value=1.0 (the binary "attestation present" flag).
  assert.equal(reserveAdequacyScore({
    reservesKind: 'off-chain-pdf',
    reservesValue: 1.0,
    circulatingSupplyUsd: 14_500_000,
  }), 0.6);
  // Also accepts null reservesValue for the same path
  assert.equal(reserveAdequacyScore({
    reservesKind: 'off-chain-pdf',
    reservesValue: null,
    circulatingSupplyUsd: 14_500_000,
  }), 0.6);
});
t('reserveAdequacy: none → 0.5 neutral', () => {
  assert.equal(reserveAdequacyScore({
    reservesKind: 'none',
    reservesValue: null,
    circulatingSupplyUsd: null,
  }), 0.5);
});
t('reserveAdequacy: missing supply for attestation → 0.5 fallback', () => {
  assert.equal(reserveAdequacyScore({
    reservesKind: 'on-chain-attestation',
    reservesValue: 14_500_000,
    circulatingSupplyUsd: null,
  }), 0.5);
});

// ── attestationFreshnessScore ────────────────────────────────────────
t('attestationFreshness: 1 hour → 1.0', () => {
  assert.equal(attestationFreshnessScore(60 * 60 * 1000), 1.0);
});
t('attestationFreshness: 24h cliff still 1.0', () => {
  assert.equal(attestationFreshnessScore(24 * 60 * 60 * 1000), 1.0);
});
t('attestationFreshness: 7d cliff = 0.5', () => {
  assert.ok(close(attestationFreshnessScore(7 * 24 * 60 * 60 * 1000), 0.5, 1e-3));
});
t('attestationFreshness: 30d → 0', () => {
  assert.equal(attestationFreshnessScore(30 * 24 * 60 * 60 * 1000), 0);
});
t('attestationFreshness: 60d → 0 (clamped)', () => {
  assert.equal(attestationFreshnessScore(60 * 24 * 60 * 60 * 1000), 0);
});
t('attestationFreshness: null → 0.5 neutral', () => {
  assert.equal(attestationFreshnessScore(null), 0.5);
});

// ── sourceConfidenceScore ────────────────────────────────────────────
t('sourceConfidence: 1.0 with 1 source → 1.0', () => {
  assert.equal(sourceConfidenceScore(1.0, 1), 1.0);
});
t('sourceConfidence: 0.95 with 3 sources → boosted to 0.9975', () => {
  assert.ok(close(sourceConfidenceScore(0.95, 3), Math.min(1, 0.95 * 1.05), 1e-6));
});
t('sourceConfidence: 0.4 → 0.4 (no boost <0.5)', () => {
  assert.equal(sourceConfidenceScore(0.4, 5), 0.4 * 1.05);
});
t('sourceConfidence: null → 0.5 neutral', () => {
  assert.equal(sourceConfidenceScore(null, 0), 0.5);
});

// ── alertsFor ────────────────────────────────────────────────────────
t('alerts: peg breaks at 100/500 bps', () => {
  const lo = alertsFor({
    backing: 'fiat-custodial', pegDeviationBps: 50,
    priceSourceConfidence: 1, priceSourcesUsed: 3,
    reservesKind: 'on-chain-attestation', reservesValue: 1, circulatingSupplyUsd: 1,
    attestationAgeMs: 60_000,
  });
  assert.ok(!lo.includes('peg-deviation-high') && !lo.includes('peg-deviation-critical'));

  const hi = alertsFor({
    backing: 'fiat-custodial', pegDeviationBps: 250,
    priceSourceConfidence: 1, priceSourcesUsed: 3,
    reservesKind: 'on-chain-attestation', reservesValue: 1, circulatingSupplyUsd: 1,
    attestationAgeMs: 60_000,
  });
  assert.ok(hi.includes('peg-deviation-high'));
  assert.ok(!hi.includes('peg-deviation-critical'));

  const cr = alertsFor({
    backing: 'fiat-custodial', pegDeviationBps: 2400,
    priceSourceConfidence: 1, priceSourcesUsed: 3,
    reservesKind: 'on-chain-attestation', reservesValue: 1, circulatingSupplyUsd: 1,
    attestationAgeMs: 60_000,
  });
  assert.ok(cr.includes('peg-deviation-critical'));
});

t('alerts: overcollateralized coverage thresholds', () => {
  const ok = alertsFor({
    backing: 'overcollateralized-ada', pegDeviationBps: 0,
    priceSourceConfidence: 1, priceSourcesUsed: 3,
    reservesKind: 'on-chain-collateral-aggregate', reservesValue: 500, circulatingSupplyUsd: null,
    attestationAgeMs: 60_000,
  });
  assert.ok(!ok.includes('reserve-coverage-warning'));

  const warn = alertsFor({
    backing: 'overcollateralized-ada', pegDeviationBps: 0,
    priceSourceConfidence: 1, priceSourcesUsed: 3,
    reservesKind: 'on-chain-collateral-aggregate', reservesValue: 180, circulatingSupplyUsd: null,
    attestationAgeMs: 60_000,
  });
  assert.ok(warn.includes('reserve-coverage-warning'));

  const crit = alertsFor({
    backing: 'overcollateralized-ada', pegDeviationBps: 0,
    priceSourceConfidence: 1, priceSourcesUsed: 3,
    reservesKind: 'on-chain-collateral-aggregate', reservesValue: 100, circulatingSupplyUsd: null,
    attestationAgeMs: 60_000,
  });
  assert.ok(crit.includes('reserve-coverage-critical'));
});

t('alerts: fiat-custodial without on-chain attestation → reserves-unsubstantiated', () => {
  const a = alertsFor({
    backing: 'fiat-custodial', pegDeviationBps: 0,
    priceSourceConfidence: 1, priceSourcesUsed: 3,
    reservesKind: 'none', reservesValue: null, circulatingSupplyUsd: null,
    attestationAgeMs: null,
  });
  assert.ok(a.includes('reserves-unsubstantiated'));
});

t('alerts: overcollateralized without source → reserves-source-missing (shouldn\'t happen post-Sprint-1)', () => {
  const a = alertsFor({
    backing: 'overcollateralized-cdp', pegDeviationBps: 0,
    priceSourceConfidence: 1, priceSourcesUsed: 3,
    reservesKind: 'none', reservesValue: null, circulatingSupplyUsd: null,
    attestationAgeMs: null,
  });
  assert.ok(a.includes('reserves-source-missing'));
});

t('alerts: stale + overdue attestation age', () => {
  const stale = alertsFor({
    backing: 'fiat-custodial', pegDeviationBps: 0,
    priceSourceConfidence: 1, priceSourcesUsed: 3,
    reservesKind: 'on-chain-attestation', reservesValue: 1, circulatingSupplyUsd: 1,
    attestationAgeMs: 10 * 24 * 60 * 60 * 1000,        // 10 days
  });
  assert.ok(stale.includes('attestation-stale'));
  assert.ok(!stale.includes('attestation-overdue'));

  const overdue = alertsFor({
    backing: 'fiat-custodial', pegDeviationBps: 0,
    priceSourceConfidence: 1, priceSourcesUsed: 3,
    reservesKind: 'on-chain-attestation', reservesValue: 1, circulatingSupplyUsd: 1,
    attestationAgeMs: 45 * 24 * 60 * 60 * 1000,        // 45 days
  });
  assert.ok(overdue.includes('attestation-overdue'));
});

t('alerts: degraded price + missing sources', () => {
  const deg = alertsFor({
    backing: 'fiat-custodial', pegDeviationBps: 0,
    priceSourceConfidence: 0.3, priceSourcesUsed: 1,
    reservesKind: 'on-chain-attestation', reservesValue: 1, circulatingSupplyUsd: 1,
    attestationAgeMs: 60_000,
  });
  assert.ok(deg.includes('price-source-degraded'));

  const missing = alertsFor({
    backing: 'fiat-custodial', pegDeviationBps: null,
    priceSourceConfidence: null, priceSourcesUsed: 0,
    reservesKind: 'none', reservesValue: null, circulatingSupplyUsd: null,
    attestationAgeMs: null,
  });
  assert.ok(missing.includes('peg-deviation-unknown'));
  assert.ok(missing.includes('price-source-missing'));
});

// ── computeRiskScore composition ─────────────────────────────────────
t('computeRiskScore: ideal stable → ≥ 0.95', () => {
  const r = computeRiskScore({
    backing: 'fiat-custodial',
    pegDeviationBps: 5,                 // 5 bps off ≈ peg
    priceSourceConfidence: 0.99,
    priceSourcesUsed: 3,
    reservesKind: 'on-chain-attestation',
    reservesValue: 30_000_000,           // 2x cover
    circulatingSupplyUsd: 15_000_000,
    attestationAgeMs: 2 * 60 * 60 * 1000,  // 2 hours
  });
  assert.ok(r.score >= 0.95, `expected ≥ 0.95, got ${r.score}`);
  assert.equal(r.alerts.length, 0);
});

t('computeRiskScore: depegging stable → ≤ 0.5', () => {
  const r = computeRiskScore({
    backing: 'fiat-custodial',
    pegDeviationBps: 800,                // 8 % off — heavy depeg
    priceSourceConfidence: 0.6,
    priceSourcesUsed: 2,
    reservesKind: 'on-chain-attestation',
    reservesValue:    8_000_000,         // < 1x cover
    circulatingSupplyUsd: 15_000_000,
    attestationAgeMs: 12 * 24 * 60 * 60 * 1000,  // 12 days stale
  });
  assert.ok(r.score <= 0.5, `expected ≤ 0.5, got ${r.score}`);
  assert.ok(r.alerts.includes('peg-deviation-critical'));
  assert.ok(r.alerts.includes('attestation-stale'));
});

t('computeRiskScore: DJED-live snapshot (260% ratio, 30 bps off-peg, 24h fresh, 3 sources)', () => {
  const r = computeRiskScore({
    backing: 'overcollateralized-ada',
    pegDeviationBps: 30,                  // mild
    priceSourceConfidence: 0.95,
    priceSourcesUsed: 2,
    reservesKind: 'on-chain-collateral-aggregate',
    reservesValue: 260,
    circulatingSupplyUsd: null,
    attestationAgeMs: 60 * 60 * 1000,    // 1h
  });
  // peg=0.85, reserve=0.4, age=1.0, src=0.95
  // 0.45×0.85 + 0.30×0.4 + 0.15×1.0 + 0.10×0.95 = 0.3825 + 0.12 + 0.15 + 0.095 = 0.7475
  assert.ok(close(r.score, 0.7475, 0.01), `got ${r.score}`);
  assert.equal(r.alerts.length, 0);
});

t('computeRiskScore: components sum to score (within rounding)', () => {
  const inputs: RiskScoreInputs = {
    backing: 'fiat-custodial',
    pegDeviationBps: 50,
    priceSourceConfidence: 0.8,
    priceSourcesUsed: 2,
    reservesKind: 'on-chain-attestation',
    reservesValue: 18_000_000,
    circulatingSupplyUsd: 15_000_000,
    attestationAgeMs: 3 * 24 * 60 * 60 * 1000,
  };
  const r = computeRiskScore(inputs);
  const sum = r.components.pegConfidence.effective +
              r.components.reserveAdequacy.effective +
              r.components.attestationFreshness.effective +
              r.components.sourceConfidence.effective;
  assert.ok(close(r.score, sum, 1e-9));
  // Weights add to 1.0
  const wsum = r.components.pegConfidence.weight +
               r.components.reserveAdequacy.weight +
               r.components.attestationFreshness.weight +
               r.components.sourceConfidence.weight;
  assert.ok(close(wsum, 1.0));
});

t('computeRiskScore: score always within [0, 1]', () => {
  // Adversarial: terrible everywhere
  const bad = computeRiskScore({
    backing: 'algorithmic',
    pegDeviationBps: 99999,
    priceSourceConfidence: 0,
    priceSourcesUsed: 0,
    reservesKind: 'none',
    reservesValue: null,
    circulatingSupplyUsd: null,
    attestationAgeMs: 365 * 24 * 60 * 60 * 1000,
  });
  assert.ok(bad.score >= 0 && bad.score <= 1);
});

console.log(`\n${n - fails}/${n} passed`);
process.exit(fails ? 1 : 0);
