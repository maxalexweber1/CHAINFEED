/**
 * Telegram bot sink — posts AlertEvents via Bot-API `sendMessage`.
 *
 * One Telegram message per poll cycle, with events concatenated as HTML
 * sections (Telegram allows up to 4096 chars; we truncate defensively).
 * HTML mode chosen over MarkdownV2 because the latter requires escaping a
 * long list of special chars in headline text — too easy to break.
 *
 * Errors propagate to the caller for `Promise.allSettled` logging.
 * `fetch` is injectable for unit testing.
 */

import type { Sink, AlertEvent, Severity } from './types.js';

const SEVERITY_PREFIX: Record<Severity, string> = {
  degraded:                 '🔻',
  recovered:                '🟢',
  'same-verdict-new-reasons': '⚠️',
};

/** HTML-escape user-controlled strings before embedding in Telegram messages. */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function eventToHtml(e: AlertEvent): string {
  const prefix = SEVERITY_PREFIX[e.severity];
  const header = e.previousVerdict === e.currentVerdict
    ? `${prefix} <b>${esc(e.symbol)}</b>: reasons drift (${esc(e.currentVerdict)})`
    : `${prefix} <b>${esc(e.symbol)}</b>: ${esc(e.previousVerdict)} → ${esc(e.currentVerdict)}`;

  const lines: string[] = [
    header,
    `<i>${esc(e.headline)}</i>`,
    `Risk: <code>${e.riskScore.toFixed(2)}</code> · Confidence: <code>${e.assessmentConfidence.toFixed(2)}</code>`,
  ];
  if (e.addedReasonCodes.length) {
    lines.push(`Added: ${e.addedReasonCodes.map((r) => `<code>${esc(r)}</code>`).join(', ')}`);
  }
  if (e.removedReasonCodes.length) {
    lines.push(`Cleared: ${e.removedReasonCodes.map((r) => `<code>${esc(r)}</code>`).join(', ')}`);
  }
  return lines.join('\n');
}

const TELEGRAM_MAX_LEN = 4096;

/** Pure-fn builder — extracted for unit testing. */
export function buildTelegramText(events: AlertEvent[]): string {
  const text = events.map(eventToHtml).join('\n\n');
  if (text.length <= TELEGRAM_MAX_LEN) return text;
  // Truncate at a section boundary, append a marker. Honest > pretty.
  const cutoff = TELEGRAM_MAX_LEN - 50;
  return `${text.slice(0, cutoff)}\n\n<i>… ${events.length} events, truncated</i>`;
}

export interface TelegramSinkOptions {
  botToken: string;
  chatId:   string;
  fetchImpl?: typeof fetch;
}

export function makeTelegramSink(opts: TelegramSinkOptions): Sink {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `https://api.telegram.org/bot${opts.botToken}/sendMessage`;
  return {
    name: 'telegram',
    async notify(events: AlertEvent[]): Promise<void> {
      if (events.length === 0) return;
      const text = buildTelegramText(events);
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id:                  opts.chatId,
          text,
          parse_mode:               'HTML',
          disable_web_page_preview: true,
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Telegram sendMessage returned HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
    },
  };
}
