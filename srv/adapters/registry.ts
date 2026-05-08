/**
 * Source registry — the one place where adapters get wired in.
 *
 * Each adapter is wrapped with the cache layer so the aggregation path
 * does at most one upstream fetch per (source, pair) per TTL window. TTLs
 * are per-source — chain reads (Orcfax / Charli3) are slow + cheap to
 * cache; DEX HTTP APIs are fast but rate-limited, so a shorter TTL is fine.
 *
 * Adding a new source = `import` it here, wrap it, push it into ALL_SOURCES.
 * Aggregation reads the registry directly — no other code needs to change.
 *
 * Quote kinds:
 *   - 'price'       — gets aggregated by the price-fanout endpoints
 *   - 'attestation' — surfaced via attestationFanout(), never enters
 *                     price aggregation. Aggregator-side filter on
 *                     `q.kind === 'price'` enforces the boundary.
 */

import cds from '@sap/cds';
import { withCache, type CachedAdapter, type CacheStatus } from '../lib/cache';
import { isAttestationQuote, isPriceQuote, type PriceAdapter, type PriceQuote, type AttestationQuote } from './types';

import orcfax from './orcfax';
import charli3 from './charli3';
import minswap from './minswap';
import minswapV2 from './minswap-v2';
import sundaeswap from './sundaeswap';
import wingriders from './wingriders';
import wingridersStableswap from './wingriders-stableswap';
import djedReserves from './djed-reserves';
import indigoCdp from './indigo-cdp';
import circleUsdcAttestation from './circle-usdc-attestation';
import fluidtokens from './fluidtokens';
import liqwid from './liqwid';

const log = cds.log('adapters');
type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const cacheLog = (level: string, msg: string): void => {
  const fn = (log as unknown as Record<LogLevel, ((msg: string) => void) | undefined>)[level as LogLevel];
  if (fn) fn(msg);
};

// TTL recommendations from the impl plan: chain ≈ 30s, DEX ≈ 10s.
// Orcfax republishes ~hourly anyway, so 30s costs us at most one extra
// chain read per minute per pair while smoothing out request bursts.
// DEX endpoints serve from server-side caches with sub-second freshness;
// 10s gives us 6 calls/min/pair, well under any documented quota.
const orcfaxCached = withCache(orcfax, { ttlMs: 30_000, log: cacheLog });
const charli3Cached = withCache(charli3, { ttlMs: 30_000, log: cacheLog });
const minswapCached = withCache(minswap, { ttlMs: 10_000, log: cacheLog });
// Minswap V2 reads ~3.2k pool UTxOs via paginated Koios — heavier than the
// other DEX adapters but the in-adapter snapshot cache (also 30s) means
// the upstream cost amortises across all 5 supported pairs.
const minswapV2Cached = withCache(minswapV2, { ttlMs: 30_000, log: cacheLog });
const sundaeswapCached = withCache(sundaeswap, { ttlMs: 10_000, log: cacheLog });
// WingRiders fetches the full pool list each call (~135 KB). Same TTL as
// the other DEXes — 10s — plus the cache layer dedupes concurrent reads.
const wingridersCached = withCache(wingriders, { ttlMs: 10_000, log: cacheLog });
// WingRiders STABLESWAP variant — same upstream cost profile, separate
// adapter instance because pair shapes are stable-stable not ADA-X.
const wingridersStableswapCached = withCache(wingridersStableswap, { ttlMs: 10_000, log: cacheLog });
// DJED reserves change at the cadence of mint/burn txs (minutes during peak,
// hours during quiet periods). 60s TTL is plenty — much higher than DEXes
// because the on-chain UTxO read + 2 Minswap HTTP calls is heavy.
const djedReservesCached = withCache(djedReserves, { ttlMs: 60_000, log: cacheLog });
// Indigo CDP enumeration is heavier (~500 UTxO Koios call + per-CDP datum
// decode + ADA-USD reference). CDPs change per user mint/burn — minutes-cadence.
// 60s matches DJED's profile.
const indigoCdpCached = withCache(indigoCdp, { ttlMs: 60_000, log: cacheLog });
// Circle attestation reports are MONTHLY — there's no point re-fetching the
// PDF every minute. 1 hour TTL is fine; the cache absorbs concurrent reads
// and the PDF is ~300 KB so each fetch is cheap when it does happen.
const circleUsdcAttestationCached = withCache(circleUsdcAttestation, { ttlMs: 60 * 60 * 1000, log: cacheLog });
// FluidTokens reads ~thousands of loan + pool UTxOs via Koios credential queries.
// State changes per borrow/repay/lend tx — minutes-cadence at most. 5-minute
// TTL keeps Blockfrost cost bounded when the dashboard re-renders (paginated
// 1000-UTxO reads are expensive); aligned with the dashboard ISR window.
const fluidtokensCached = withCache(fluidtokens, { ttlMs: 300_000, log: cacheLog });
// Liqwid: 3 mainnet stable markets + 1 GraphQL fanout per refresh. Each market's
// MarketState UTxO updates per batch settlement (~62s on-chain cadence). 5-minute
// TTL is plenty — APY values move on epoch-scale, on-chain reserves move on
// supply/borrow tx scale. Aligned with FluidTokens for dashboard ISR consistency.
const liqwidCached = withCache(liqwid, { ttlMs: 300_000, log: cacheLog });

// Oracle + attestation sources are excluded from DEX-only fanouts (arbitrage).
// Update both `ALL_SOURCES` and the `ORACLE_SOURCE_NAMES` set when adding
// either kind of non-DEX source.
const ORACLE_SOURCE_NAMES: ReadonlySet<string> = new Set([
  'orcfax', 'charli3', 'djed-reserves', 'indigo-cdp', 'circle-usdc-attestation',
  'fluidtokens', 'liqwid',
]);

/**
 * Ordered list of all configured sources. Add a new adapter by `import`
 * + `withCache()` + push here. The aggregator and arbitrage handlers read
 * `ALL_SOURCES` directly — no other code change needed.
 */
export const ALL_SOURCES: PriceAdapter[] = [
  orcfaxCached, charli3Cached, minswapCached, minswapV2Cached, sundaeswapCached,
  wingridersCached, wingridersStableswapCached,
  djedReservesCached, indigoCdpCached, circleUsdcAttestationCached, fluidtokensCached,
  liqwidCached,
];

/**
 * Cached-adapter list, narrower-typed than `ALL_SOURCES` so callers (the
 * status endpoint) can introspect cache state without a runtime check.
 */
const ALL_CACHED_SOURCES: CachedAdapter[] = [
  orcfaxCached, charli3Cached, minswapCached, minswapV2Cached, sundaeswapCached,
  wingridersCached, wingridersStableswapCached,
  djedReservesCached, indigoCdpCached, circleUsdcAttestationCached, fluidtokensCached,
  liqwidCached,
];

/**
 * Snapshot of every adapter's cache state. Used by `getServiceStatus`
 * for ops dashboards / liveness checks. Pure read of in-memory state —
 * never triggers a fetch.
 */
export function getRegistryStatus(): CacheStatus[] {
  return ALL_CACHED_SOURCES.map(s => s.status());
}

/**
 * Invalidate a named cached adapter's snapshot. Returns true if the
 * adapter exists, false otherwise. Pass `pair` to scope the invalidation
 * to one entry; omit to clear all entries for the source.
 *
 * Used by ODATANO-WATCH event subscribers — when the underlying chain
 * state for an adapter changes, the corresponding cache is dropped so
 * the next consumer call re-fetches fresh.
 */
export function invalidateSource(sourceName: string, pair?: string): boolean {
  const cached = ALL_CACHED_SOURCES.find(s => s.sourceName === sourceName);
  if (!cached) return false;
  cached.invalidate(pair);
  return true;
}

export interface FanoutError {
  source: string;
  error: string;
}

export interface FanoutResult {
  quotes: PriceQuote[];
  errors: FanoutError[];
}

export interface AttestationFanoutResult {
  quotes: AttestationQuote[];
  errors: FanoutError[];
}

/**
 * Sources that support a given pair. Used by the aggregator to fan out only
 * where it's possible.
 */
export function sourcesForPair(pair: string): PriceAdapter[] {
  return ALL_SOURCES.filter(s => {
    try { return s.supportsPair(pair); }
    catch { return false; }
  });
}

/**
 * Same as sourcesForPair, but only DEX venues (oracles excluded). Arbitrage
 * compares executable trade prices across liquid venues — oracles aren't
 * places you can route a swap through. Membership lives in
 * `ORACLE_SOURCE_NAMES` so adding a new oracle only changes that set.
 */
export function dexSourcesForPair(pair: string): PriceAdapter[] {
  return sourcesForPair(pair).filter(s => !ORACLE_SOURCE_NAMES.has(s.sourceName));
}

/**
 * Fan out across all sources that support `pair`, returning only `PriceQuote`s.
 * Attestation quotes (e.g. USDM-RESERVES) are filtered out — they go through
 * `attestationFanout()`. Does NOT throw if everyone fails — caller decides
 * the HTTP code (502 vs partial success).
 */
export async function fanout(pair: string): Promise<FanoutResult> {
  const sources = sourcesForPair(pair);
  const quotes: PriceQuote[] = [];
  const errors: FanoutError[] = [];
  await Promise.all(sources.map(async (s) => {
    try {
      const q = await s.getPrice(pair);
      if (isPriceQuote(q)) {
        quotes.push(q);
      } else if (isAttestationQuote(q)) {
        // Skip silently — attestations are not prices. Caller wanted prices.
        log.debug?.(`fanout: skipping attestation quote from ${s.sourceName} for ${pair}`);
      } else {
        errors.push({ source: s.sourceName, error: 'invalid quote shape' });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ source: s.sourceName, error: msg });
      log.warn(`source ${s.sourceName} failed for ${pair}: ${msg}`);
    }
  }));
  return { quotes, errors };
}

/** DEX-only fanout — for cross-venue arbitrage. Returns only PriceQuotes. */
export async function fanoutDexOnly(pair: string): Promise<FanoutResult> {
  const sources = dexSourcesForPair(pair);
  const quotes: PriceQuote[] = [];
  const errors: FanoutError[] = [];
  await Promise.all(sources.map(async (s) => {
    try {
      const q = await s.getPrice(pair);
      if (isPriceQuote(q)) quotes.push(q);
      else if (!isAttestationQuote(q)) errors.push({ source: s.sourceName, error: 'invalid quote shape' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ source: s.sourceName, error: msg });
    }
  }));
  return { quotes, errors };
}

/**
 * Attestation fanout — collect non-price quotes (e.g. USDM-RESERVES).
 * Mirror shape of fanout() so callers can use the same error-aware pattern.
 */
export async function attestationFanout(pair: string): Promise<AttestationFanoutResult> {
  const sources = sourcesForPair(pair);
  const quotes: AttestationQuote[] = [];
  const errors: FanoutError[] = [];
  await Promise.all(sources.map(async (s) => {
    try {
      const q = await s.getPrice(pair);
      if (isAttestationQuote(q)) quotes.push(q);
      else if (!isPriceQuote(q)) errors.push({ source: s.sourceName, error: 'invalid quote shape' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ source: s.sourceName, error: msg });
    }
  }));
  return { quotes, errors };
}
