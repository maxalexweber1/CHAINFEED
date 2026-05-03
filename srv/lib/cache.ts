/**
 * Per-adapter price cache with stale-while-revalidate.
 *
 * Decision rule per call:
 *   age < ttl         → return cached (fresh)
 *   ttl ≤ age < 2*ttl → return cached (stale), kick off background refresh
 *   age ≥ 2*ttl       → blocking refresh
 *
 * Why this matters: at 100 calls per pair per minute, a 30s Orcfax TTL
 * means at most 2 chain reads per minute per pair, with the occasional
 * background refresh keeping the working set warm. The "blocking when
 * very stale" branch is the safety floor for cold starts and lazy pairs.
 *
 * In-flight de-duplication: while a refresh is running, concurrent
 * `getPrice` calls reuse the same in-flight Promise rather than each
 * spawning their own request. This is what protects upstream rate limits.
 */

import { assertIsAdapter, type PriceAdapter, type Quote } from '../adapters/types';

interface CacheEntry {
  quote: Quote | undefined;
  fetchedAt: number;
  refreshPromise?: Promise<Quote>;
  /** Last error observed when refreshing this pair, if any. Cleared on success. */
  lastError?: { message: string; at: number };
}

/** Snapshot of cache state for one wrapped adapter — used by getServiceStatus. */
export interface CacheStatus {
  sourceName: string;
  ttlMs: number;
  /** Number of distinct pairs cached (excluding never-fetched placeholders). */
  cachedPairCount: number;
  /** Per-pair freshness summary, sorted by oldest fetched first. */
  pairs: Array<{
    pair: string;
    fetchedAtIso: string | null;
    ageSeconds: number | null;
    hasInflightRefresh: boolean;
    lastError: { message: string; at: string } | null;
  }>;
}

/** Adapter wrapper that also exposes cache-state introspection. */
export interface CachedAdapter extends PriceAdapter {
  /** Snapshot the current in-memory cache state. Pure read, no I/O. */
  status: () => CacheStatus;
  /**
   * Drop cached entries so the next `getPrice` triggers a fresh fetch.
   * Pass a pair to invalidate just that one; pass nothing to clear all.
   * Used by event-driven cache invalidation (e.g. ODATANO-WATCH event
   * arrives → on-chain state changed → drop the cached snapshot).
   */
  invalidate: (pair?: string) => void;
}

export interface CacheOptions {
  /** fresh-window in ms */
  ttlMs: number;
  /** optional structured logger */
  log?: (level: string, msg: string) => void;
}

/** Wrap a PriceAdapter with a TTL cache. */
export function withCache(adapter: PriceAdapter, opts: CacheOptions): CachedAdapter {
  assertIsAdapter(adapter, 'withCache: adapter');
  const ttlMs = Number(opts?.ttlMs);
  if (!(ttlMs > 0) || !Number.isFinite(ttlMs)) {
    throw new TypeError('withCache: opts.ttlMs must be a positive finite number');
  }
  const log = opts?.log ?? (() => {});

  const store = new Map<string, CacheEntry>();

  function startRefresh(pair: string, entry: CacheEntry | null): Promise<Quote> {
    const promise = Promise.resolve()
      .then(() => adapter.getPrice(pair))
      .then(quote => {
        store.set(pair, { quote, fetchedAt: Date.now() });
        return quote;
      })
      .catch(err => {
        // Drop the in-flight reference so the next caller can retry.
        const cur = store.get(pair);
        const errInfo = { message: String(err?.message ?? err), at: Date.now() };
        if (cur && cur.refreshPromise === promise) {
          // Keep the stale quote in store; just clear the in-flight Promise.
          store.set(pair, { quote: cur.quote, fetchedAt: cur.fetchedAt, lastError: errInfo });
        }
        log('warn', `cache refresh for ${adapter.sourceName}:${pair} failed: ${err?.message ?? err}`);
        throw err;
      });

    // Track the in-flight Promise on the entry so concurrent stale reads share it.
    if (entry) entry.refreshPromise = promise;
    return promise;
  }

  return {
    sourceName: adapter.sourceName,
    supportsPair: (pair: string): boolean => adapter.supportsPair(pair),
    async getPrice(pair: string): Promise<Quote> {
      const now = Date.now();
      const entry = store.get(pair);

      if (entry && entry.quote !== undefined) {
        const age = now - entry.fetchedAt;

        if (age < ttlMs) return entry.quote;            // fresh hit

        if (age < 2 * ttlMs) {
          // Stale-but-usable. Kick off a background refresh if none in flight.
          if (!entry.refreshPromise) {
            startRefresh(pair, entry).catch(() => { /* logged */ });
          }
          return entry.quote;
        }

        // Too stale — block on a refresh. Reuse in-flight if present so
        // concurrent stale reads don't multiply upstream pressure.
        if (entry.refreshPromise) return entry.refreshPromise;
        return startRefresh(pair, entry);
      }

      // Cold miss (or in-flight placeholder) → blocking refresh. If a
      // placeholder already has an in-flight refresh, reuse it.
      if (entry?.refreshPromise) return entry.refreshPromise;
      const placeholder: CacheEntry = { quote: undefined, fetchedAt: 0 };
      store.set(pair, placeholder);
      return startRefresh(pair, placeholder);
    },
    invalidate(pair?: string): void {
      if (pair) {
        const had = store.delete(pair);
        if (had) log('info', `cache invalidated for ${adapter.sourceName}:${pair}`);
        return;
      }
      const n = store.size;
      store.clear();
      if (n > 0) log('info', `cache fully invalidated for ${adapter.sourceName} (${n} pairs)`);
    },
    status(): CacheStatus {
      const now = Date.now();
      const pairs = Array.from(store.entries()).map(([pair, e]) => {
        const fetched = e.quote !== undefined && e.fetchedAt > 0;
        return {
          pair,
          fetchedAtIso:       fetched ? new Date(e.fetchedAt).toISOString() : null,
          ageSeconds:         fetched ? Math.round((now - e.fetchedAt) / 1000) : null,
          hasInflightRefresh: !!e.refreshPromise,
          lastError:          e.lastError ? { message: e.lastError.message, at: new Date(e.lastError.at).toISOString() } : null,
        };
      }).sort((a, b) => {
        // Oldest fetched first — most-likely-stale at the top.
        if (a.fetchedAtIso === null && b.fetchedAtIso === null) return 0;
        if (a.fetchedAtIso === null) return -1;
        if (b.fetchedAtIso === null) return 1;
        return Date.parse(a.fetchedAtIso) - Date.parse(b.fetchedAtIso);
      });
      return {
        sourceName: adapter.sourceName,
        ttlMs,
        cachedPairCount: pairs.filter(p => p.fetchedAtIso !== null).length,
        pairs,
      };
    },
  };
}
