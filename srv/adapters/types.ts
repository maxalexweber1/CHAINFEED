/**
 * Common types for CHAINFEED price-source adapters.
 *
 * Adapters import `PriceAdapter` and explicitly annotate their default
 * export so TS catches any shape divergence at compile time.
 */

export interface PriceQuote {
  /** e.g. 'orcfax', 'minswap', 'sundaeswap' */
  sourceName: string;
  /** e.g. 'ADA-USD', 'ADA-USDM' */
  pair: string;
  /** numeric price as quote per base */
  price: number;
  /** epoch milliseconds when the quote was fresh */
  timestamp: number;
  /** epoch ms — optional, source-specific staleness window */
  validUntil?: number;
  /** for on-chain sources only — Cardano tx hash for audit */
  txHash?: string;
  /** true if source-defined staleness window passed */
  isStale?: boolean;
  /** original source response (or relevant slice) for debugging */
  rawPayload: unknown;
}

export interface PriceAdapter {
  readonly sourceName: string;
  getPrice(pair: string): Promise<PriceQuote>;
  supportsPair(pair: string): boolean;
}

/**
 * Light runtime check — assert that an object exposes the PriceAdapter shape.
 * Used by the registry / cache wrapper to fail fast on misconfigured imports.
 */
export function assertIsAdapter(
  candidate: unknown,
  ctxLabel = 'adapter',
): asserts candidate is PriceAdapter {
  if (!candidate || typeof candidate !== 'object') {
    throw new TypeError(`${ctxLabel}: not an object`);
  }
  const c = candidate as Record<string, unknown>;
  for (const f of ['sourceName', 'getPrice', 'supportsPair']) {
    if (!(f in c)) throw new TypeError(`${ctxLabel}: missing '${f}'`);
  }
  if (typeof c.sourceName !== 'string' || c.sourceName.length === 0) {
    throw new TypeError(`${ctxLabel}: sourceName must be a non-empty string`);
  }
  if (typeof c.getPrice !== 'function') {
    throw new TypeError(`${ctxLabel}: getPrice must be a function`);
  }
  if (typeof c.supportsPair !== 'function') {
    throw new TypeError(`${ctxLabel}: supportsPair must be a function`);
  }
}
