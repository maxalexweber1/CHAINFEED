/**
 * Pure diff layer — given a fresh assessment and a previous observation,
 * decide whether to fire an alert and shape the event.
 *
 * Lives separately from the orchestrator (`index.ts`) because everything
 * downstream of the diff is side-effecting (writing state, calling sinks).
 * Pure-fn input/output is easy to unit-test once we add a `scripts/test-watcher-diff.ts`.
 *
 * Alert policy:
 *   - First observation (no prior state): NO event. Seed silently.
 *   - Verdict change in either direction: event with severity `degraded` | `recovered`.
 *   - Same verdict but reasonCodes set differs: event with severity
 *     `same-verdict-new-reasons`. This catches new alert IDs landing under an
 *     already-flagged stable (e.g. `attestation-stale` adds while still in
 *     `caution`) — those usually matter even though the headline verdict didn't move.
 */

import type { AssessmentResponse, Verdict } from '../shared/types.js';
import type { AlertEvent, Severity } from './sinks/types.js';
import type { Observation } from './state.js';

/** Verdict ordering for severity classification. Lower = better. */
const VERDICT_RANK: Record<Verdict, number> = { ok: 0, caution: 1, alert: 2 };

function reasonsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  for (const x of b) if (!set.has(x)) return false;
  return true;
}

function setDiff(a: readonly string[], b: readonly string[]): string[] {
  const bSet = new Set(b);
  return a.filter(x => !bSet.has(x));
}

function classify(prev: Verdict, curr: Verdict): Severity {
  if (prev === curr) return 'same-verdict-new-reasons';
  return VERDICT_RANK[curr] > VERDICT_RANK[prev] ? 'degraded' : 'recovered';
}

/**
 * Compare a fresh assessment against the previous observation.
 * Returns `null` if nothing alert-worthy changed (or this is the first observation).
 */
export function diffObservation(
  symbol: string,
  fresh: AssessmentResponse,
  previous: Observation | undefined,
): AlertEvent | null {
  // First-ever observation: seed silently.
  if (!previous) return null;

  const verdictChanged = previous.verdict !== fresh.verdict;
  const reasonsChanged = !reasonsEqual(previous.reasonCodes, fresh.reasonCodes);
  if (!verdictChanged && !reasonsChanged) return null;

  return {
    symbol,
    severity:           classify(previous.verdict, fresh.verdict),
    previousVerdict:    previous.verdict,
    currentVerdict:     fresh.verdict,
    previousReasonCodes: [...previous.reasonCodes],
    currentReasonCodes:  [...fresh.reasonCodes],
    addedReasonCodes:    setDiff(fresh.reasonCodes,    previous.reasonCodes),
    removedReasonCodes:  setDiff(previous.reasonCodes, fresh.reasonCodes),
    headline:             fresh.headline,
    riskScore:            fresh.riskScore,
    assessmentConfidence: fresh.assessmentConfidence,
    computedAt:           fresh.computedAt,
  };
}

/** Lift a fresh assessment into the persisted-observation shape. Pure. */
export function observationFromAssessment(fresh: AssessmentResponse, now: Date = new Date()): Observation {
  return {
    verdict:     fresh.verdict,
    reasonCodes: [...fresh.reasonCodes],
    riskScore:   fresh.riskScore,
    computedAt:  fresh.computedAt,
    observedAt:  now.toISOString(),
  };
}
