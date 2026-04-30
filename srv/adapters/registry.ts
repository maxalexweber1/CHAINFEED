/**
 * Source registry — the one place where price adapters get wired in.
 *
 * Each adapter is wrapped with the cache layer so the aggregation path
 * does at most one upstream fetch per (source, pair) per TTL window. TTLs
 * are per-source — chain reads (Orcfax) are slow + cheap to cache; DEX HTTP
 * APIs are fast but rate-limited, so a shorter TTL is fine.
 *
 * Adding a new source = `import` it here, wrap it, push it into ALL_SOURCES.
 * Aggregation reads the registry directly — no other code needs to change.
 */

import cds from '@sap/cds';
import { withCache } from '../lib/cache';
import type { PriceAdapter, PriceQuote } from './types';

import orcfax from './orcfax';
import charli3 from './charli3';
import minswap from './minswap';
import sundaeswap from './sundaeswap';
import dexhunter from './dexhunter';

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
const sundaeswapCached = withCache(sundaeswap, { ttlMs: 10_000, log: cacheLog });
const dexhunterCached = withCache(dexhunter, { ttlMs: 10_000, log: cacheLog });

// Oracle sources are excluded from DEX-only fanouts (arbitrage). Update both
// places — `ALL_SOURCES` and `dexSourcesForPair` — when adding a new oracle.
const ORACLE_SOURCE_NAMES: ReadonlySet<string> = new Set(['orcfax', 'charli3']);

/**
 * Ordered list of all configured sources. Add a new adapter by `import`
 * + `withCache()` + push here. The aggregator and arbitrage handlers read
 * `ALL_SOURCES` directly — no other code change needed.
 */
export const ALL_SOURCES: PriceAdapter[] = [
  orcfaxCached, charli3Cached, minswapCached, sundaeswapCached, dexhunterCached,
];

export interface FanoutError {
  source: string;
  error: string;
}

export interface FanoutResult {
  quotes: PriceQuote[];
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
 * Fan out across all sources that support `pair`. Returns the array of
 * resolved quotes, dropping any source that fails. Does NOT throw if
 * everyone fails — that's the caller's call (HTTP 502 vs partial success).
 */
export async function fanout(pair: string): Promise<FanoutResult> {
  const sources = sourcesForPair(pair);
  const quotes: PriceQuote[] = [];
  const errors: FanoutError[] = [];
  await Promise.all(sources.map(async (s) => {
    try {
      const q = await s.getPrice(pair);
      if (q && Number.isFinite(q.price)) {
        quotes.push(q);
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

/** DEX-only fanout — for cross-venue arbitrage. */
export async function fanoutDexOnly(pair: string): Promise<FanoutResult> {
  const sources = dexSourcesForPair(pair);
  const quotes: PriceQuote[] = [];
  const errors: FanoutError[] = [];
  await Promise.all(sources.map(async (s) => {
    try {
      const q = await s.getPrice(pair);
      if (q && Number.isFinite(q.price)) quotes.push(q);
      else errors.push({ source: s.sourceName, error: 'invalid quote shape' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ source: s.sourceName, error: msg });
    }
  }));
  return { quotes, errors };
}
