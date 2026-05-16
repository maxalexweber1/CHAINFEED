/**
 * Minswap V2 direct pool reader. Replaces the routed-through-DexHunter
 * pricing path for ADA-stable pairs.
 *
 * Reads ALL Minswap V2 pool UTxOs at the canonical pool script credential
 * `ea07b733d9...` (verified against the @minswap/sdk constants — see
 * `src/types/constants.ts` `DexV2Constant.CONFIG[NetworkId.MAINNET]`).
 * One bridge call returns ~3200 pool UTxOs; filtering by exact
 * `(policyId, assetNameHex)` tuple finds the deepest pool for the
 * requested pair.
 *
 * **Math is constant-product** — `spot = tokenUnits / adaUnits` for
 * ADA-base pairs. Live audit 2026-05-03 verified all 5 supported stables
 * route through CONSTANT_PRODUCT pools at this credential and the naive
 * ratio matches the live ADA-USD market (~0.248 ± 0.5 %). Minswap V2 also
 * deploys stableswap pools at the same credential for stable-stable pairs;
 * those don't apply here (we only quote ADA-X) but a runtime sanity band
 * (price ∈ [0.01, 100]) is enforced as a defensive trap should one ever
 * sneak into the ADA-paired set.
 *
 * **Per-call cost**: ~4 paginated Koios `credential_utxos` requests (1000
 * UTxOs each, ~3231 total). Cold full pull is ~3-6 s. We memoise the
 * UTxO list at module level with a 30 s TTL so all 5 supported pairs
 * share one upstream fetch per window. The registry's `withCache` wrapper
 * layers on top with the same TTL.
 *
 * **Why direct Koios HTTP, not the bridge**: as of @odatano/core 1.7.6,
 * `bridge.getUtxosAtCredential` returns only the first 1000 results from
 * Koios — no pagination. Indigo CDP (~500 UTxOs) fits inside that cap;
 * Minswap V2 (~3231 UTxOs at the pool credential) doesn't. The big stable
 * pools (~4.5 M ADA each) sit on later pages, so a non-paginated bridge
 * call returns no usable data for ADA-USDM/USDA. Migrate back to the
 * bridge once ODATANO ships internal pagination.
 *
 * Pool selection: deepest ADA reserve above a 10 k-ADA dust floor. For
 * shared-policy assets (Coti's DJED policy mints SHEN as well; Indigo's
 * iUSD policy mints iBTC/iETH/iSOL) the asset-name filter is what keeps
 * the right pool from being shadowed by a deeper sibling.
 *
 * Verified pools (live audit 2026-05-03):
 *   ADA-USDA  4.52 M ADA + 1.12 M USDA → spot 0.2483
 *   ADA-USDM  4.22 M ADA + 1.05 M USDM → spot 0.2490
 *   ADA-DJED  584 k ADA  + 145 k DJED  → spot 0.2485
 *   ADA-iUSD  544 k ADA  + 136 k iUSD  → spot 0.2499
 *   ADA-USDCx  26 k ADA  + 6.5 k USDCx → spot 0.2464  (small, but routable)
 */

import { postJson } from './http';
import { assertIsAdapter, type PriceAdapter, type PriceQuote } from './types';

const SOURCE_NAME = 'minswap-v2';

// Minswap V2 pool script credential (mainnet). Source: @minswap/sdk
// `DexV2Constant.CONFIG[NetworkId.MAINNET].poolScriptHash`.
const POOL_CREDENTIAL = 'ea07b733d932129c378af627436e7cbc2ef0bf96e0036bb51b3bde6b';

interface PairCfg {
  /** Non-ADA token's policy ID (28 bytes / 56 hex). */
  policyId: string;
  /** Non-ADA token's asset name in hex. */
  assetNameHex: string;
  /** Decimals of the non-ADA token. ADA is always 6. */
  tokenDecimals: number;
  /**
   * 'ada-base' (X-Y, X = ADA): spot = tokenUnits / adaUnits.
   * 'ada-quote' (X-ADA, X = non-ADA): spot = adaUnits / tokenUnits.
   */
  direction: 'ada-base' | 'ada-quote';
}

const PAIR_CONFIG: Readonly<Record<string, PairCfg>> = Object.freeze({
  'ADA-USDM': {
    policyId:      'c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad',
    assetNameHex:  '0014df105553444d',  // CIP-67 prefix + "USDM"
    tokenDecimals: 6,
    direction:     'ada-base',
  },
  'ADA-USDA': {
    policyId:      'fe7c786ab321f41c654ef6c1af7b3250a613c24e4213e0425a7ae456',
    assetNameHex:  '55534441',  // "USDA"
    tokenDecimals: 6,
    direction:     'ada-base',
  },
  'ADA-DJED': {
    policyId:      '8db269c3ec630e06ae29f74bc39edd1f87c819f1056206e879a1cd61',
    assetNameHex:  '446a65644d6963726f555344',  // "DjedMicroUSD" — disambiguates from SHEN
    tokenDecimals: 6,
    direction:     'ada-base',
  },
  'ADA-iUSD': {
    policyId:      'f66d78b4a3cb3d37afa0ec36461e51ecbde00f26c8f0a68f94b69880',
    assetNameHex:  '69555344',  // "iUSD" — disambiguates from iBTC/iETH/iSOL on shared policy
    tokenDecimals: 6,
    direction:     'ada-base',
  },
  'ADA-USDCx': {
    policyId:      '1f3aec8bfe7ea4fe14c5f121e2a92e301afe414147860d557cac7e34',
    assetNameHex:  '5553444378',  // "USDCx"
    tokenDecimals: 6,
    direction:     'ada-base',
  },
});

// Dust floor — Minswap V2 holds many sub-100-ADA legacy pool UTxOs that
// share an asset-name with a healthy pool. 10 k-ADA cutoff filters them
// without excluding the smaller-but-routable USDCx pool (~26 k ADA live).
const MIN_ADA_RESERVE_LOVELACE = 10_000n * 1_000_000n;

// Sanity band for spot — catches stableswap pools (which compute spot
// differently and would land far from the on-peg constant-product ratio)
// or genuinely broken pool data. Wide enough to allow ADA-USD swings into
// either tail of the realistic crypto cycle.
const SPOT_SANITY_MIN = 0.01;
const SPOT_SANITY_MAX = 100;

/** Koios credential_utxos response row (extended). Only fields we need. */
interface KoiosUtxoRow {
  tx_hash?: string;
  tx_index?: number;
  value?: string;            // lovelace
  asset_list?: Array<{ policy_id?: string; asset_name?: string; quantity?: string }>;
}

/** Normalised pool UTxO — internal shape used for filtering. */
interface PoolUtxo {
  txHash: string;
  outputIndex: number;
  lovelace: string;
  assets: Array<{ policyId: string; assetNameHex: string; quantity: string }>;
}

const KOIOS_URL = 'https://api.koios.rest/api/v1/credential_utxos';
const KOIOS_PAGE_SIZE = 1000;
const KOIOS_MAX_PAGES = 10;          // hard cap — Minswap V2 has ~3.2k UTxOs, room for growth

const SNAPSHOT_TTL_MS = 30_000;
interface CachedSnapshot { fetchedAtMs: number; utxos: PoolUtxo[]; generation: number }
let snapshot: CachedSnapshot | null = null;
let inflight: Promise<PoolUtxo[]> | null = null;
/**
 * Bumped by `invalidate()` (called from the watch-event handler when a pool
 * UTxO is consumed). Used to discard in-flight results that started against
 * the pre-invalidation chain state.
 */
let snapshotGeneration = 0;

function normaliseRow(r: KoiosUtxoRow): PoolUtxo {
  const assets = (r.asset_list ?? []).map(a => ({
    policyId:     a.policy_id ?? '',
    assetNameHex: a.asset_name ?? '',
    quantity:     a.quantity ?? '0',
  }));
  return {
    txHash:      r.tx_hash ?? '',
    outputIndex: r.tx_index ?? 0,
    lovelace:    r.value ?? '0',
    assets,
  };
}

async function fetchPage(offset: number): Promise<KoiosUtxoRow[]> {
  const url = `${KOIOS_URL}?limit=${KOIOS_PAGE_SIZE}&offset=${offset}`;
  const body = { _payment_credentials: [POOL_CREDENTIAL], _extended: true };
  const resp = await postJson<KoiosUtxoRow[]>(url, body, { timeoutMs: 30_000 });
  if (!Array.isArray(resp)) {
    throw new Error('minswap-v2: koios credential_utxos response not an array');
  }
  return resp;
}

async function loadPoolUtxos(): Promise<PoolUtxo[]> {
  const now = Date.now();
  if (snapshot && now - snapshot.fetchedAtMs < SNAPSHOT_TTL_MS) {
    return snapshot.utxos;
  }
  if (inflight) return inflight;
  // Snapshot the generation at fetch-start. If `invalidate()` bumps it
  // while we're paginating, drop the result so callers re-fetch.
  const startGen = snapshotGeneration;
  inflight = (async () => {
    try {
      const all: PoolUtxo[] = [];
      let lastPageSize = 0;
      let pagesFetched = 0;
      for (let page = 0; page < KOIOS_MAX_PAGES; page++) {
        const rows = await fetchPage(page * KOIOS_PAGE_SIZE);
        for (const r of rows) all.push(normaliseRow(r));
        lastPageSize = rows.length;
        pagesFetched = page + 1;
        if (rows.length < KOIOS_PAGE_SIZE) break;
      }
      // Defensive truncation guard. If we filled every page allowed, the
      // remote almost certainly had more rows — silently returning a
      // partial snapshot would let big pools fall outside the result set
      // (Minswap V2 sits ~3.2k UTxOs today, KOIOS_MAX_PAGES=10 → cap 10k).
      if (pagesFetched === KOIOS_MAX_PAGES && lastPageSize === KOIOS_PAGE_SIZE) {
        throw new Error(
          `minswap-v2: hit pagination cap (${KOIOS_MAX_PAGES} pages × ${KOIOS_PAGE_SIZE}) ` +
          `at credential ${POOL_CREDENTIAL} with last page full — raise KOIOS_MAX_PAGES.`,
        );
      }
      if (all.length === 0) {
        throw new Error('minswap-v2: koios returned no UTxOs at pool credential');
      }
      // Generation check: if `invalidate()` fired while we paginated, the
      // snapshot we'd write is already stale. Don't store it; the next
      // call will re-fetch.
      if (startGen === snapshotGeneration) {
        snapshot = { fetchedAtMs: Date.now(), utxos: all, generation: startGen };
      }
      return all;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * Drop the cached snapshot. Called by the registry's `invalidateSource`
 * hook on watch events. Bumps `snapshotGeneration` so any in-flight fetch
 * doesn't write stale data on completion.
 */
function invalidate(): void {
  snapshotGeneration++;
  snapshot = null;
}

/** Reset the in-memory snapshot cache. Used by tests to force a fresh fetch. */
function _resetCache(): void {
  snapshotGeneration++;
  snapshot = null;
  inflight = null;
}

async function getPrice(pair: string): Promise<PriceQuote> {
  const cfg = PAIR_CONFIG[pair];
  if (!cfg) throw new Error(`minswap-v2: pair '${pair}' not supported`);

  const utxos = await loadPoolUtxos();

  // Pick the pool with the deepest ADA reserve that contains exactly one
  // matching (policyId, assetNameHex) asset. The dust floor cuts out the
  // many-shaped legacy + sub-pool UTxOs at the same credential.
  let best: { lovelace: bigint; tokenQ: bigint; txHash?: string; outputIndex?: number } | null = null;
  for (const u of utxos) {
    const lovelace = BigInt(u.lovelace ?? '0');
    if (lovelace < MIN_ADA_RESERVE_LOVELACE) continue;
    const match = u.assets?.find(a =>
      a.policyId === cfg.policyId && a.assetNameHex === cfg.assetNameHex,
    );
    if (!match) continue;
    const tokenQ = BigInt(match.quantity ?? '0');
    if (tokenQ <= 0n) continue;
    if (!best || lovelace > best.lovelace) {
      best = { lovelace, tokenQ, txHash: u.txHash, outputIndex: u.outputIndex };
    }
  }
  if (!best) {
    throw new Error(`minswap-v2: no V2 pool for ${pair} above ${MIN_ADA_RESERVE_LOVELACE / 1_000_000n}-ADA dust floor`);
  }

  const adaUnits   = Number(best.lovelace) / 1_000_000;
  const tokenUnits = Number(best.tokenQ)   / 10 ** cfg.tokenDecimals;

  const price = cfg.direction === 'ada-base'
    ? tokenUnits / adaUnits
    : adaUnits   / tokenUnits;

  if (!Number.isFinite(price) || price < SPOT_SANITY_MIN || price > SPOT_SANITY_MAX) {
    throw new Error(`minswap-v2: ${pair} spot ${price} outside sanity band [${SPOT_SANITY_MIN}, ${SPOT_SANITY_MAX}] — likely stableswap pool or malformed data`);
  }

  return {
    kind:       'price',
    sourceName: SOURCE_NAME,
    pair,
    price,
    timestamp:  Date.now(),
    rawPayload: {
      poolCredential: POOL_CREDENTIAL,
      adaReserve:     best.lovelace.toString(),
      tokenReserve:   best.tokenQ.toString(),
      direction:      cfg.direction,
      utxoTxHash:     best.txHash,
      utxoOutputIndex: best.outputIndex,
      formula:        'constant-product spot — adjusted for direction',
    },
  };
}

function supportsPair(pair: string): boolean {
  return Object.prototype.hasOwnProperty.call(PAIR_CONFIG, pair);
}

const adapter: PriceAdapter = { sourceName: SOURCE_NAME, getPrice, supportsPair };
assertIsAdapter(adapter, 'minswap-v2');

const exported = {
  ...adapter,
  // invalidation hook for the registry's watch-event handler:
  invalidate,
  // exposed for tests:
  _resetCache,
  _PAIR_CONFIG: PAIR_CONFIG,
  _MIN_ADA_RESERVE_LOVELACE: MIN_ADA_RESERVE_LOVELACE,
  _POOL_CREDENTIAL: POOL_CREDENTIAL,
};

export = exported;
