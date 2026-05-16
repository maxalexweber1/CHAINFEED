/**
 * Charli3 oracle adapter.
 *
 * Reads price feeds from Charli3 oracle UTxOs via the ODATANO bridge. Two
 * contract families are supported transparently:
 *   - legacy ('charli3-network-feed'): discriminator NFT asset name 'OracleFeed'
 *   - ODV    ('charli3-odv'):          discriminator NFT asset name 'C3AS'
 *
 * Both variants share the same datum payload — `GenericData(Constr 0)` wrapping
 * `PriceData(Constr 2, PlutusMap)` with keys 0..9. We extract:
 *   0 = price  (raw integer)
 *   1 = creation timestamp (POSIX ms)
 *   2 = expiry timestamp   (POSIX ms)   ← authoritative, no heuristic
 *   3 = precision (decimal places, defaults to 6 if absent)
 *
 * Some feeds publish base/quote inverted relative to CHAINFEED's canonical
 * pair direction (e.g. Charli3 has USDM/ADA, CHAINFEED + Orcfax expose
 * ADA/USDM). For those we set `invert: true` and return `1/p`.
 *
 * Caveats accepted for v0.1 — same shape as the Orcfax adapter:
 *   - Two round trips per fetch (UTxO list + tx for inline datum). Cache
 *     wrapper at `srv/lib/cache.ts` absorbs this.
 *   - ODV `C3AS` may have multiple live aggregate-state UTxOs by design;
 *     we pick max(timestamp), same as Orcfax double-publishes.
 *   - "Empty" placeholder C3AS UTxOs that fail to decode or have price=0 are
 *     silently skipped — the Python reference reader does the same.
 *
 */

import * as CSL from '@emurgo/cardano-serialization-lib-nodejs';
import bridge from '../external/odatano-bridge';
import { assertIsAdapter, type PriceAdapter, type Quote } from './types';

const SOURCE_NAME = 'charli3';

type Variant = 'legacy' | 'odv';

interface FeedCfg {
  address: string;
  policyId: string;
  variant: Variant;
  /** true if on-chain feed direction is the inverse of our exposed pair */
  invert?: boolean;
  /**
   * Quote kind. Default 'price'. Set to 'attestation' for non-price feeds
   * such as USDM-RESERVES (Mehen bank-balance), where the datum's "price"
   * slot carries a USD reserve count rather than an exchange rate. The
   * datum CBOR shape is identical — only the consumer interpretation differs.
   */
  kind?: 'price' | 'attestation';
  /** Unit string for attestation feeds (e.g. 'usd'). Ignored for price feeds. */
  unit?: string;
}

// Discriminator NFT asset names (UTF-8 → hex). The bridge filters by
// (policyId + assetNameHex), so these are concatenated downstream.
const VARIANT_ASSET_NAME_HEX: Readonly<Record<Variant, string>> = Object.freeze({
  legacy: Buffer.from('OracleFeed', 'utf8').toString('hex'), // '4f7261636c6546656564'
  odv: Buffer.from('C3AS', 'utf8').toString('hex'), // '43334153'
});

// Per-network feed registry. Sourced verbatim from
// https://raw.githubusercontent.com/Charli3-Official/datum-demo-v3/main/{mainnet,preprod}-c3-networks.yaml
// — see docs/research/charli3-feeds.md §3.
//
// Pair naming follows CHAINFEED's canonical direction (matches Orcfax where
// they overlap). `invert: true` flips the on-chain quote at decode time.
const FEED_CONFIG = {
  mainnet: {
    'ADA-USD': { address: 'addr1wyvxns52tsgz8ggvrh4np5gjyfk0g5fshqq2ytvu9t7pe8qp3adw6', policyId: '08c56c0fa73748a23c3bc1d9e6a60a4187416fc4ff8fe3475506990e', variant: 'legacy' },
    'ADA-USDM': { address: 'addr1w98dq70hqh8we52jgnck535n277ajkz7pg9cpk275lkyt9gjjc97g', policyId: '36f3dc3a2a904b2678f4ebbe82dadbef1ad4144b3921d793b12a7e2f', variant: 'legacy', invert: true },
    'BTC-ADA': { address: 'addr1wyujem6fwxju9arc45lm98z0uwgwm0t8aerjp5mgahpgx7snfcpuu', policyId: '2e3ed96d283a549580e29dd6ec23e5f4a8020a8c1d7f2b95c4b2b4dd', variant: 'legacy' },
    'NIGHT-ADA': { address: 'addr1w8z46wa8ajgqj5zy90nrjp2hd4ssjtuuunpcuyfpplex4nclv9peu', policyId: '98fb91805ab677e06b71f26e5f1c700999c1addb75dbb7bb5d769029', variant: 'legacy' },
    // USDM-RESERVES — Mehen Proof-of-Reserve attestation feed. The datum
    // CBOR shape is the standard Charli3 PriceData (Constr 0 → Constr 2 →
    // PlutusMap{0,1,2,3}); the `price` slot carries Mehen's bank-balance
    // attestation in USD with `precision` decimals. Adapter returns this as
    // `kind: 'attestation'` so it never enters price aggregation.
    // Source: docs/research/charli3-feeds.md §3, oracle-datum-lib spec.cddl.
    'USDM-RESERVES': { address: 'addr1w88fmwyufz9vdqkukzhaerjxcfm488wsnyrft9cpjtd4utsnw5ym7', policyId: 'e7d54c2f5c81206e307e528855bb51e5ffe9295e3db348c4be74deec', variant: 'odv', kind: 'attestation', unit: 'usd' },
    // CHARLI3-ADA + ADA-CHARLI3 deliberately excluded: Charli3 oracle pricing
    // its own native token is a conflict of interest for downstream consumers.
    // Both verified live on 2026-04-30, just not exposed via this adapter.
  },
  preprod: {
    'ADA-USD': { address: 'addr_test1wq3pacs7jcrlwehpuy3ryj8kwvsqzjp9z6dpmx8txnr0vkq6vqeuu', policyId: '886dcb2363e160c944e63cf544ce6f6265b22ef7c4e2478dd975078e', variant: 'odv' },
    'BTC-USD': { address: 'addr_test1wq3pacs7jcrlwehpuy3ryj8kwvsqzjp9z6dpmx8txnr0vkq6vqeuu', policyId: '43d766bafc64c96754353e9686fac6130990a4f8568b3a2f76e2643f', variant: 'odv' },
    'ADA-USDM': { address: 'addr_test1wq3pacs7jcrlwehpuy3ryj8kwvsqzjp9z6dpmx8txnr0vkq6vqeuu', policyId: 'fcc738fa9ae006bc8de82385ff3457a2817ccc4eaa5ce53a61334674', variant: 'odv', invert: true },
    // ADA-CHARLI3 dropped 2026-04-30: smoke-charli3.ts showed 0 UTxOs under
    // the YAML-documented policy 5e4a2431… at addr_test1wr64gtafm…. Either
    // the preprod legacy contract was retired or the YAML is stale. Re-add
    // only after a fresh smoke confirms live UTxOs. Mainnet feeds unaffected.
  },
} as const satisfies Readonly<Record<string, Readonly<Record<string, FeedCfg>>>>;

// Typed accessor — collapses the strict literal-type wall so we can index by
// arbitrary `string` at runtime while keeping `as const` for compile-time
// validation of the literal shape.
type FeedConfigLoose = Readonly<Record<string, Readonly<Record<string, FeedCfg>>>>;
function lookupFeedCfg(network: string, pair: string): FeedCfg | undefined {
  return (FEED_CONFIG as FeedConfigLoose)[network]?.[pair];
}

interface DecodedPrice {
  /** raw integer price as string (BigInt-safe) */
  price: string;
  /** epoch ms — feed creation */
  timestamp: number;
  /** epoch ms — authoritative expiry from datum */
  expiry: number;
  /** decimal places to apply to `price` (default 6) */
  precision: number;
}

interface GetPriceOpts {
  network?: string;
}

function resolveNetwork(): string {
  // Charli3 has no preview deployment. If NETWORK=preview is set globally,
  // the user must opt into Charli3's network explicitly via CHARLI3_NETWORK,
  // otherwise we throw on getPrice — better than silently mismatching.
  return process.env.CHARLI3_NETWORK || process.env.NETWORK || 'preprod';
}

/**
 * One-shot warning when Charli3 is asked to serve a network it has no feeds
 * for (today: anything other than mainnet/preprod, e.g. preview). The
 * aggregator otherwise just drops Charli3 silently from every pair —
 * surprising during dev, and confusing in incident postmortems.
 */
let _unsupportedNetworkWarned: string | null = null;
function warnOnceIfUnsupportedNetwork(network: string): void {
  if (_unsupportedNetworkWarned === network) return;
  if (network === 'mainnet' || network === 'preprod') return;
  _unsupportedNetworkWarned = network;
  // eslint-disable-next-line no-console
  console.warn(
    `[charli3] network '${network}' has no Charli3 deployment — every pair will be reported as unsupported. ` +
    `Set CHARLI3_NETWORK=mainnet (or preprod) to keep Charli3 in the fanout.`,
  );
}

/**
 * Decode a Charli3 oracle inline datum (hex CBOR) into a structured price.
 * Throws if the CBOR doesn't match the documented `GenericData → PriceData`
 * shape, or if any required price_map field (price, timestamp, expiry) is
 * missing or non-positive.
 */
function decodeCharli3Datum(datumHex: string): DecodedPrice {
  const root = CSL.PlutusData.from_hex(datumHex);
  const outer = root.as_constr_plutus_data();
  if (!outer) throw new Error('charli3 datum: outer is not a Constr');
  if (outer.alternative().to_str() !== '0') {
    throw new Error(`charli3 datum: outer alt is ${outer.alternative().to_str()}, expected 0`);
  }

  // Per CDDL: oracle_datum = #6.121([ ?shared, 1*generic, ?extended ]).
  // Scan outer fields for the first Constr 2 (price_data); shared_data is
  // Constr 0 and extended_data is Constr 1 — both safely skipped.
  const outerFields = outer.data();
  let priceDataConstr: CSL.ConstrPlutusData | null = null;
  for (let i = 0; i < outerFields.len(); i++) {
    const c = outerFields.get(i).as_constr_plutus_data();
    if (c && c.alternative().to_str() === '2') { priceDataConstr = c; break; }
  }
  if (!priceDataConstr) throw new Error('charli3 datum: no Constr 2 (price_data) under outer');

  const pdFields = priceDataConstr.data();
  if (pdFields.len() < 1) throw new Error('charli3 datum: price_data has no fields');

  const priceMap = pdFields.get(0).as_map();
  if (!priceMap) throw new Error('charli3 datum: price_data field 0 is not a Map');

  // Resolve a single integer-keyed value from the price_map. PlutusMap.get
  // returns PlutusMapValues; we take element 0 (CDDL forbids duplicate keys).
  const lookup = (key: number): CSL.PlutusData | null => {
    const keyData = CSL.PlutusData.new_integer(CSL.BigInt.from_str(String(key)));
    const values = priceMap.get(keyData);
    if (!values || values.len() === 0) return null;
    return values.get(0) ?? null;
  };

  const priceV = lookup(0);
  const tsV = lookup(1);
  const expV = lookup(2);
  const precV = lookup(3);

  if (!priceV || !tsV || !expV) {
    throw new Error('charli3 datum: price_map missing required keys 0/1/2');
  }

  const priceI = priceV.as_integer();
  const tsI = tsV.as_integer();
  const expI = expV.as_integer();
  if (!priceI || !tsI || !expI) {
    throw new Error('charli3 datum: price/timestamp/expiry not integers');
  }

  let precision = 6;
  if (precV) {
    const p = precV.as_integer();
    if (p) precision = Number(p.to_str());
  }
  // Upper bound 18 = Cardano-native maximum decimal places; anything beyond
  // is a misencoded datum and would push `rawToNumber` to underflow to 0
  // (and then `invert: true` flips that to `Infinity`).
  if (!Number.isFinite(precision) || precision < 0 || precision > 18) {
    throw new Error(`charli3 datum: precision out of plausible range (${precision})`);
  }

  const priceStr = priceI.to_str();
  if (priceStr === '0') {
    // Empty ODV C3AS placeholder — caller skips these.
    throw new Error('charli3 datum: price is zero (empty placeholder)');
  }

  return {
    price: priceStr,
    timestamp: Number(tsI.to_str()),
    expiry: Number(expI.to_str()),
    precision,
  };
}

/**
 * Convert a fixed-point integer price to a JS number using the datum's
 * precision field. Uses a 12-digit fixed-point intermediate to preserve
 * precision for typical sub-dollar to large-cap ranges. For exact
 * arithmetic the BigInt `price` + `precision` are exposed on rawPayload.
 */
function rawToNumber(rawPrice: string, precision: number): number {
  const n = BigInt(rawPrice);
  const denom = 10n ** BigInt(precision);
  if (denom === 0n) throw new Error('charli3: precision yields zero denom');
  const SCALE = 1_000_000_000_000n;   // 12-digit working precision
  const scaled = (n * SCALE) / denom;
  return Number(scaled) / Number(SCALE);
}

interface UtxoLite {
  txHash: string;
  outputIndex: number;
}

async function getPrice(pair: string, opts: GetPriceOpts = {}): Promise<Quote> {
  const network = opts.network ?? resolveNetwork();
  warnOnceIfUnsupportedNetwork(network);
  if (!(FEED_CONFIG as FeedConfigLoose)[network]) {
    throw new Error(`charli3: unsupported network '${network}' (mainnet, preprod)`);
  }
  const feedCfg = lookupFeedCfg(network, pair);
  if (!feedCfg) {
    throw new Error(`charli3: pair '${pair}' is not configured on ${network}`);
  }

  const assetNameHex = VARIANT_ASSET_NAME_HEX[feedCfg.variant];

  // 1. UTxOs at the oracle script address holding the discriminator NFT.
  //    Bridge filter is policy+assetName, so cross-feed bleed (preprod ODV
  //    addresses are shared across feeds) is prevented at the bridge layer.
  const utxos = await bridge.getUtxosWithAsset(
    feedCfg.address,
    feedCfg.policyId,
    assetNameHex,
  ) as UtxoLite[];
  if (utxos.length === 0) {
    throw new Error(`charli3: no oracle UTxOs at ${feedCfg.address} for ${pair} on ${network}`);
  }

  // 2. Pull each candidate's tx for the inline datum, decode, keep only ones
  //    that decode to a non-empty price. Sequential to keep Blockfrost pressure
  //    low — typical live UTxO count per feed is ≤ a handful.
  const candidates: Array<{ utxo: UtxoLite; price: DecodedPrice }> = [];
  for (const u of utxos) {
    const tx = await bridge.getTransactionByHash(u.txHash) as
      | { outputs?: Array<{ inlineDatum?: string }> }
      | null;
    if (!tx) continue;
    const out = (tx.outputs ?? [])[u.outputIndex];
    if (!out?.inlineDatum) continue;
    let dec: DecodedPrice;
    try { dec = decodeCharli3Datum(out.inlineDatum); }
    catch { continue; }   // skip empty C3AS placeholders + non-conforming junk
    candidates.push({ utxo: u, price: dec });
  }

  if (candidates.length === 0) {
    throw new Error(`charli3: no decodable feed UTxO for ${pair} at ${feedCfg.address} on ${network}`);
  }

  // 3. Pick the freshest by datum timestamp (handles ODV parallel-aggregation
  //    UTxOs and any briefly co-existing publications on a heartbeat boundary).
  candidates.sort((a, b) => b.price.timestamp - a.price.timestamp);
  const winner = candidates[0]!;

  let priceNum = rawToNumber(winner.price.price, winner.price.precision);
  if (feedCfg.invert) {
    if (priceNum === 0) throw new Error('charli3: cannot invert zero value');
    priceNum = 1 / priceNum;
  }

  const isStale = Date.now() > winner.price.expiry;

  const baseFields = {
    sourceName: SOURCE_NAME,
    pair,
    timestamp: winner.price.timestamp,
    validUntil: winner.price.expiry,
    txHash: winner.utxo.txHash,
    isStale,
    rawPayload: {
      variant: feedCfg.variant,
      inverted: Boolean(feedCfg.invert),
      rawPrice: winner.price.price,
      precision: winner.price.precision,
      timestamp: winner.price.timestamp,
      expiry: winner.price.expiry,
      utxo: `${winner.utxo.txHash}#${winner.utxo.outputIndex}`,
    },
  };

  if (feedCfg.kind === 'attestation') {
    return {
      kind: 'attestation',
      ...baseFields,
      value: priceNum,
      unit: feedCfg.unit ?? 'usd',
    };
  }

  return {
    kind: 'price',
    ...baseFields,
    price: priceNum,
  };
}

function supportsPair(pair: string): boolean {
  return lookupFeedCfg(resolveNetwork(), pair) !== undefined;
}

const adapter: PriceAdapter = { sourceName: SOURCE_NAME, getPrice, supportsPair };
assertIsAdapter(adapter, 'charli3');

const exported = {
  ...adapter,
  // exposed for tests:
  _decodeCharli3Datum: decodeCharli3Datum,
  _rawToNumber: rawToNumber,
  _FEED_CONFIG: FEED_CONFIG,
  _VARIANT_ASSET_NAME_HEX: VARIANT_ASSET_NAME_HEX,
};

export = exported;
