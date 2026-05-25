/**
 * Unit tests for the Discord + Telegram watcher sinks.
 *
 * No network — `fetch` is injected per-sink for stubbing. Tests cover payload
 * shape (the wire format is what an external service sees) plus the cheap
 * properties: empty-events short-circuit, non-2xx throws.
 *
 * Run: npx tsx scripts/test-watcher-sinks.ts
 */

import assert from 'node:assert/strict';
import { buildDiscordPayload, makeDiscordSink } from '../agents/watcher/sinks/discord.js';
import { buildTelegramText, makeTelegramSink } from '../agents/watcher/sinks/telegram.js';
import type { AlertEvent } from '../agents/watcher/sinks/types.js';

let n = 0, fails = 0;
function t(name: string, fn: () => Promise<void> | void) {
  n++;
  const run = async () => {
    try { await fn(); console.log(`  ok  ${name}`); }
    catch (e) { fails++; console.log(`FAIL  ${name}\n      ${(e as Error).stack || (e as Error).message}`); }
  };
  return run();
}

function mkEvent(overrides: Partial<AlertEvent> = {}): AlertEvent {
  return {
    symbol:               'USDM',
    severity:             'degraded',
    previousVerdict:      'ok',
    currentVerdict:       'caution',
    previousReasonCodes:  [],
    currentReasonCodes:   ['attestation-stale'],
    addedReasonCodes:     ['attestation-stale'],
    removedReasonCodes:   [],
    headline:             'USDM: 0.4% above peg; reserves 19d old',
    riskScore:            0.64,
    assessmentConfidence: 0.99,
    computedAt:           '2026-05-25T11:46:59.025Z',
    ...overrides,
  };
}

/** A controllable fetch double — records the last call, returns the configured response. */
function makeFetchStub(response: { status?: number; body?: string } = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const stub = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const status = response.status ?? 204;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => response.body ?? '',
    } as Response;
  }) as unknown as typeof fetch;
  return { stub, calls };
}

async function main() {
  console.log('watcher-sinks ───────────────────────────────────────────');

  // ── Discord — payload builder ─────────────────────────────────────────
  await t('discord: payload has one embed per event, correct color per severity', () => {
    const payload = buildDiscordPayload([
      mkEvent({ severity: 'degraded' }),
      mkEvent({ severity: 'recovered', symbol: 'DJED' }),
      mkEvent({ severity: 'same-verdict-new-reasons', symbol: 'iUSD' }),
    ]);
    assert.equal(payload.embeds.length, 3);
    assert.equal(payload.embeds[0]!.color, 0xE74C3C);
    assert.equal(payload.embeds[1]!.color, 0x2ECC71);
    assert.equal(payload.embeds[2]!.color, 0xF1C40F);
  });

  await t('discord: title uses transition arrow for verdict change, "reasons drift" otherwise', () => {
    const p = buildDiscordPayload([
      mkEvent({ severity: 'degraded',                 previousVerdict: 'ok',      currentVerdict: 'caution' }),
      mkEvent({ severity: 'same-verdict-new-reasons', previousVerdict: 'caution', currentVerdict: 'caution', symbol: 'DJED' }),
    ]);
    assert.match(p.embeds[0]!.title, /USDM: ok → caution/);
    assert.match(p.embeds[1]!.title, /DJED: reasons drift \(caution\)/);
  });

  await t('discord: only emits the reason-diff fields that are populated', () => {
    const p = buildDiscordPayload([mkEvent({ addedReasonCodes: ['attestation-stale'], removedReasonCodes: [] })]);
    const fieldNames = p.embeds[0]!.fields.map(f => f.name);
    assert.ok(fieldNames.some(n => n.startsWith('Added')));
    assert.ok(!fieldNames.some(n => n.startsWith('Cleared')));
  });

  await t('discord: caps at 10 embeds per message (Discord limit)', () => {
    const events = Array.from({ length: 15 }, () => mkEvent());
    const p = buildDiscordPayload(events);
    assert.equal(p.embeds.length, 10);
  });

  // ── Discord — sink wiring ─────────────────────────────────────────────
  await t('discord: notify POSTs to the webhook URL with JSON body', async () => {
    const { stub, calls } = makeFetchStub({ status: 204 });
    const sink = makeDiscordSink({ webhookUrl: 'https://discord.com/api/webhooks/X/Y', fetchImpl: stub });
    await sink.notify([mkEvent()]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, 'https://discord.com/api/webhooks/X/Y');
    assert.equal(calls[0]!.init?.method, 'POST');
    assert.match(JSON.stringify(calls[0]!.init?.headers), /application\/json/);
    const body = JSON.parse(calls[0]!.init!.body as string);
    assert.ok(Array.isArray(body.embeds) && body.embeds.length === 1);
  });

  await t('discord: empty events → no fetch call (short-circuit)', async () => {
    const { stub, calls } = makeFetchStub();
    const sink = makeDiscordSink({ webhookUrl: 'x', fetchImpl: stub });
    await sink.notify([]);
    assert.equal(calls.length, 0);
  });

  await t('discord: non-2xx response → notify throws with status + body', async () => {
    const { stub } = makeFetchStub({ status: 400, body: 'invalid webhook' });
    const sink = makeDiscordSink({ webhookUrl: 'x', fetchImpl: stub });
    await assert.rejects(() => sink.notify([mkEvent()]), /HTTP 400.*invalid webhook/);
  });

  // ── Telegram — text builder ───────────────────────────────────────────
  await t('telegram: HTML-escapes user-controlled content (headline)', () => {
    const text = buildTelegramText([mkEvent({ headline: 'price <crashed> & burned' })]);
    assert.match(text, /price &lt;crashed&gt; &amp; burned/);
  });

  await t('telegram: joins multiple events with double newline separator', () => {
    const text = buildTelegramText([
      mkEvent({ symbol: 'USDM' }),
      mkEvent({ symbol: 'DJED' }),
    ]);
    assert.match(text, /<b>USDM<\/b>[\s\S]*\n\n[\s\S]*<b>DJED<\/b>/);
  });

  await t('telegram: severity prefix differs per severity', () => {
    const t1 = buildTelegramText([mkEvent({ severity: 'degraded' })]);
    const t2 = buildTelegramText([mkEvent({ severity: 'recovered' })]);
    const t3 = buildTelegramText([mkEvent({ severity: 'same-verdict-new-reasons' })]);
    assert.match(t1, /🔻/);
    assert.match(t2, /🟢/);
    assert.match(t3, /⚠️/);
  });

  await t('telegram: truncates if combined text exceeds 4096 chars, with marker', () => {
    const longHeadline = 'x'.repeat(300);
    const many = Array.from({ length: 30 }, () => mkEvent({ headline: longHeadline }));
    const text = buildTelegramText(many);
    assert.ok(text.length <= 4096, `actual length ${text.length}`);
    assert.match(text, /events, truncated/);
  });

  // ── Telegram — sink wiring ────────────────────────────────────────────
  await t('telegram: notify POSTs to bot API with chat_id + parse_mode HTML', async () => {
    const { stub, calls } = makeFetchStub({ status: 200, body: '{"ok":true}' });
    const sink = makeTelegramSink({ botToken: 'TOKEN123', chatId: '999', fetchImpl: stub });
    await sink.notify([mkEvent()]);
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.url, /api\.telegram\.org\/botTOKEN123\/sendMessage$/);
    const body = JSON.parse(calls[0]!.init!.body as string);
    assert.equal(body.chat_id, '999');
    assert.equal(body.parse_mode, 'HTML');
    assert.equal(body.disable_web_page_preview, true);
    assert.ok(body.text.length > 0);
  });

  await t('telegram: empty events → no fetch call', async () => {
    const { stub, calls } = makeFetchStub();
    const sink = makeTelegramSink({ botToken: 't', chatId: '1', fetchImpl: stub });
    await sink.notify([]);
    assert.equal(calls.length, 0);
  });

  await t('telegram: non-2xx response → notify throws with status + body', async () => {
    const { stub } = makeFetchStub({ status: 401, body: '{"description":"Unauthorized"}' });
    const sink = makeTelegramSink({ botToken: 'bad', chatId: '1', fetchImpl: stub });
    await assert.rejects(() => sink.notify([mkEvent()]), /HTTP 401.*Unauthorized/);
  });

  console.log(`\n${n - fails}/${n} passed`);
  process.exit(fails ? 1 : 0);
}

void main();
