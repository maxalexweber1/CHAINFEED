/**
 * Audit-pack builder — turns an `AggregatedPrices` row + its `PriceSources`
 * into a self-contained JSON envelope that consumers can verify offline.
 *
 * Why JSON, not ZIP: CHAINFEED's audit story is "every quote has on-chain
 * provenance — verify it yourself". A ZIP adds an unzip step and a binary
 * dep (no zip in Node stdlib). JSON-with-per-file-sha256 gives the same
 * tamper-detection guarantee with a far simpler consumer experience —
 * just `JSON.parse` and inspect.
 *
 * Pure function: takes already-loaded DB rows + adapter-side context,
 * returns an envelope object. No I/O. The CDS handler in price-service.ts
 * does the DB lookups and stringifies.
 *
 * Verification recipe (for consumers):
 *   1. Parse the envelope JSON.
 *   2. For each entry under `files`, compute sha256 of the file body
 *      (UTF-8 bytes, no filename prefix) and compare against
 *      `checksum.files[filename]`. The embedded README and
 *      `verifyAuditPack` both use this convention.
 *   3. For each `txHash` in `aggregator-meta.json` or per-source files,
 *      query the Cardano chain (any Blockfrost / Koios / Cardanoscan)
 *      and confirm the tx exists at the documented block height.
 *   4. Re-decode the inline datum from the tx output (per-source files
 *      include the datum hex when available) and recompute the price —
 *      verify it matches the per-source `price` in the audit pack.
 *
 * That recipe needs nothing CHAINFEED-specific. It works against bare
 * Cardano node access. That's the whole point.
 */

import { createHash } from 'node:crypto';

export const AUDIT_PACK_FORMAT = 'chainfeed-audit-pack-v1';

export interface AuditPackQuote {
  ID:               string;
  pair:             string;
  price:            number | string;
  sourcesUsed:      number;
  confidence:       number | string;
  deviationPct:     number | string;
  pegDeviationBps?: number | string | null;
  validFrom:        string;
  validUntil:       string;
  createdAt:        string;
}

export interface AuditPackSource {
  ID:           string;
  sourceName:   string;
  price:        number | string;
  txHash:       string;
  fetchedAt:    string;
  /** JSON string as stored in DB; we re-parse for the envelope. */
  rawPayload:   string;
}

export interface AuditPackContext {
  /** Hostname / API base for the CHAINFEED instance that emitted this pack. */
  serviceUrl:    string;
  /** ISO timestamp the pack was generated. */
  generatedAt:   string;
  /** Optional adapter-source-code commit / version, surfaced for reproducibility. */
  serviceVersion?: string;
}

export interface AuditPackEnvelope {
  format:    typeof AUDIT_PACK_FORMAT;
  quoteId:   string;
  pair:      string;
  generatedAt: string;
  serviceUrl: string;
  files:     Record<string, string>;
  checksum:  {
    algorithm: 'sha256';
    files:     Record<string, string>;
  };
  /** Quick-glance summary so consumers don't have to parse files just to
   *  know what they're looking at. */
  summary:   {
    aggregatedPrice:    number;
    sourcesUsed:        number;
    confidence:         number;
    deviationPct:       number;
    pegDeviationBps:    number | null;
    auditTxHashes:      string[];
    perSourceFiles:     string[];
  };
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Build a stable filename for a given source quote: `sources/<source>.json`. */
function sourceFilename(sourceName: string, suffix?: number): string {
  // Sanitize — keep only [a-z0-9-]
  const safe = sourceName.replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
  return suffix === undefined ? `sources/${safe}.json` : `sources/${safe}-${suffix}.json`;
}

const README_TEMPLATE = `# CHAINFEED Audit Pack

This file is a **self-contained** record of one aggregated price quote
emitted by CHAINFEED. It contains the per-source prices, on-chain
transaction hashes (where applicable), and the raw adapter payloads
that fed into the aggregation.

## How to verify

1. **File integrity**: each entry in \`files\` has a corresponding sha256
   in \`checksum.files\`. Compute sha256 of the file body and compare.
2. **On-chain provenance**: each per-source file under \`files['sources/...']\`
   may carry a \`txHash\`. Query any Cardano indexer (Blockfrost, Koios,
   Cardanoscan) and confirm the transaction was minted on mainnet/preprod.
3. **Price reproducibility**: the per-source raw payloads include enough
   information (UTxO references, decoded datum fields, pool reserves) to
   recompute the price independently. Compare against the per-source
   \`price\` in this pack.
4. **Aggregation reproducibility**: the aggregated price should equal
   \`median(per-source prices)\`. Confidence is \`1 - clamp(stddev / mean, 0, 1)\`,
   capped at 0.5 if only one source survived. See
   \`srv/aggregation/index.ts\` in the CHAINFEED repo for exact math.

## What's NOT in this pack

- Live oracle updates between \`validFrom\` and \`validUntil\` — those
  produce *different* aggregated quotes with their own audit packs.
- The CHAINFEED service binary or signing keys — this pack is signed
  by the data, not by the server. If two parties hold the same audit
  pack and follow the verification recipe, they will compute the same
  hashes regardless of which CHAINFEED node served either of them.

## Format version

\`${AUDIT_PACK_FORMAT}\` — see CHAINFEED docs/audit-pack-format.md for
the exact JSON schema. Stable; new fields will only be added in
backwards-compatible ways under a v2 format identifier.
`;

/**
 * Build the envelope. Pure — no I/O. Caller-prepared rows are stringified
 * here, hashed, and returned as one structured object. Caller's job:
 * `JSON.stringify(envelope, null, 2)` to produce the wire-bytes.
 */
export function buildAuditPack(
  quote:   AuditPackQuote,
  sources: ReadonlyArray<AuditPackSource>,
  ctx:     AuditPackContext,
): AuditPackEnvelope {
  const files: Record<string, string> = {};

  // ── README ────────────────────────────────────────────────────────
  files['README.md'] = README_TEMPLATE;

  // ── aggregator-meta.json ─────────────────────────────────────────
  files['aggregator-meta.json'] = JSON.stringify({
    quoteId:         quote.ID,
    pair:            quote.pair,
    price:           Number(quote.price),
    sourcesUsed:     quote.sourcesUsed,
    confidence:      Number(quote.confidence),
    deviationPct:    Number(quote.deviationPct),
    pegDeviationBps: quote.pegDeviationBps !== null && quote.pegDeviationBps !== undefined
                       ? Number(quote.pegDeviationBps) : null,
    validFrom:       quote.validFrom,
    validUntil:      quote.validUntil,
    createdAt:       quote.createdAt,
  }, null, 2);

  // ── per-source files ─────────────────────────────────────────────
  // De-duplicate filenames if two sources share a sanitized name (rare,
  // but defensible). Use a counter on collision.
  const sourceFiles: string[] = [];
  const usedNames = new Map<string, number>();
  for (const s of sources) {
    let baseName = sourceFilename(s.sourceName);
    if (usedNames.has(baseName)) {
      const i = (usedNames.get(baseName) ?? 0) + 1;
      usedNames.set(baseName, i);
      baseName = sourceFilename(s.sourceName, i);
    } else {
      usedNames.set(baseName, 0);
    }

    let parsedPayload: unknown = null;
    if (s.rawPayload) {
      try { parsedPayload = JSON.parse(s.rawPayload); }
      catch { parsedPayload = { rawPayloadString: s.rawPayload, parseError: 'rawPayload was not valid JSON' }; }
    }

    files[baseName] = JSON.stringify({
      sourceName: s.sourceName,
      price:      Number(s.price),
      txHash:     s.txHash || null,
      fetchedAt:  s.fetchedAt,
      rawPayload: parsedPayload,
    }, null, 2);
    sourceFiles.push(baseName);
  }

  // ── checksums ────────────────────────────────────────────────────
  const checksumFiles: Record<string, string> = {};
  for (const [name, body] of Object.entries(files)) {
    checksumFiles[name] = sha256Hex(body);
  }

  // ── summary ──────────────────────────────────────────────────────
  const txHashes = sources
    .map(s => s.txHash)
    .filter(h => typeof h === 'string' && h.length > 0);

  return {
    format:      AUDIT_PACK_FORMAT,
    quoteId:     quote.ID,
    pair:        quote.pair,
    generatedAt: ctx.generatedAt,
    serviceUrl:  ctx.serviceUrl,
    files,
    checksum: {
      algorithm: 'sha256',
      files:     checksumFiles,
    },
    summary: {
      aggregatedPrice: Number(quote.price),
      sourcesUsed:     quote.sourcesUsed,
      confidence:      Number(quote.confidence),
      deviationPct:    Number(quote.deviationPct),
      pegDeviationBps: quote.pegDeviationBps !== null && quote.pegDeviationBps !== undefined
                         ? Number(quote.pegDeviationBps) : null,
      auditTxHashes:   txHashes,
      perSourceFiles:  sourceFiles,
    },
  };
}

/**
 * Verify the integrity of an audit pack. Returns a list of mismatched
 * filenames, empty array if all hashes match. Useful for both consumer-
 * side verification and our own tests.
 */
export function verifyAuditPack(env: AuditPackEnvelope): string[] {
  const mismatches: string[] = [];
  for (const [name, body] of Object.entries(env.files)) {
    const expected = env.checksum.files[name];
    if (!expected) {
      mismatches.push(`${name}: missing checksum entry`);
      continue;
    }
    const actual = sha256Hex(body);
    if (actual !== expected) {
      mismatches.push(`${name}: sha256 mismatch (expected ${expected}, got ${actual})`);
    }
  }
  // Also flag checksums that have no corresponding file (delete-tampering).
  for (const name of Object.keys(env.checksum.files)) {
    if (!(name in env.files)) {
      mismatches.push(`${name}: in checksum but not in files`);
    }
  }
  return mismatches;
}
