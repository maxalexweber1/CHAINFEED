/**
 * Orcfax v1 adapter.
 *
 * Reads price feeds from the Orcfax FactStatement (FS) script address via
 * the ODATANO bridge. Datum is Plutus `Datum<Statement<Rational>>` (Constr 0
 * everywhere). Price = num / denom — no validity-window field, so freshness
 * is computed against `created_at` plus a per-feed staleness factor.
 *
 * Hard-coded FS script addresses + token policies per network. The Orcfax
 * docs note these can be rotated via the FSP pointer; for production we
 * watch for FS hash changes (TODO at integration time, see `docs/research/orcfax-feeds.md`).
 *
 * Caveats deliberately accepted for v0.1:
 * - Two round trips per fetch (UTxO list + tx for inline datum). Phase-2
 *   cache absorbs this.
 * - Single live UTxO per feed assumption — pick max(created_at) across
 *   matching candidates so we tolerate Orcfax double-publishing on a
 *   deviation event.
 */

import * as CSL from '@emurgo/cardano-serialization-lib-nodejs';
import bridge from '../external/odatano-bridge';
import { assertIsAdapter, type PriceAdapter, type PriceQuote } from './types';

const SOURCE_NAME = 'orcfax';

interface NetworkCfg {
  fsScriptAddress: string;
  fsTokenPolicy: string;
}

interface FeedCfg {
  feedIdPrefix: string;
  intervalSeconds: number;
  stalenessFactor: number;
}

// FS script address + FS token policy per Cardano network.
// Asset name for FS token is the empty bytearray (empty string here).
// Source: docs/research/orcfax-feeds.md §2-3.
const NETWORK_CONFIG: Readonly<Record<string, NetworkCfg>> = Object.freeze({
  mainnet: {
    fsScriptAddress: 'addr1wyvnaejjzxanknsw5hm4raq4y6f4tfjsut3hqmmztn035jc4rpcfn',
    fsTokenPolicy:   '193ee65211bb3b4e0ea5f751f415269355a650e2e3706f625cdf1a4b',
  },
  preview: {
    fsScriptAddress: 'addr_test1wrnv3gc5462zgqtpj3s0qrrfmc73hxtdkkydgppzgwjtykg9t3l2f',
    fsTokenPolicy:   'e6c8a314ae942401619460f00c69de3d1b996db588d4042243a4b259',
  },
  preprod: {
    fsScriptAddress: 'addr_test1wraqlpezmu3h9n9mxey6y03u2sdd0e8cyx9n2qxscz6staczrlnuj',
    fsTokenPolicy:   'fa0f8722df2372ccbb3649a23e3c541ad7e4f8218b3500d0c0b505f7',
  },
});

// Per-pair feed metadata. `feedIdPrefix` MUST end with the trailing slash
// so that `CER/ADA-USD/3` matches but `CER/ADA-USDM/3` does not.
//
// Scope (post 2026-05-02 pivot): only stable-denominated ADA pairs. Other
// Orcfax mainnet pairs (FACT-ADA, CBLP-ADA, SNEK-ADA, MIN-ADA, IAG-ADA,
// LQ-ADA, WMTX-ADA, INDY-ADA) deliberately removed — out of CHAINFEED scope.
const FEED_CONFIG: Readonly<Record<string, FeedCfg>> = Object.freeze({
  'ADA-USD':  { feedIdPrefix: 'CER/ADA-USD/',  intervalSeconds: 3600,  stalenessFactor: 1.5 },
  'ADA-USDM': { feedIdPrefix: 'CER/ADA-USDM/', intervalSeconds: 3600,  stalenessFactor: 1.5 },
  'ADA-DJED': { feedIdPrefix: 'CER/ADA-DJED/', intervalSeconds: 3600,  stalenessFactor: 1.5 },
  'ADA-iUSD': { feedIdPrefix: 'CER/ADA-iUSD/', intervalSeconds: 3600,  stalenessFactor: 1.5 },
});

interface DecodedStatement {
  feedId: string;
  feedIdHex: string;
  createdAt: number;
  num: string;
  denom: string;
}

interface GetPriceOpts {
  network?: string;
}

function resolveNetwork(): string {
  // Orcfax can run on a different network than ODATANO's primary backend
  // (e.g. preprod USDM x402 + mainnet Orcfax reads). Allow override.
  return process.env.ORCFAX_NETWORK || process.env.NETWORK || 'preview';
}

/**
 * Decode an Orcfax v1 inline datum (hex CBOR) into a structured statement.
 * Throws if the CBOR doesn't match the v1 shape.
 */
function decodeStatementDatum(datumHex: string): DecodedStatement {
  const root = CSL.PlutusData.from_hex(datumHex);
  const datumConstr = root.as_constr_plutus_data();
  if (!datumConstr) throw new Error('orcfax datum: outer is not a Constr');
  if (datumConstr.alternative().to_str() !== '0') {
    throw new Error(`orcfax datum: outer alternative is ${datumConstr.alternative().to_str()}, expected 0`);
  }
  const datumFields = datumConstr.data();
  if (datumFields.len() < 2) {
    throw new Error('orcfax datum: outer Constr has too few fields');
  }

  // Fields: [statement, context]. We ignore context per Orcfax integrator note.
  const stmt = datumFields.get(0).as_constr_plutus_data();
  if (!stmt || stmt.alternative().to_str() !== '0') {
    throw new Error('orcfax datum: statement is not Constr 0');
  }
  const stmtFields = stmt.data();
  if (stmtFields.len() < 3) {
    throw new Error('orcfax datum: statement has too few fields');
  }

  const feedIdBytes = stmtFields.get(0).as_bytes();
  if (!feedIdBytes) throw new Error('orcfax datum: feed_id is not bytes');
  const feedIdHex = Buffer.from(feedIdBytes).toString('hex');
  const feedId    = Buffer.from(feedIdBytes).toString('utf8');

  const createdAtBn = stmtFields.get(1).as_integer();
  if (!createdAtBn) throw new Error('orcfax datum: created_at is not int');
  const createdAt = Number(createdAtBn.to_str());

  const body = stmtFields.get(2).as_constr_plutus_data();
  if (!body || body.alternative().to_str() !== '0') {
    throw new Error('orcfax datum: body is not Constr 0 (expected Rational)');
  }
  const bodyFields = body.data();
  if (bodyFields.len() < 2) {
    throw new Error('orcfax datum: body has fewer than 2 fields (expected num, denom)');
  }
  const numInt = bodyFields.get(0).as_integer();
  const denInt = bodyFields.get(1).as_integer();
  if (!numInt || !denInt) throw new Error('orcfax datum: num/denom not integers');
  const num   = numInt.to_str();
  const denom = denInt.to_str();

  return { feedId, feedIdHex, createdAt, num, denom };
}

/**
 * Compute the price as a JS Number from the Rational body.
 * For very large nums/denoms we may lose precision — for v0.1 this is fine
 * since CHAINFEED's `Decimal(20,10)` schema also can't hold arbitrary precision.
 * If we ever need exact arithmetic, expose the BigInt num/denom on the quote.
 */
function rationalToNumber(numStr: string, denomStr: string): number {
  const num = BigInt(numStr);
  const den = BigInt(denomStr);
  if (den === 0n) throw new Error('orcfax: denom is zero');
  // 12-digit fixed-point intermediate, then convert.
  const SCALE = 1_000_000_000_000n;
  const scaled = (num * SCALE) / den;
  return Number(scaled) / Number(SCALE);
}

/**
 * Walk every UTxO at the FS script address, keep those carrying the FS
 * token, fetch their inline datums, decode, filter by feed_id prefix,
 * pick the one with the largest `created_at`. Stale-flag based on age.
 */
async function getPrice(pair: string, opts: GetPriceOpts = {}): Promise<PriceQuote> {
  const network = opts.network ?? resolveNetwork();
  const netCfg  = NETWORK_CONFIG[network];
  if (!netCfg) {
    // Surface explicitly. Without this throw, a missing/typo'd network env on
    // a mainnet deploy could silently fall through to whichever entry the
    // resolver defaults to (see `resolveNetwork`).
    throw new Error(`orcfax: unsupported network '${network}' — set ORCFAX_NETWORK or NETWORK to one of ${Object.keys(NETWORK_CONFIG).join(', ')}`);
  }

  const feedCfg = FEED_CONFIG[pair];
  if (!feedCfg) throw new Error(`orcfax: pair '${pair}' is not configured`);

  // 1. UTxOs at FS script address holding the FS token (asset name = empty)
  const utxos = await bridge.getUtxosWithAsset(
    netCfg.fsScriptAddress,
    netCfg.fsTokenPolicy,
    '',
  );
  if (utxos.length === 0) {
    throw new Error(`orcfax: no FS UTxOs at ${netCfg.fsScriptAddress} on ${network}`);
  }

  // 2. For each candidate, fetch its tx to get the inline datum on the
  //    output. We do these sequentially to keep concurrent Blockfrost
  //    pressure low — typical FS UTxO count is small (≤ ~20 across all feeds).
  const candidates: Array<{ utxo: typeof utxos[number]; stmt: DecodedStatement }> = [];
  for (const u of utxos) {
    const tx = await bridge.getTransactionByHash(u.txHash) as
      | { outputs?: Array<{ inlineDatum?: string }> }
      | null;
    if (!tx) continue;
    const out = (tx.outputs ?? [])[u.outputIndex];
    if (!out?.inlineDatum) continue;
    let stmt: DecodedStatement;
    try { stmt = decodeStatementDatum(out.inlineDatum); }
    catch { continue; }   // skip UTxOs with non-v1 datums (older versions, junk)

    if (!stmt.feedId.startsWith(feedCfg.feedIdPrefix)) continue;
    candidates.push({ utxo: u, stmt });
  }

  if (candidates.length === 0) {
    throw new Error(`orcfax: no UTxO at ${netCfg.fsScriptAddress} matched feed prefix '${feedCfg.feedIdPrefix}' on ${network}`);
  }

  // 3. Pick the latest by created_at (Orcfax may briefly have two live
  //    publications across an interval / deviation boundary).
  candidates.sort((a, b) => b.stmt.createdAt - a.stmt.createdAt);
  const winner = candidates[0]!;

  const price = rationalToNumber(winner.stmt.num, winner.stmt.denom);
  const ageMs = Date.now() - winner.stmt.createdAt;
  const staleAfterMs = feedCfg.intervalSeconds * 1000 * feedCfg.stalenessFactor;
  const isStale = ageMs > staleAfterMs;
  const validUntil = winner.stmt.createdAt + staleAfterMs;

  return {
    kind: 'price',
    sourceName: SOURCE_NAME,
    pair,
    price,
    timestamp:  winner.stmt.createdAt,
    validUntil,
    txHash:     winner.utxo.txHash,
    isStale,
    rawPayload: {
      feedId:    winner.stmt.feedId,
      num:       winner.stmt.num,
      denom:     winner.stmt.denom,
      createdAt: winner.stmt.createdAt,
      utxo:      `${winner.utxo.txHash}#${winner.utxo.outputIndex}`,
    },
  };
}

function supportsPair(pair: string): boolean {
  return Object.prototype.hasOwnProperty.call(FEED_CONFIG, pair);
}

const adapter: PriceAdapter = {
  sourceName: SOURCE_NAME,
  getPrice,
  supportsPair,
};
assertIsAdapter(adapter, 'orcfax');

const exported = {
  ...adapter,
  // exposed for tests:
  _decodeStatementDatum: decodeStatementDatum,
  _rationalToNumber: rationalToNumber,
  _NETWORK_CONFIG: NETWORK_CONFIG,
  _FEED_CONFIG: FEED_CONFIG,
};

export = exported;
