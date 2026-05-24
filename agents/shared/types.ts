/**
 * Shared types for CHAINFEED demo agents.
 *
 * Re-exports the verdict/assessment types from the server-side judgment layer
 * (`srv/lib/stable-assessment.ts`) so agents stay in sync with the wire format
 * without redefining anything. Type-only imports — no runtime coupling to the
 * CAP service code.
 *
 * If `srv/lib/stable-assessment.ts` changes its shape, the agent code typechecks
 * against the new shape automatically. That's intentional: drift between server
 * and agent is the failure mode we want to catch at build time.
 */

import type {
  StableAssessment,
  Verdict,
  SuggestedAction,
} from '../../srv/lib/stable-assessment.js';
import type { StableHealthResult } from '../../srv/lib/stable-health.js';

export type { StableAssessment, Verdict, SuggestedAction, StableHealthResult };

/** The 5 USD-pegged Cardano stables CHAINFEED tracks. */
export type StableSymbol = 'USDM' | 'DJED' | 'iUSD' | 'USDA' | 'USDCx';

export const STABLE_SYMBOLS: readonly StableSymbol[] = [
  'USDM',
  'DJED',
  'iUSD',
  'USDA',
  'USDCx',
] as const;

/**
 * Server returns `StableAssessment` with a nested `detail: StableHealthResult`.
 * Modeled as optional because agents may eventually call a leaner endpoint.
 */
export type AssessmentResponse = StableAssessment & { detail?: StableHealthResult };
