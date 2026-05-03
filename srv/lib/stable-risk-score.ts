/**
 * Stable-health risk-score & alerts — pure functions, no I/O.
 *
 * Composite scoring on [0, 1] from the inputs that `getStableHealth`
 * gathers. The intent is a single-number summary that downstream
 * consumers (wallets, lending UIs, risk dashboards) can use without
 * having to interpret peg-deviation bps + reserve ratios themselves.
 *
 * Score weights (default — caller can override but shouldn't need to):
 *
 *   0.45  peg confidence            (how far is price from peg)
 *   0.30  reserve adequacy          (on-chain coverage / collateral ratio)
 *   0.15  attestation freshness     (when was last reserve proof written)
 *   0.10  source confidence         (how many price sources agreed)
 *
 * For stables where a component isn't applicable (e.g. fiat-custodial
 * without on-chain attestation yet), that component contributes a
 * NEUTRAL 0.5 — neither boosting nor sinking the score — and an
 * `unsubstantiated-X` alert is added so consumers know the score is
 * thinner than for fully-on-chain stables.
 *
 * Alerts are surfaced as short stable identifiers (e.g. "peg-deviation-high")
 * — string-stable so consumers can match without parsing prose.
 */

export type Backing = 'fiat-custodial' | 'overcollateralized-ada' | 'overcollateralized-cdp' | 'algorithmic';
export type AttestationKind = 'on-chain-attestation' | 'on-chain-collateral-aggregate' | 'off-chain-pdf' | 'none';

export interface RiskScoreInputs {
  backing: Backing;
  /** signed bps, positive = above peg, negative = below. null = unavailable */
  pegDeviationBps: number | null;
  /** confidence from price aggregator [0, 1]. null = unavailable */
  priceSourceConfidence: number | null;
  /** number of price sources that returned a quote */
  priceSourcesUsed: number | null;
  /** which kind of reserves data is available (or 'none') */
  reservesKind: AttestationKind;
  /**
   * For on-chain-collateral-aggregate (DJED, iUSD): coverage ratio in PERCENT.
   * For on-chain-attestation (USDM): reserves USD value as a number.
   * For off-chain-pdf: reserves USD as parsed.
   * Null when reservesKind === 'none' or fetch failed.
   */
  reservesValue: number | null;
  /**
   * For fiat-custodial stables only: circulating supply (whole tokens, peg-USD).
   * Used together with reservesValue in USD to compute coverage. Null otherwise.
   */
  circulatingSupplyUsd: number | null;
  /** ms since the reserves attestation/aggregate was last updated. Null if unknown. */
  attestationAgeMs: number | null;
}

export interface RiskScoreResult {
  /** Composite score in [0, 1]. Higher = healthier. */
  score: number;
  /** Per-component contributions for transparency. */
  components: {
    pegConfidence:        { value: number; weight: number; effective: number };
    reserveAdequacy:      { value: number; weight: number; effective: number };
    attestationFreshness: { value: number; weight: number; effective: number };
    sourceConfidence:     { value: number; weight: number; effective: number };
  };
  alerts: string[];
}

const DEFAULT_WEIGHTS = Object.freeze({
  pegConfidence:        0.45,
  reserveAdequacy:      0.30,
  attestationFreshness: 0.15,
  sourceConfidence:     0.10,
});

const ONE_DAY_MS  = 24 * 60 * 60 * 1000;
const ONE_WEEK_MS = 7 * ONE_DAY_MS;
const ONE_MONTH_MS = 30 * ONE_DAY_MS;

// Peg-deviation thresholds in bps (1 bp = 0.01% = 1e-4 of value).
const PEG_DEVIATION_HIGH_BPS     = 100;   // 1.00%  → "peg-deviation-high"
const PEG_DEVIATION_CRITICAL_BPS = 500;   // 5.00%  → "peg-deviation-critical"

// Coverage thresholds (collateral ratio %) for overcollateralized stables.
const COVERAGE_WARN_PCT     = 200;
const COVERAGE_CRITICAL_PCT = 110;

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

/**
 * Peg-confidence sub-score. 0 bps deviation → 1.0; 200 bps deviation → 0.0.
 * Linear in between. Aggressive on purpose — a stable 2 % off peg is
 * already very different from a stable on peg.
 */
export function pegConfidenceScore(bps: number | null): number {
  if (bps === null || !Number.isFinite(bps)) return 0.5;   // neutral when missing
  return clamp01(1 - Math.abs(bps) / 200);
}

/**
 * Reserve adequacy sub-score. Branches on `reservesKind`:
 *   - on-chain-collateral-aggregate (DJED, iUSD): ratio% maps to [100% → 0, 500% → 1]
 *   - on-chain-attestation (USDM): reservesUsd / supplyUsd maps to [1.0× → 0.5, 2.0× → 1]
 *   - off-chain-pdf with parsed value: same coverage formula, capped at 0.85
 *   - off-chain-pdf with NO parsed value (attestation-binary): 0.6 — Circle/BitGo
 *     PDFs that we hash-seal but don't parse. Slightly above neutral to credit
 *     "fresh attestation exists from a reputable auditor". The freshness
 *     component captures recency separately.
 *   - none: 0.5 neutral
 */
export function reserveAdequacyScore(inputs: Pick<RiskScoreInputs, 'reservesKind' | 'reservesValue' | 'circulatingSupplyUsd'>): number {
  const { reservesKind, reservesValue, circulatingSupplyUsd } = inputs;
  if (reservesKind === 'none') return 0.5;
  // Special case: off-chain PDF where the body is hash-sealed but not parsed.
  // Adapter signals this by returning a present-but-uninformative value (e.g. 1.0).
  // We can't compute coverage without a numeric reserves figure, so we credit
  // "attestation exists from a reputable auditor" with a fixed 0.6.
  if (reservesKind === 'off-chain-pdf' && (reservesValue === null || reservesValue === 1.0)) {
    return 0.6;
  }
  if (reservesValue === null || !Number.isFinite(reservesValue) || reservesValue < 0) return 0.5;

  if (reservesKind === 'on-chain-collateral-aggregate') {
    // Ratio in percent. 100% = bare cover, 500%+ = comfortable.
    return clamp01((reservesValue - 100) / 400);
  }

  // attestation/PDF paths — need supply for ratio
  if (circulatingSupplyUsd === null || !Number.isFinite(circulatingSupplyUsd) || circulatingSupplyUsd <= 0) {
    return 0.5;
  }
  const coverage = reservesValue / circulatingSupplyUsd;
  // 1.0× cover → 0.5, 2.0× → 1.0; below 1.0 drops fast.
  let score: number;
  if (coverage >= 1.0) {
    score = clamp01(0.5 + (coverage - 1.0) * 0.5);
  } else {
    score = clamp01(coverage * 0.5);
  }
  // Off-chain proofs cap at 0.85 — the on-chain audit-trail for USDM-RESERVES
  // is fundamentally more verifiable than a PDF behind a CDN.
  if (reservesKind === 'off-chain-pdf') score = Math.min(score, 0.85);
  return score;
}

/**
 * Attestation freshness. Inside 24h = full credit, 7d cliff to 0.5,
 * 30d cliff to 0. Null age (no attestation source) = 0.5 neutral.
 */
export function attestationFreshnessScore(ageMs: number | null): number {
  if (ageMs === null || !Number.isFinite(ageMs) || ageMs < 0) return 0.5;
  if (ageMs <= ONE_DAY_MS)   return 1.0;
  if (ageMs <= ONE_WEEK_MS)  return 0.5 + 0.5 * (1 - (ageMs - ONE_DAY_MS) / (ONE_WEEK_MS - ONE_DAY_MS));
  if (ageMs <= ONE_MONTH_MS) return 0.5 * (1 - (ageMs - ONE_WEEK_MS) / (ONE_MONTH_MS - ONE_WEEK_MS));
  return 0;
}

/**
 * Source confidence — uses the aggregator's confidence directly, but
 * boosts mildly for ≥ 3 sources (cross-confirmation matters more than
 * tight spread alone).
 */
export function sourceConfidenceScore(confidence: number | null, sourcesUsed: number | null): number {
  if (confidence === null || !Number.isFinite(confidence)) return 0.5;
  let s = clamp01(confidence);
  if ((sourcesUsed ?? 0) >= 3) s = Math.min(1, s * 1.05);
  return s;
}

/**
 * Build the alert list. Pure derivation from inputs — same triggers as
 * the rawPayload health-bucket fields on individual adapters, lifted to
 * the composite-endpoint level.
 */
export function alertsFor(inputs: RiskScoreInputs): string[] {
  const out: string[] = [];

  // Peg
  if (inputs.pegDeviationBps !== null && Number.isFinite(inputs.pegDeviationBps)) {
    const abs = Math.abs(inputs.pegDeviationBps);
    if (abs >= PEG_DEVIATION_CRITICAL_BPS) out.push('peg-deviation-critical');
    else if (abs >= PEG_DEVIATION_HIGH_BPS) out.push('peg-deviation-high');
  } else {
    out.push('peg-deviation-unknown');
  }

  // Reserves
  if (inputs.reservesKind === 'on-chain-collateral-aggregate' && inputs.reservesValue !== null) {
    if (inputs.reservesValue < COVERAGE_CRITICAL_PCT) out.push('reserve-coverage-critical');
    else if (inputs.reservesValue < COVERAGE_WARN_PCT) out.push('reserve-coverage-warning');
  }
  if (inputs.backing.startsWith('overcoll') && inputs.reservesKind === 'none') {
    out.push('reserves-source-missing');   // shouldn't happen for DJED/iUSD post-Sprint-1
  }
  if (inputs.backing === 'fiat-custodial' && inputs.reservesKind === 'none') {
    out.push('reserves-unsubstantiated');  // expected for USDA/USDCx/USDT/USDC pre-Day-9
  }

  // Attestation freshness
  if (inputs.attestationAgeMs !== null && Number.isFinite(inputs.attestationAgeMs)) {
    if (inputs.attestationAgeMs > ONE_MONTH_MS) out.push('attestation-overdue');
    else if (inputs.attestationAgeMs > ONE_WEEK_MS) out.push('attestation-stale');
  }

  // Price-source health
  if (inputs.priceSourceConfidence !== null && inputs.priceSourceConfidence < 0.5) {
    out.push('price-source-degraded');
  }
  if ((inputs.priceSourcesUsed ?? 0) === 0) {
    out.push('price-source-missing');
  }

  return out;
}

/**
 * Compose the four sub-scores with default weights.
 */
export function computeRiskScore(inputs: RiskScoreInputs): RiskScoreResult {
  const w = DEFAULT_WEIGHTS;

  const pegV   = pegConfidenceScore(inputs.pegDeviationBps);
  const resV   = reserveAdequacyScore(inputs);
  const ageV   = attestationFreshnessScore(inputs.attestationAgeMs);
  const srcV   = sourceConfidenceScore(inputs.priceSourceConfidence, inputs.priceSourcesUsed);

  const score = clamp01(w.pegConfidence * pegV + w.reserveAdequacy * resV +
                        w.attestationFreshness * ageV + w.sourceConfidence * srcV);

  return {
    score,
    components: {
      pegConfidence:        { value: pegV, weight: w.pegConfidence,        effective: w.pegConfidence * pegV },
      reserveAdequacy:      { value: resV, weight: w.reserveAdequacy,      effective: w.reserveAdequacy * resV },
      attestationFreshness: { value: ageV, weight: w.attestationFreshness, effective: w.attestationFreshness * ageV },
      sourceConfidence:     { value: srcV, weight: w.sourceConfidence,     effective: w.sourceConfidence * srcV },
    },
    alerts: alertsFor(inputs),
  };
}
