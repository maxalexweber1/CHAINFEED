/**
 * Stdout sink — pretty-prints alert events. Used as the default when no
 * external sink (Discord, Telegram) is configured, and as the local-test
 * surface during development.
 *
 * Format is deliberately scannable: one row per event, prefix flagged by
 * severity emoji, then symbol → verdict transition + change set.
 */

import type { Sink, AlertEvent, Severity } from './types.js';

const SEVERITY_PREFIX: Record<Severity, string> = {
  degraded:                 '🔻',
  recovered:                '🟢',
  'same-verdict-new-reasons': '⚠️ ',
};

function describeChange(e: AlertEvent): string {
  if (e.previousVerdict === e.currentVerdict) {
    // Same verdict, reason set drift — show ±diffs.
    const adds = e.addedReasonCodes.length    ? `+[${e.addedReasonCodes.join(', ')}]`   : '';
    const rems = e.removedReasonCodes.length  ? `-[${e.removedReasonCodes.join(', ')}]` : '';
    return `${e.currentVerdict} (${[adds, rems].filter(Boolean).join(' ')})`;
  }
  return `${e.previousVerdict} → ${e.currentVerdict}`;
}

export const stdoutSink: Sink = {
  name: 'stdout',
  async notify(events: AlertEvent[]): Promise<void> {
    if (events.length === 0) return;
    for (const e of events) {
      const line = [
        SEVERITY_PREFIX[e.severity],
        e.symbol.padEnd(6),
        describeChange(e).padEnd(40),
        `risk ${e.riskScore.toFixed(2)}`,
        `· ${e.headline}`,
      ].join('  ');
      process.stdout.write(`${line}\n`);
    }
  },
};
