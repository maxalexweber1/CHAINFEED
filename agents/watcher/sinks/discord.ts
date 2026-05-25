/**
 * Discord webhook sink — posts AlertEvents as color-coded embeds.
 *
 * One Discord message per poll cycle, up to 10 embeds (Discord's per-message
 * limit). For our scope (5 stables, at most one verdict-change per stable per
 * tick) we never hit that ceiling — but we still slice defensively in case
 * the watcher's tick later grows in scope.
 *
 * Errors propagate to the caller (`index.ts` logs them via Promise.allSettled).
 * `fetch` is injectable so the unit tests don't need real network.
 */

import type { Sink, AlertEvent, Severity } from './types.js';

/** Discord embed color is decimal-encoded RGB. */
const SEVERITY_COLOR: Record<Severity, number> = {
  degraded:                 0xE74C3C, // red
  recovered:                0x2ECC71, // green
  'same-verdict-new-reasons': 0xF1C40F, // yellow
};

const SEVERITY_PREFIX: Record<Severity, string> = {
  degraded:                 '🔻',
  recovered:                '🟢',
  'same-verdict-new-reasons': '⚠️',
};

function titleFor(e: AlertEvent): string {
  const prefix = SEVERITY_PREFIX[e.severity];
  return e.previousVerdict === e.currentVerdict
    ? `${prefix} ${e.symbol}: reasons drift (${e.currentVerdict})`
    : `${prefix} ${e.symbol}: ${e.previousVerdict} → ${e.currentVerdict}`;
}

function fieldsFor(e: AlertEvent): Array<{ name: string; value: string; inline?: boolean }> {
  const fields: Array<{ name: string; value: string; inline?: boolean }> = [
    { name: 'Risk',       value: e.riskScore.toFixed(2),            inline: true },
    { name: 'Confidence', value: e.assessmentConfidence.toFixed(2), inline: true },
  ];
  if (e.addedReasonCodes.length) {
    fields.push({
      name:  `Added reasons (${e.addedReasonCodes.length})`,
      value: e.addedReasonCodes.map((r) => `\`${r}\``).join(', '),
      inline: false,
    });
  }
  if (e.removedReasonCodes.length) {
    fields.push({
      name:  `Cleared reasons (${e.removedReasonCodes.length})`,
      value: e.removedReasonCodes.map((r) => `\`${r}\``).join(', '),
      inline: false,
    });
  }
  return fields;
}

interface DiscordEmbed {
  title:       string;
  description: string;
  color:       number;
  fields:      Array<{ name: string; value: string; inline?: boolean }>;
  timestamp:   string;
}

/** Pure-fn payload builder — extracted for unit testing. */
export function buildDiscordPayload(events: AlertEvent[]): { embeds: DiscordEmbed[] } {
  const embeds = events.slice(0, 10).map<DiscordEmbed>((e) => ({
    title:       titleFor(e),
    description: e.headline,
    color:       SEVERITY_COLOR[e.severity],
    fields:      fieldsFor(e),
    timestamp:   e.computedAt,
  }));
  return { embeds };
}

export interface DiscordSinkOptions {
  webhookUrl: string;
  fetchImpl?: typeof fetch;
}

export function makeDiscordSink(opts: DiscordSinkOptions): Sink {
  const fetchImpl = opts.fetchImpl ?? fetch;
  return {
    name: 'discord',
    async notify(events: AlertEvent[]): Promise<void> {
      if (events.length === 0) return;
      const payload = buildDiscordPayload(events);
      const res = await fetchImpl(opts.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      // Discord returns 204 No Content on success. 429 = rate-limited (rare at
      // our cadence). Any non-2xx is surfaced as a thrown error so index.ts's
      // Promise.allSettled logs it.
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Discord webhook returned HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
    },
  };
}
