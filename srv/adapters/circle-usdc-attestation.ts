/**
 * Circle USDC monthly-attestation adapter.
 *
 * Fetches Circle's latest USDC examination-report PDF, hash-seals the
 * bytes, and returns an AttestationQuote signaling "Circle has published
 * a fresh attestation as of date X". Covers USDCx (Circle's IOG xReserve
 * Cardano-bridged USDC) and any future Circle-attested deployments.
 *
 * **Why we don't parse the PDF body:** Circle's report layout has
 * changed multiple times in past years. Hard-coding regex/text-extraction
 * against the current format would force us to re-ship adapter code on
 * every layout drift. Instead we treat the PDF as a hashed audit-trail
 * artifact and signal "attestation exists & is recent". Consumers who
 * need the exact reserves figure can open the URL directly — we expose
 * `attestationUrl` and `sha256` in rawPayload so the bytes are pinned.
 *
 * **Why we don't break out USDCx separately:** as of 2026-05-02, Circle's
 * monthly attestation reports total USDC reserves across ALL chains as
 * one figure — Ethereum, Solana, Cardano (via xReserve), etc. There is
 * no per-chain reserves split in the public PDF. The attestation is
 * therefore a GLOBAL signal, not a USDCx-specific one. We document this
 * scope clearly in rawPayload so consumers don't misinterpret.
 *
 * **URL discovery strategy:**
 *   1. Read CIRCLE_USDC_ATTESTATION_URL from env (operator override).
 *   2. Scrape circle.com/transparency for the latest hubspot-CDN PDF link.
 *   3. Fall back to the hard-coded latest-known URL (March 2026).
 * The hard-coded fallback should be refreshed in PRs whenever the page
 * structure breaks; the env var is the immediate fix without redeploy.
 */

import { createHash } from 'node:crypto';
import { assertIsAdapter, type AttestationQuote, type PriceAdapter } from './types';

const SOURCE_NAME = 'circle-usdc-attestation';

// We expose ONE attestation pair shared by all Circle-USDC-derived stables
// in our registry (USDCx today; future Circle-bridged variants can route
// through the same source). Consumers indirectly access via a stable's
// `reservesPair` in STABLE_METADATA.
const PAIR = 'USDCx-ATTESTATION';
const SUPPORTED_PAIRS = new Set([PAIR]);

const TRANSPARENCY_INDEX_URL = 'https://www.circle.com/transparency';

// Latest verified URL as of 2026-05-02 — March 2026 examination report.
// Update on URL drift via PR; in the field operators set
// CIRCLE_USDC_ATTESTATION_URL to pin a specific report.
const FALLBACK_PDF_URL =
  'https://6778953.fs1.hubspotusercontent-na1.net/hubfs/6778953/USDCAttestationReports/2026/2026%20USDC_Examination%20Report%20March%2026.pdf';

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
] as const;

function parseDateFromUrl(url: string): number | null {
  // Circle's pattern: ".../{YEAR}/{YEAR} USDC_Examination Report {Month} {YY}.pdf"
  // URL-encoded in real-world links: spaces become %20.
  const decoded = decodeURIComponent(url);
  const m = decoded.match(/(\d{4})[^/]*USDC_Examination\s+Report\s+([A-Za-z]+)/i);
  if (!m) return null;
  const year = Number(m[1]);
  const monthIdx = MONTH_NAMES.indexOf(m[2]!.toLowerCase() as typeof MONTH_NAMES[number]);
  if (!Number.isFinite(year) || monthIdx < 0) return null;
  // End-of-month for the report period (the attestation covers the named month).
  const lastDay = new Date(Date.UTC(year, monthIdx + 1, 0)).getUTCDate();
  return Date.UTC(year, monthIdx, lastDay, 23, 59, 59);
}

async function discoverLatestUrl(timeoutMs = 5_000): Promise<string | null> {
  try {
    const res = await fetch(TRANSPARENCY_INDEX_URL, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const html = await res.text();
    const re = /https:\/\/6778953\.fs1\.hubspotusercontent-na1\.net\/hubfs\/6778953\/USDCAttestationReports\/\d{4}\/[^"'\s)]+\.pdf/g;
    const urls = Array.from(html.matchAll(re), m => m[0]);
    if (urls.length === 0) return null;
    // Pick the URL with the latest parseable date.
    let best: { url: string; ts: number } | null = null;
    for (const url of urls) {
      const ts = parseDateFromUrl(url);
      if (ts === null) continue;
      if (!best || ts > best.ts) best = { url, ts };
    }
    return best ? best.url : (urls[0] ?? null);
  } catch {
    return null;
  }
}

interface FetchedReport {
  url: string;
  sha256: string;
  contentLength: number;
  attestationDateMs: number | null;
  fetchedAt: number;
}

async function fetchAndHashPdf(url: string, timeoutMs = 15_000): Promise<FetchedReport | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) return null;
    // Sanity: PDF magic bytes %PDF (25 50 44 46). Defends against the CDN
    // returning a redirect-HTML page on 200 OK.
    if (!(buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46)) {
      return null;
    }
    return {
      url,
      sha256:            createHash('sha256').update(buf).digest('hex'),
      contentLength:     buf.length,
      attestationDateMs: parseDateFromUrl(url),
      fetchedAt:         Date.now(),
    };
  } catch {
    return null;
  }
}

async function getPrice(pair: string): Promise<AttestationQuote> {
  if (!SUPPORTED_PAIRS.has(pair)) {
    throw new Error(`circle-usdc-attestation: pair '${pair}' not supported`);
  }

  // URL resolution: env override > HTML scrape > hard-coded fallback.
  const candidates: string[] = [];
  const envUrl = process.env.CIRCLE_USDC_ATTESTATION_URL;
  if (envUrl) candidates.push(envUrl);
  const discovered = await discoverLatestUrl();
  if (discovered && discovered !== envUrl) candidates.push(discovered);
  if (FALLBACK_PDF_URL !== envUrl && FALLBACK_PDF_URL !== discovered) candidates.push(FALLBACK_PDF_URL);

  let report: FetchedReport | null = null;
  let lastTried = '';
  for (const url of candidates) {
    lastTried = url;
    report = await fetchAndHashPdf(url);
    if (report) break;
  }
  if (!report) {
    throw new Error(
      `circle-usdc-attestation: could not fetch a valid PDF from any candidate (last tried: ${lastTried || '<none>'}). ` +
      `Set CIRCLE_USDC_ATTESTATION_URL to a known-good report URL to pin a specific month.`,
    );
  }

  // Timestamp for the AttestationQuote = end of the attested month, NOT the
  // fetch time. Stable-health computes ageMs from this — and for a monthly
  // attestation, age-since-publication is what the freshness signal needs.
  const ts = report.attestationDateMs ?? report.fetchedAt;

  return {
    kind: 'attestation',
    sourceName: SOURCE_NAME,
    pair,
    // Binary "attestation present" flag. Risk-score path treats unit=
    // 'attestation-binary' as off-chain-pdf-without-parsed-figure.
    value: 1.0,
    unit: 'attestation-binary',
    timestamp: ts,
    rawPayload: {
      attestationUrl:     report.url,
      sha256:             report.sha256,
      contentLengthBytes: report.contentLength,
      attestationDateMs:  report.attestationDateMs,
      attestationDateIso: report.attestationDateMs ? new Date(report.attestationDateMs).toISOString() : null,
      fetchedAtIso:       new Date(report.fetchedAt).toISOString(),
      auditor:            'Deloitte',
      attestationStandard:'AICPA Statements on Standards for Attestation Engagements',
      scope:              'global Circle USDC reserves (all chains, including Cardano via xReserve). NOT a Cardano-specific reserves breakdown.',
      pdfParsed:          false,
      note:               'PDF bytes hashed for audit trail. Open `attestationUrl` for the human-readable reserves figure — adapter intentionally does not parse PDF body to avoid format-drift fragility.',
    },
  };
}

function supportsPair(pair: string): boolean {
  return SUPPORTED_PAIRS.has(pair);
}

const adapter: PriceAdapter = { sourceName: SOURCE_NAME, getPrice, supportsPair };
assertIsAdapter(adapter, 'circle-usdc-attestation');

const exported = {
  ...adapter,
  // exposed for tests:
  _parseDateFromUrl: parseDateFromUrl,
  _FALLBACK_PDF_URL: FALLBACK_PDF_URL,
  _TRANSPARENCY_INDEX_URL: TRANSPARENCY_INDEX_URL,
};

export = exported;
