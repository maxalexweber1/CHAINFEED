/**
 * Unit tests for the watcher's pure diff layer (agents/watcher/diff.ts).
 *
 * No server, no MCP, no filesystem — these test the alert policy in isolation.
 * Run: npx tsx scripts/test-watcher-diff.ts
 */

import assert from 'node:assert/strict';
import { diffObservation, observationFromAssessment } from '../agents/watcher/diff.js';
import type { Observation } from '../agents/watcher/state.js';
import type { AssessmentResponse, Verdict } from '../agents/shared/types.js';

let n = 0, fails = 0;
function t(name: string, fn: () => void) {
  n++;
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) { fails++; console.log(`FAIL  ${name}\n      ${(e as Error).stack || (e as Error).message}`); }
}

/** Minimal AssessmentResponse for diff-layer tests (other fields irrelevant). */
function mkAssessment(verdict: Verdict, reasonCodes: string[]): AssessmentResponse {
  return {
    symbol: 'USDM',
    verdict,
    headline: `USDM: synthetic test headline (${verdict})`,
    reasonCodes,
    reasons: reasonCodes,
    suggestedActions: [],
    assessmentConfidence: 0.9,
    riskScore: verdict === 'ok' ? 0.85 : verdict === 'caution' ? 0.55 : 0.25,
    computedAt: '2026-05-25T10:00:00.000Z',
  };
}

function mkObservation(verdict: Verdict, reasonCodes: string[]): Observation {
  return {
    verdict,
    reasonCodes,
    riskScore: verdict === 'ok' ? 0.85 : verdict === 'caution' ? 0.55 : 0.25,
    computedAt: '2026-05-25T09:59:00.000Z',
    observedAt: '2026-05-25T09:59:01.000Z',
  };
}

console.log('watcher-diff ────────────────────────────────────────────');

t('first observation → no event (silent seed)', () => {
  const evt = diffObservation('USDM', mkAssessment('caution', ['peg-deviation-high']), undefined);
  assert.equal(evt, null);
});

t('same verdict + same reasonCodes → no event', () => {
  const prev = mkObservation('caution', ['attestation-stale']);
  const fresh = mkAssessment('caution', ['attestation-stale']);
  assert.equal(diffObservation('USDM', fresh, prev), null);
});

t('verdict ok → caution → degraded event with both reason lists', () => {
  const prev = mkObservation('ok', []);
  const fresh = mkAssessment('caution', ['attestation-stale']);
  const evt = diffObservation('USDM', fresh, prev);
  assert.ok(evt);
  assert.equal(evt!.severity, 'degraded');
  assert.equal(evt!.previousVerdict, 'ok');
  assert.equal(evt!.currentVerdict, 'caution');
  assert.deepEqual(evt!.addedReasonCodes, ['attestation-stale']);
  assert.deepEqual(evt!.removedReasonCodes, []);
});

t('verdict caution → ok → recovered event', () => {
  const prev = mkObservation('caution', ['peg-deviation-high']);
  const fresh = mkAssessment('ok', []);
  const evt = diffObservation('USDM', fresh, prev);
  assert.equal(evt?.severity, 'recovered');
  assert.deepEqual(evt!.removedReasonCodes, ['peg-deviation-high']);
});

t('verdict alert → caution → recovered (still negative but improving)', () => {
  const prev = mkObservation('alert', ['peg-deviation-critical']);
  const fresh = mkAssessment('caution', ['peg-deviation-high']);
  const evt = diffObservation('USDM', fresh, prev);
  assert.equal(evt?.severity, 'recovered');
  assert.equal(evt!.previousVerdict, 'alert');
  assert.equal(evt!.currentVerdict, 'caution');
});

t('verdict ok → alert → degraded (skipping a step)', () => {
  const prev = mkObservation('ok', []);
  const fresh = mkAssessment('alert', ['peg-deviation-critical', 'price-source-missing']);
  const evt = diffObservation('USDM', fresh, prev);
  assert.equal(evt?.severity, 'degraded');
});

t('same verdict, new reasonCode added → same-verdict-new-reasons with addedReasonCodes', () => {
  const prev = mkObservation('caution', ['peg-deviation-high']);
  const fresh = mkAssessment('caution', ['peg-deviation-high', 'attestation-stale']);
  const evt = diffObservation('USDM', fresh, prev);
  assert.equal(evt?.severity, 'same-verdict-new-reasons');
  assert.deepEqual(evt!.addedReasonCodes, ['attestation-stale']);
  assert.deepEqual(evt!.removedReasonCodes, []);
});

t('same verdict, reasonCode disappeared → same-verdict-new-reasons with removedReasonCodes', () => {
  const prev = mkObservation('caution', ['peg-deviation-high', 'attestation-stale']);
  const fresh = mkAssessment('caution', ['peg-deviation-high']);
  const evt = diffObservation('USDM', fresh, prev);
  assert.equal(evt?.severity, 'same-verdict-new-reasons');
  assert.deepEqual(evt!.addedReasonCodes, []);
  assert.deepEqual(evt!.removedReasonCodes, ['attestation-stale']);
});

t('same verdict, reasonCodes swapped → both added + removed populated', () => {
  const prev = mkObservation('caution', ['peg-deviation-high']);
  const fresh = mkAssessment('caution', ['attestation-stale']);
  const evt = diffObservation('USDM', fresh, prev);
  assert.equal(evt?.severity, 'same-verdict-new-reasons');
  assert.deepEqual(evt!.addedReasonCodes, ['attestation-stale']);
  assert.deepEqual(evt!.removedReasonCodes, ['peg-deviation-high']);
});

t('reasonCode ordering does not trigger an event (set equality)', () => {
  const prev = mkObservation('caution', ['a', 'b', 'c']);
  const fresh = mkAssessment('caution', ['c', 'a', 'b']);
  assert.equal(diffObservation('USDM', fresh, prev), null);
});

t('observationFromAssessment carries the right fields', () => {
  const fresh = mkAssessment('caution', ['x']);
  const now = new Date('2026-05-25T10:30:00.000Z');
  const obs = observationFromAssessment(fresh, now);
  assert.equal(obs.verdict, 'caution');
  assert.deepEqual(obs.reasonCodes, ['x']);
  assert.equal(obs.computedAt, '2026-05-25T10:00:00.000Z');
  assert.equal(obs.observedAt, '2026-05-25T10:30:00.000Z');
});

console.log(`\n${n - fails}/${n} passed`);
process.exit(fails ? 1 : 0);
