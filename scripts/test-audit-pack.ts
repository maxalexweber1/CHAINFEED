/**
 * Audit-pack pure-fn tests. Pure-Node, no DB / CDS boot.
 *
 * Run: npx tsx scripts/test-audit-pack.ts
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  buildAuditPack, verifyAuditPack, AUDIT_PACK_FORMAT,
  type AuditPackQuote, type AuditPackSource, type AuditPackContext,
} from '../srv/lib/audit-pack';

let n = 0, fails = 0;
function t(name: string, fn: () => void) {
  n++;
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) {
    fails++;
    const err = e as Error;
    console.log(`FAIL  ${name}\n      ${err.stack || err.message}`);
  }
}

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

// ── fixtures ─────────────────────────────────────────────────────────
function quoteFixture(overrides: Partial<AuditPackQuote> = {}): AuditPackQuote {
  return {
    ID:              'aaaaaaaa-1111-1111-1111-111111111111',
    pair:            'ADA-USDM',
    price:           0.247,
    sourcesUsed:     3,
    confidence:      0.985,
    deviationPct:    0.42,
    pegDeviationBps: -3.2,
    validFrom:       '2026-05-02T12:00:00.000Z',
    validUntil:      '2026-05-02T13:00:00.000Z',
    createdAt:       '2026-05-02T12:30:00.000Z',
    ...overrides,
  };
}

function sourceFixture(overrides: Partial<AuditPackSource> = {}): AuditPackSource {
  return {
    ID:         'bbbbbbbb-2222-2222-2222-222222222222',
    sourceName: 'orcfax',
    price:      0.2475,
    txHash:     'aa'.repeat(32),
    fetchedAt:  '2026-05-02T12:29:55.000Z',
    rawPayload: JSON.stringify({ feedId: 'CER/ADA-USD/3', utxo: 'aa..#0' }),
    ...overrides,
  };
}

const CTX: AuditPackContext = {
  serviceUrl:    'https://chainfeed.example.com',
  generatedAt:   '2026-05-02T13:00:00.000Z',
};

console.log('audit-pack ──────────────────────────────────────────────');

// ── envelope shape ───────────────────────────────────────────────────
t('format identifier matches', () => {
  const e = buildAuditPack(quoteFixture(), [sourceFixture()], CTX);
  assert.equal(e.format, AUDIT_PACK_FORMAT);
});

t('top-level fields populated from quote + ctx', () => {
  const e = buildAuditPack(quoteFixture(), [sourceFixture()], CTX);
  assert.equal(e.quoteId, 'aaaaaaaa-1111-1111-1111-111111111111');
  assert.equal(e.pair, 'ADA-USDM');
  assert.equal(e.generatedAt, CTX.generatedAt);
  assert.equal(e.serviceUrl, CTX.serviceUrl);
});

t('always emits README.md + aggregator-meta.json files', () => {
  const e = buildAuditPack(quoteFixture(), [sourceFixture()], CTX);
  assert.ok('README.md' in e.files);
  assert.ok('aggregator-meta.json' in e.files);
  assert.ok(e.files['README.md']!.startsWith('# CHAINFEED Audit Pack'));
});

// ── per-source files ────────────────────────────────────────────────
t('one source → one sources/orcfax.json file', () => {
  const e = buildAuditPack(quoteFixture(), [sourceFixture()], CTX);
  assert.ok('sources/orcfax.json' in e.files);
  assert.equal(e.summary.perSourceFiles.length, 1);
  assert.equal(e.summary.perSourceFiles[0], 'sources/orcfax.json');
});

t('three sources → three distinct files (one per source)', () => {
  const e = buildAuditPack(
    quoteFixture(),
    [
      sourceFixture({ sourceName: 'orcfax',  txHash: 'aa'.repeat(32) }),
      sourceFixture({ sourceName: 'charli3', txHash: 'bb'.repeat(32) }),
      sourceFixture({ sourceName: 'minswap', txHash: '' }),
    ],
    CTX,
  );
  assert.equal(e.summary.perSourceFiles.length, 3);
  assert.deepEqual(
    e.summary.perSourceFiles.sort(),
    ['sources/charli3.json', 'sources/minswap.json', 'sources/orcfax.json'],
  );
});

t('duplicate-named sources get a counter suffix to avoid collision', () => {
  const e = buildAuditPack(
    quoteFixture(),
    [
      sourceFixture({ sourceName: 'orcfax', txHash: 'aa'.repeat(32) }),
      sourceFixture({ sourceName: 'orcfax', txHash: 'bb'.repeat(32) }),
    ],
    CTX,
  );
  assert.equal(e.summary.perSourceFiles.length, 2);
  assert.ok(e.summary.perSourceFiles.includes('sources/orcfax.json'));
  assert.ok(e.summary.perSourceFiles.includes('sources/orcfax-1.json'));
});

t('sanitises source names with non-[a-z0-9-] characters', () => {
  const e = buildAuditPack(
    quoteFixture(),
    [sourceFixture({ sourceName: 'circle-usdc/attestation' })],
    CTX,
  );
  assert.ok('sources/circle-usdc-attestation.json' in e.files);
});

t('per-source file body parses cleanly + preserves txHash', () => {
  const e = buildAuditPack(quoteFixture(), [sourceFixture({ sourceName: 'orcfax', txHash: 'cd'.repeat(32) })], CTX);
  const body = JSON.parse(e.files['sources/orcfax.json']!);
  assert.equal(body.sourceName, 'orcfax');
  assert.equal(body.price, 0.2475);
  assert.equal(body.txHash, 'cd'.repeat(32));
  assert.deepEqual(body.rawPayload, { feedId: 'CER/ADA-USD/3', utxo: 'aa..#0' });
});

t('per-source file falls back gracefully when rawPayload is malformed JSON', () => {
  const e = buildAuditPack(
    quoteFixture(),
    [sourceFixture({ sourceName: 'orcfax', rawPayload: 'not-json{{{' })],
    CTX,
  );
  const body = JSON.parse(e.files['sources/orcfax.json']!);
  assert.equal(body.rawPayload.parseError, 'rawPayload was not valid JSON');
  assert.equal(body.rawPayload.rawPayloadString, 'not-json{{{');
});

t('txHash is null in per-source file when source did not provide one (DEX adapters)', () => {
  const e = buildAuditPack(quoteFixture(), [sourceFixture({ sourceName: 'minswap', txHash: '' })], CTX);
  const body = JSON.parse(e.files['sources/minswap.json']!);
  assert.equal(body.txHash, null);
});

// ── aggregator-meta content ─────────────────────────────────────────
t('aggregator-meta.json carries all quote fields', () => {
  const e = buildAuditPack(quoteFixture({ pegDeviationBps: -3.2 }), [sourceFixture()], CTX);
  const meta = JSON.parse(e.files['aggregator-meta.json']!);
  assert.equal(meta.quoteId, 'aaaaaaaa-1111-1111-1111-111111111111');
  assert.equal(meta.pair, 'ADA-USDM');
  assert.equal(meta.price, 0.247);
  assert.equal(meta.sourcesUsed, 3);
  assert.equal(meta.pegDeviationBps, -3.2);
});

t('aggregator-meta.json: pegDeviationBps null when not a stable pair', () => {
  const e = buildAuditPack(
    quoteFixture({ pair: 'BTC-ADA', pegDeviationBps: null }),
    [sourceFixture()],
    CTX,
  );
  const meta = JSON.parse(e.files['aggregator-meta.json']!);
  assert.equal(meta.pegDeviationBps, null);
});

// ── checksums ───────────────────────────────────────────────────────
t('every file has a checksum entry', () => {
  const e = buildAuditPack(
    quoteFixture(),
    [sourceFixture({ sourceName: 'orcfax' }), sourceFixture({ sourceName: 'charli3' })],
    CTX,
  );
  for (const name of Object.keys(e.files)) {
    assert.ok(e.checksum.files[name], `${name}: missing checksum`);
    assert.equal(e.checksum.files[name]!.length, 64, `${name}: not a 64-hex sha256`);
  }
});

t('checksums are correct sha256 of file bodies', () => {
  const e = buildAuditPack(quoteFixture(), [sourceFixture()], CTX);
  for (const [name, body] of Object.entries(e.files)) {
    assert.equal(e.checksum.files[name], sha256(body),
      `${name}: checksum doesn't match recomputed sha256`);
  }
});

// ── verifyAuditPack ─────────────────────────────────────────────────
t('verifyAuditPack: well-formed pack → empty mismatch array', () => {
  const e = buildAuditPack(quoteFixture(), [sourceFixture(), sourceFixture({ sourceName: 'charli3' })], CTX);
  assert.deepEqual(verifyAuditPack(e), []);
});

t('verifyAuditPack: tampered file body → mismatch flagged', () => {
  const e = buildAuditPack(quoteFixture(), [sourceFixture()], CTX);
  // Tamper with the README body without updating the checksum.
  e.files['README.md'] = e.files['README.md']! + '\n<!-- injected -->';
  const m = verifyAuditPack(e);
  assert.equal(m.length, 1);
  assert.match(m[0]!, /README\.md.*sha256 mismatch/);
});

t('verifyAuditPack: missing checksum entry → flagged', () => {
  const e = buildAuditPack(quoteFixture(), [sourceFixture()], CTX);
  delete (e.checksum.files as Record<string, string>)['README.md'];
  const m = verifyAuditPack(e);
  assert.equal(m.length, 1);
  assert.match(m[0]!, /README\.md.*missing checksum/);
});

t('verifyAuditPack: dangling checksum entry → flagged (delete-tampering)', () => {
  const e = buildAuditPack(quoteFixture(), [sourceFixture()], CTX);
  delete (e.files as Record<string, string>)['README.md'];
  const m = verifyAuditPack(e);
  assert.ok(m.some(x => x.includes('README.md') && x.includes('not in files')));
});

// ── summary block ───────────────────────────────────────────────────
t('summary collects auditTxHashes from sources, skipping empty', () => {
  const e = buildAuditPack(
    quoteFixture(),
    [
      sourceFixture({ sourceName: 'orcfax',     txHash: 'aa'.repeat(32) }),
      sourceFixture({ sourceName: 'charli3',    txHash: 'bb'.repeat(32) }),
      sourceFixture({ sourceName: 'minswap',    txHash: '' }),
      sourceFixture({ sourceName: 'sundae',     txHash: '' }),
    ],
    CTX,
  );
  assert.deepEqual(e.summary.auditTxHashes, ['aa'.repeat(32), 'bb'.repeat(32)]);
});

t('summary numeric fields match aggregator-meta', () => {
  const e = buildAuditPack(quoteFixture(), [sourceFixture()], CTX);
  assert.equal(e.summary.aggregatedPrice, 0.247);
  assert.equal(e.summary.sourcesUsed, 3);
  assert.equal(e.summary.confidence, 0.985);
  assert.equal(e.summary.deviationPct, 0.42);
});

// ── round-trip ──────────────────────────────────────────────────────
t('full round-trip: build → JSON.stringify → JSON.parse → verifyAuditPack passes', () => {
  const e1 = buildAuditPack(
    quoteFixture(),
    [sourceFixture({ sourceName: 'orcfax' }), sourceFixture({ sourceName: 'charli3' })],
    CTX,
  );
  const wire = JSON.stringify(e1);
  const e2 = JSON.parse(wire);
  assert.deepEqual(verifyAuditPack(e2), []);
});

console.log(`\n${n - fails}/${n} passed`);
process.exit(fails ? 1 : 0);
