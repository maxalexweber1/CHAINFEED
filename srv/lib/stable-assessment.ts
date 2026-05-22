/**
 * Stable-health *judgment* layer — pure function, no I/O.
 *
 * `computeStableHealth()` (srv/lib/stable-health.ts) gathers the metrics;
 * `computeRiskScore()` (srv/lib/stable-risk-score.ts) already emits
 * string-stable alert IDs. This module sits on top of that output and turns
 * it into an actionable VERDICT so an agent doesn't have to re-derive
 * thresholds in its own context window (expensive, and where LLMs invent
 * numbers). It fetches nothing and recomputes nothing — pure derivation
 * from a `StableHealthResult`.
 *
 * Two scores, deliberately distinct — agents conflate them otherwise:
 *   - `riskScore`            : how HEALTHY the stable is (echo of detail.risk.score).
 *   - `assessmentConfidence` : how much we trust OUR OWN verdict, given how
 *                              complete the underlying data was this cycle.
 *     A perfectly-healthy stable assessed off one degraded price source
 *     gets a high riskScore but a modest assessmentConfidence.
 *
 * `reasonCodes` reuses the alert-ID vocabulary (machine-matchable, no
 * prose-parsing) and adds a few derived codes; `reasons` is their human
 * expansion. `suggestedActions` is a small closed enum.
 */

import type { StableHealthResult } from './stable-health';

export type Verdict = 'ok' | 'caution' | 'alert';

export type SuggestedAction =
  | 'reduce-exposure'
  | 'verify-reserves-manually'
  | 'retry-later'
  | 'monitor';

export interface StableAssessment {
  symbol: string;
  /** 'ok' | 'caution' | 'alert' — string-stable, same discipline as alert IDs. */
  verdict: Verdict;
  /** One human sentence summarising the state. */
  headline: string;
  /** Driving codes (alert IDs ∪ derived codes) — match these, don't parse prose. */
  reasonCodes: string[];
  /** Human expansion of each reasonCode, same order. */
  reasons: string[];
  /** Closed enum of recommended next steps. */
  suggestedActions: SuggestedAction[];
  /** [0,1] — confidence in THIS verdict, driven by data completeness. */
  assessmentConfidence: number;
  /** [0,1] — echo of detail.risk.score (health of the stable itself). */
  riskScore: number;
  computedAt: string;
}

// ── Code → severity classification ───────────────────────────────────────
// Critical codes force 'alert'; caution codes force (at least) 'caution'.
// Risk-score thresholds are checked numerically alongside these.
const CRITICAL_CODES: ReadonlySet<string> = new Set([
  'peg-deviation-critical',
  'reserve-coverage-critical',
  'price-source-missing',
]);

const CAUTION_CODES: ReadonlySet<string> = new Set([
  'peg-deviation-high',
  'peg-deviation-unknown',
  'reserve-coverage-warning',
  'attestation-stale',
  'attestation-overdue',
  'reserves-unsubstantiated',
  'reserves-source-missing',
  'price-source-degraded',
]);

const RISK_ALERT_THRESHOLD   = 0.40;
const RISK_CAUTION_THRESHOLD  = 0.65;

// Human text for every code we can emit. Falls back to the raw code if a
// new alert ID lands in stable-risk-score.ts before this map is updated.
const CODE_DESCRIPTIONS: Readonly<Record<string, string>> = Object.freeze({
  // alert IDs (from stable-risk-score.ts:alertsFor)
  'peg-deviation-critical':   'Price is more than 5% off peg.',
  'peg-deviation-high':       'Price is more than 1% off peg.',
  'peg-deviation-unknown':    'Peg deviation could not be computed (missing ADA-USD or pair price).',
  'reserve-coverage-critical':'On-chain collateral coverage is below 110%.',
  'reserve-coverage-warning': 'On-chain collateral coverage is below 200%.',
  'reserves-source-missing':  'No reserves source is available for this stable.',
  'reserves-unsubstantiated': 'Issuer publishes no fetchable proof-of-reserves.',
  'attestation-stale':        'Reserves attestation is more than 7 days old.',
  'attestation-overdue':      'Reserves attestation is more than 30 days old.',
  'price-source-degraded':    'Price is from a single or low-confidence source.',
  'price-source-missing':     'No price source returned a quote.',
  // derived codes (this module)
  'risk-score-critical':      'Composite risk score is critically low.',
  'risk-score-low':           'Composite risk score is below the comfort threshold.',
  'price-data-unavailable':   'Price data could not be fetched this cycle.',
  'reserves-data-unavailable':'Reserves data could not be fetched this cycle.',
});

// Stable output order for suggestedActions regardless of insertion order.
const ACTION_ORDER: readonly SuggestedAction[] = [
  'reduce-exposure',
  'verify-reserves-manually',
  'retry-later',
  'monitor',
];

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
const round4  = (x: number): number => Math.round(x * 1e4) / 1e4;

/** ms → compact human age: "45m", "4h", "12d". */
function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  if (ms < 60 * 60 * 1000)        return `${Math.max(1, Math.round(ms / 60_000))}m`;
  if (ms < 48 * 60 * 60 * 1000)   return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

/**
 * Collect derived codes not represented by an alert — keeps reasonCodes
 * complete without duplicating what alertsFor() already emits.
 */
function derivedCodes(health: StableHealthResult): string[] {
  const out: string[] = [];
  const score = health.risk.score;

  if (score < RISK_ALERT_THRESHOLD) out.push('risk-score-critical');
  else if (score < RISK_CAUTION_THRESHOLD) out.push('risk-score-low');

  if (!health.price.available) out.push('price-data-unavailable');

  // Reserves fetch failed for a stable that has no reserves-* alert flagged
  // (those alerts only fire for known "no source" / coverage cases — a transient
  // fetch failure leaves reserves.available false with no alert).
  const hasReservesAlert = health.alerts.some(a => a.startsWith('reserve'));
  if (!health.reserves.available && !hasReservesAlert) out.push('reserves-data-unavailable');

  return out;
}

function deriveVerdict(allCodes: ReadonlySet<string>, health: StableHealthResult): Verdict {
  const score = health.risk.score;
  let isCritical = score < RISK_ALERT_THRESHOLD;
  let isCaution  = score < RISK_CAUTION_THRESHOLD || !health.reserves.available;
  for (const c of allCodes) {
    if (CRITICAL_CODES.has(c)) isCritical = true;
    else if (CAUTION_CODES.has(c)) isCaution = true;
  }
  if (isCritical) return 'alert';
  if (isCaution)  return 'caution';
  return 'ok';
}

function suggestedActionsFor(verdict: Verdict, allCodes: ReadonlySet<string>): SuggestedAction[] {
  const out = new Set<SuggestedAction>();
  if (verdict === 'alert') out.add('reduce-exposure');
  for (const c of allCodes) {
    if (c.startsWith('reserve') || c.startsWith('attestation-')) out.add('verify-reserves-manually');
    if (c === 'price-source-missing' || c === 'price-source-degraded' || c === 'price-data-unavailable') {
      out.add('retry-later');
    }
  }
  // Baseline: always give the caller something to do.
  if (out.size === 0 || verdict !== 'ok') out.add('monitor');
  return ACTION_ORDER.filter(a => out.has(a));
}

function buildHeadline(health: StableHealthResult): string {
  const parts: string[] = [];

  // Peg
  if (health.pegDeviationBps !== null && Number.isFinite(health.pegDeviationBps)) {
    const bps = health.pegDeviationBps;
    const pct = (Math.abs(bps) / 100).toFixed(2);
    const dir = bps > 0 ? 'above' : bps < 0 ? 'below' : 'at';
    parts.push(`${pct}% ${dir} peg`);
  } else {
    parts.push('peg deviation unknown');
  }

  // Reserves
  if (health.reserves.available) {
    const bucket = health.reserves.healthBucket ? ` (${health.reserves.healthBucket})` : '';
    const age    = health.reserves.ageMs !== null ? `, ${formatAge(health.reserves.ageMs)} old` : '';
    parts.push(`reserves ${health.reserves.source ?? 'present'}${bucket}${age}`);
  } else {
    parts.push('reserves unverified');
  }

  // Price sources
  if (health.price.available && health.price.sourcesUsed !== null) {
    const n = health.price.sourcesUsed;
    parts.push(`${n} price source${n === 1 ? '' : 's'}`);
  }

  return `${health.symbol}: ${parts.join('; ')}.`;
}

/**
 * Confidence in the verdict itself — a function of how complete the data
 * was, NOT how healthy the stable is. Weighted block-availability scaled
 * by price-source confidence (price unavailable ⇒ we can't really judge peg).
 */
function assessmentConfidenceFor(health: StableHealthResult): number {
  const completeness =
    (health.price.available     ? 0.50 : 0) +
    (health.reserves.available  ? 0.25 : 0) +
    (health.supply.available    ? 0.15 : 0) +
    (health.liquidity.available ? 0.10 : 0);
  const sourceFactor = health.price.available
    ? 0.6 + 0.4 * clamp01(health.price.confidence ?? 0)
    : 0.3;
  return round4(clamp01(completeness * sourceFactor));
}

/**
 * Turn a gathered `StableHealthResult` into an actionable verdict. Pure —
 * the handler in srv/price-service.ts attaches the full `detail` block.
 */
export function assessStableHealth(health: StableHealthResult): StableAssessment {
  const derived = derivedCodes(health);
  // Alert IDs first (in their emitted order), then derived codes — deduped.
  const reasonCodes = [...new Set([...health.alerts, ...derived])];
  const allCodes = new Set(reasonCodes);

  const verdict = deriveVerdict(allCodes, health);

  return {
    symbol:               health.symbol,
    verdict,
    headline:             buildHeadline(health),
    reasonCodes,
    reasons:              reasonCodes.map(c => CODE_DESCRIPTIONS[c] ?? c),
    suggestedActions:     suggestedActionsFor(verdict, allCodes),
    assessmentConfidence: assessmentConfidenceFor(health),
    riskScore:            health.risk.score,
    computedAt:           health.computedAt,
  };
}
