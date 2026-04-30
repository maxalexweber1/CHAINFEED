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

import { assertIsAdapter, type PriceAdapter, type PriceQuote } from '../adapters/types';

interface CacheEntry {
  quote: PriceQuote | undefined;
  fetchedAt: number;
  refreshPromise?: Promise<PriceQuote>;
}

export interface CacheOptions {
  /** fresh-window in ms */
  ttlMs: number;
  /** optional structured logger */
  log?: (level: string, msg: string) => void;
}

/** Wrap a PriceAdapter with a TTL cache. */
export function withCache(adapter: PriceAdapter, opts: CacheOptions): PriceAdapter {
  assertIsAdapter(adapter, 'withCache: adapter');
  const ttlMs = Number(opts?.ttlMs);
  if (!(ttlMs > 0) || !Number.isFinite(ttlMs)) {
    throw new TypeError('withCache: opts.ttlMs must be a positive finite number');
  }
  const log = opts?.log ?? (() => {});

  const store = new Map<string, CacheEntry>();

  function startRefresh(pair: string, entry: CacheEntry | null): Promise<PriceQuote> {
    const promise = Promise.resolve()
      .then(() => adapter.getPrice(pair))
      .then(quote => {
        store.set(pair, { quote, fetchedAt: Date.now() });
        return quote;
      })
      .catch(err => {
        // Drop the in-flight reference so the next caller can retry.
        const cur = store.get(pair);
        if (cur && cur.refreshPromise === promise) {
          // Keep the stale quote in store; just clear the in-flight Promise.
          store.set(pair, { quote: cur.quote, fetchedAt: cur.fetchedAt });
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
    async getPrice(pair: string): Promise<PriceQuote> {
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
  };
}
