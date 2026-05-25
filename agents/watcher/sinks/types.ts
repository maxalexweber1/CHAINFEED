/**
 * Sink interface — output target for watcher alerts.
 *
 * Each sink (stdout, Discord, Telegram, …) implements `notify`. The watcher
 * passes a batch of events from a single poll cycle so a sink with rate limits
 * can coalesce them into one outbound call instead of N. Sinks decide their
 * own formatting; the wire shape stays uniform.
 */

import type { Verdict } from '../../shared/types.js';

/** Direction of change between two ticks. */
export type Severity =
  | 'degraded'              // verdict moved toward worse (ok→caution, caution→alert, ok→alert)
  | 'recovered'             // verdict moved toward better
  | 'same-verdict-new-reasons'; // verdict unchanged but reasonCodes set differs

export interface AlertEvent {
  symbol: string;
  severity: Severity;
  previousVerdict: Verdict;
  currentVerdict: Verdict;
  previousReasonCodes: string[];
  currentReasonCodes: string[];
  /** ReasonCodes present in current but not previous. */
  addedReasonCodes: string[];
  /** ReasonCodes present in previous but not current. */
  removedReasonCodes: string[];
  headline: string;
  riskScore: number;
  assessmentConfidence: number;
  /** Server-side computation time, ISO 8601. */
  computedAt: string;
}

export interface Sink {
  /** Short identifier — used in startup banner + per-event error logs. */
  readonly name: string;
  /** Called once per poll cycle with all events from that cycle (possibly empty). */
  notify(events: AlertEvent[]): Promise<void>;
}
