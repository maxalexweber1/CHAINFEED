/**
 * Circle USDC attestation adapter tests.
 *
 * Mocks `globalThis.fetch` to feed synthetic HTML index + PDF responses.
 * Asserts the adapter:
 *   - parses the report month/year from URL filename
 *   - prefers env > scrape > fallback URL chain
 *   - hash-seals the PDF bytes correctly (sha256 round-trip)
 *   - rejects HTTP responses that pass status=200 but aren't a PDF (HTML redirect at CDN)
 *   - returns kind='attestation' with unit='attestation-binary' + scope note
 *
 * Run: npx tsx scripts/test-circle-usdc-attestation.ts
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

let n = 0, fails = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  n++;
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (e) {
    fails++;
    const err = e as Error;
    console.log(`FAIL  ${name}\n      ${err.stack || err.message}`);
  }
}

// PDF magic bytes header followed by minimal-but-valid trailer; the adapter
// only checks the first 4 bytes for `%PDF` so this content suffices.
const FAKE_PDF_BYTES = Buffer.concat([
  Buffer.from('%PDF-1.7\n', 'utf8'),
  Buffer.from('fake-attestation-content\n', 'utf8'),
  Buffer.from('%%EOF\n', 'utf8'),
]);
const FAKE_PDF_SHA256 = createHash('sha256').update(FAKE_PDF_BYTES).digest('hex');

type FetchStub = {
  ok: boolean; status: number;
  text: () => Promise<string>;
  arrayBuffer: () => Promise<ArrayBuffer>;
};
const htmlResp = (body: string): FetchStub => ({
  ok: true, status: 200,
  text: async () => body,
  arrayBuffer: async () => Buffer.from(body).buffer.slice(0) as ArrayBuffer,
});
const pdfResp  = (buf: Buffer = FAKE_PDF_BYTES): FetchStub => ({
  ok: true, status: 200,
  text: async () => 'binary',
  arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
});
const errResp  = (status: number): FetchStub => ({
  ok: false, status,
  text: async () => 'error',
  arrayBuffer: async () => new ArrayBuffer(0),
});

async function main() {
  const orig = { fetch: globalThis.fetch, env: process.env.CIRCLE_USDC_ATTESTATION_URL };

  let urlResponses: Map<string, FetchStub | Error> = new Map();
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);
    const r = urlResponses.get(url);
    if (r === undefined) throw new Error(`mock fetch: no stub for ${url}`);
    if (r instanceof Error) throw r;
    return r as unknown as Response;
  }) as typeof globalThis.fetch;

  const adapter = require('../srv/adapters/circle-usdc-attestation');
  const parseDateFromUrl = adapter._parseDateFromUrl as (s: string) => number | null;
  const FALLBACK_URL = adapter._FALLBACK_PDF_URL as string;
  const INDEX_URL    = adapter._TRANSPARENCY_INDEX_URL as string;

  console.log('circle-usdc-attestation ─────────────────────────────────');

  // ── parseDateFromUrl pure-fn ─────────────────────────────────────────
  t('parseDateFromUrl: handles URL-encoded spaces (March 26)', () => {
    const ts = parseDateFromUrl(
      'https://6778953.fs1.hubspotusercontent-na1.net/hubfs/6778953/USDCAttestationReports/2026/2026%20USDC_Examination%20Report%20March%2026.pdf',
    );
    assert.ok(ts !== null);
    const d = new Date(ts!);
    assert.equal(d.getUTCFullYear(), 2026);
    assert.equal(d.getUTCMonth(),    2);     // March
    assert.equal(d.getUTCDate(),     31);    // last day of March
  });
  t('parseDateFromUrl: handles literal spaces', () => {
    const ts = parseDateFromUrl('https://example.com/2025 USDC_Examination Report November 25.pdf');
    assert.ok(ts !== null);
    assert.equal(new Date(ts!).getUTCMonth(), 10);  // Nov
  });
  t('parseDateFromUrl: handles February (28 days)', () => {
    const ts = parseDateFromUrl('https://example.com/2026/2026 USDC_Examination Report February 26.pdf');
    assert.equal(new Date(ts!).getUTCDate(), 28);
  });
  t('parseDateFromUrl: returns null for unrecognised filename shapes', () => {
    assert.equal(parseDateFromUrl('https://example.com/random.pdf'), null);
    assert.equal(parseDateFromUrl('https://example.com/USDC_Examination_Report_2025_03.pdf'), null);
  });

  // ── env-override path ────────────────────────────────────────────────
  await t('env override pinned URL takes precedence', async () => {
    const pinnedUrl = 'https://example.com/2025/2025 USDC_Examination Report October 25.pdf';
    process.env.CIRCLE_USDC_ATTESTATION_URL = pinnedUrl;
    urlResponses = new Map([
      [pinnedUrl, pdfResp()],
      // Index URL is never even queried when env override is set AND first PDF works.
      // (We DO add it as a candidate after env, but env succeeds first.)
    ]);
    const q = await adapter.getPrice('USDCx-ATTESTATION');
    assert.equal(q.kind, 'attestation');
    assert.equal(q.sourceName, 'circle-usdc-attestation');
    assert.equal(q.unit, 'attestation-binary');
    assert.equal(q.value, 1.0);
    const raw = q.rawPayload as { attestationUrl: string; sha256: string; contentLengthBytes: number; pdfParsed: boolean };
    assert.equal(raw.attestationUrl, pinnedUrl);
    assert.equal(raw.sha256, FAKE_PDF_SHA256);
    assert.equal(raw.contentLengthBytes, FAKE_PDF_BYTES.length);
    assert.equal(raw.pdfParsed, false);
    // Timestamp should be end-of-October-2025 (the attestation period).
    const d = new Date(q.timestamp);
    assert.equal(d.getUTCFullYear(), 2025);
    assert.equal(d.getUTCMonth(),    9);
    delete process.env.CIRCLE_USDC_ATTESTATION_URL;
  });

  // ── HTML-scrape discovery ────────────────────────────────────────────
  await t('HTML scrape picks the latest PDF when env is unset', async () => {
    const apr = 'https://6778953.fs1.hubspotusercontent-na1.net/hubfs/6778953/USDCAttestationReports/2026/2026%20USDC_Examination%20Report%20April%2026.pdf';
    const mar = 'https://6778953.fs1.hubspotusercontent-na1.net/hubfs/6778953/USDCAttestationReports/2026/2026%20USDC_Examination%20Report%20March%2026.pdf';
    const html = `<html><body>
      <a href="${mar}">March 2026</a>
      <a href="${apr}">April 2026</a>
      <a href="https://6778953.fs1.hubspotusercontent-na1.net/hubfs/6778953/USDCAttestationReports/2025/2025%20USDC_Examination%20Report%20December%2025.pdf">Dec 2025</a>
    </body></html>`;
    urlResponses = new Map([
      [INDEX_URL, htmlResp(html)],
      [apr,       pdfResp()],     // latest succeeds
    ]);
    const q = await adapter.getPrice('USDCx-ATTESTATION');
    const raw = q.rawPayload as { attestationUrl: string };
    assert.equal(raw.attestationUrl, apr);
  });

  // ── fallback chain ───────────────────────────────────────────────────
  await t('falls back to FALLBACK_PDF_URL when scrape returns no candidates', async () => {
    urlResponses = new Map([
      [INDEX_URL,    htmlResp('<html><body>nothing useful here</body></html>')],
      [FALLBACK_URL, pdfResp()],
    ]);
    const q = await adapter.getPrice('USDCx-ATTESTATION');
    const raw = q.rawPayload as { attestationUrl: string };
    assert.equal(raw.attestationUrl, FALLBACK_URL);
  });

  await t('falls back when scrape candidate 404s but fallback works', async () => {
    const apr404 = 'https://6778953.fs1.hubspotusercontent-na1.net/hubfs/6778953/USDCAttestationReports/2026/2026%20USDC_Examination%20Report%20April%2026.pdf';
    urlResponses = new Map<string, FetchStub | Error>([
      [INDEX_URL,    htmlResp(`<a href="${apr404}">April</a>`)],
      [apr404,       errResp(404)],
      [FALLBACK_URL, pdfResp()],
    ]);
    const q = await adapter.getPrice('USDCx-ATTESTATION');
    assert.equal((q.rawPayload as { attestationUrl: string }).attestationUrl, FALLBACK_URL);
  });

  // ── PDF-magic-bytes guard ────────────────────────────────────────────
  await t('rejects 200-OK response that lacks PDF magic bytes (CDN HTML redirect)', async () => {
    const fakeHtmlAtPdfUrl: FetchStub = {
      ok: true, status: 200,
      text: async () => '<html>not a pdf</html>',
      arrayBuffer: async () => Buffer.from('<!DOCTYPE html>...').buffer.slice(0) as ArrayBuffer,
    };
    urlResponses = new Map([
      [INDEX_URL,    htmlResp('')],     // no candidates from scrape
      [FALLBACK_URL, fakeHtmlAtPdfUrl], // CDN returns HTML at the PDF URL
    ]);
    await assert.rejects(
      () => adapter.getPrice('USDCx-ATTESTATION'),
      /could not fetch a valid PDF/,
    );
  });

  // ── error path: every candidate fails ────────────────────────────────
  await t('throws descriptively when every URL fails', async () => {
    urlResponses = new Map<string, FetchStub | Error>([
      [INDEX_URL,    new Error('cdn-down')],
      [FALLBACK_URL, errResp(500)],
    ]);
    await assert.rejects(
      () => adapter.getPrice('USDCx-ATTESTATION'),
      /could not fetch a valid PDF/,
    );
  });

  await t('rejects unsupported pair', async () => {
    await assert.rejects(
      () => adapter.getPrice('FOO-BAR'),
      /pair 'FOO-BAR' not supported/,
    );
  });

  await t('supportsPair: only USDCx-ATTESTATION', () => {
    assert.equal(adapter.supportsPair('USDCx-ATTESTATION'), true);
    assert.equal(adapter.supportsPair('USDM-RESERVES'),     false);
    assert.equal(adapter.supportsPair('ADA-USDCx'),         false);
    assert.equal(adapter.supportsPair(''),                  false);
  });

  // restore globals
  globalThis.fetch = orig.fetch;
  if (orig.env !== undefined) process.env.CIRCLE_USDC_ATTESTATION_URL = orig.env;

  console.log(`\n${n - fails}/${n} passed`);
  process.exit(fails ? 1 : 0);
}

main().catch(err => { console.error('runner crash:', err); process.exit(2); });
