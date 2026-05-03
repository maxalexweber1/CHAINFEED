/**
 * Common types for CHAINFEED adapters.
 *
 * Every quote carries a `kind` discriminant:
 *   - 'price'        — exchange-rate observation, gets aggregated
 *   - 'attestation'  — non-price oracle data (e.g. Mehen USDM bank-balance
 *                      reserves), passed through but excluded from price
 *                      aggregation
 *
 * Adapters return `Quote` (the union). Consumers narrow at the call site
 * via `q.kind === 'price'` before reading `.price`. The aggregator's
 * fanout filter does this so downstream pipeline code keeps seeing
 * only `PriceQuote[]`.
 */

interface BaseQuoteFields {
  /** e.g. 'orcfax', 'minswap', 'sundaeswap' */
  sourceName: string;
  /** e.g. 'ADA-USD', 'ADA-USDM', 'USDM-RESERVES' */
  pair: string;
  /** epoch milliseconds when the observation was fresh */
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

export interface PriceQuote extends BaseQuoteFields {
  readonly kind: 'price';
  /** numeric price as quote per base */
  price: number;
}

export interface AttestationQuote extends BaseQuoteFields {
  readonly kind: 'attestation';
  /** numeric attestation value (e.g. USD reserves balance) */
  value: number;
  /** unit of the value, e.g. 'usd', 'ada', 'count' */
  unit: string;
}

export type Quote = PriceQuote | AttestationQuote;

export interface PriceAdapter {
  readonly sourceName: string;
  /**
   * Fetch a quote (price or attestation) for `pair`. Adapters MUST stamp
   * `kind` on the returned object so consumers can narrow.
   */
  getPrice(pair: string): Promise<Quote>;
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

/** Type guard: true when the quote carries an executable price. */
export function isPriceQuote(q: Quote | null | undefined): q is PriceQuote {
  return !!q && q.kind === 'price' && Number.isFinite(q.price);
}

/** Type guard: true when the quote is a non-price attestation. */
export function isAttestationQuote(q: Quote | null | undefined): q is AttestationQuote {
  return !!q && q.kind === 'attestation' && Number.isFinite(q.value);
}
