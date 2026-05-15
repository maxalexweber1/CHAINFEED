/**
 * Thin TypeScript SDK for the CHAINFEED CAP service.
 *
 * Server-side use only — the public dashboard fetches via Next.js RSC,
 * so requests originate from the same network where the CAP server runs.
 * Free endpoints (`getStableHealth`, `getServiceStatus`, `getOhlcv`) skip
 * the x402 flow; paid endpoints would need a `PAYMENT-SIGNATURE` header
 * which lives in a separate flow (see `app/agents` documentation route).
 *
 * Types mirror the CDS shapes in `srv/price-service.cds` 1:1. Decimals
 * come over the wire as JSON strings (CAP convention) — converted to
 * numbers at the SDK boundary so callers don't deal with the wire format.
 */

const DEFAULT_BASE_URL =
  process.env.CHAINFEED_BASE_URL ??
  process.env.NEXT_PUBLIC_CHAINFEED_BASE_URL ??
  'http://localhost:4004';

const ODATA_PATH = '/odata/v4/price';

// ── Response shapes (mirror price-service.cds) ───────────────────────────

export interface StableMetadataView {
  symbol: string;
  peg: string;
  backing: string;
  issuerName: string;
  issuerJurisdiction: string | null;
  issuerCustodian: string | null;
  policyId: string;
  assetNameHex: string;
  decimals: number;
  liveSince: string;
}

export interface StableHealthPriceBlock {
  available: boolean;
  value: number | null;
  sourcesUsed: number | null;
  confidence: number | null;
  deviationPct: number | null;
}

export type ReservesSource =
  | 'on-chain-attestation'
  | 'on-chain-collateral-aggregate'
  | 'off-chain-pdf'
  | 'none'
  | null;

export type HealthBucket = 'healthy' | 'warning' | 'alert' | 'critical' | null;

export interface StableHealthReservesBlock {
  available: boolean;
  source: ReservesSource;
  value: number | null;
  unit: string | null;
  healthBucket: HealthBucket;
  txHash: string | null;
  ageMs: number | null;
}

export interface StableHealthSupplyBlock {
  available: boolean;
  totalSupply: number | null;
  circulatingSupply: number | null;
}

export interface StableHealthLiquidityBlock {
  available: boolean;
  midPrice: number | null;
  depthAda: number | null;
  depthAtMaxProbed: boolean | null;
  routingMonotone: boolean | null;
  targetSlippagePct: number | null;
  probedPointsCount: number | null;
}

export interface StableHealthRiskComponent {
  value: number;
  weight: number;
  effective: number;
}

export interface StableHealthRiskBlock {
  score: number;
  pegConfidence: StableHealthRiskComponent;
  reserveAdequacy: StableHealthRiskComponent;
  attestationFreshness: StableHealthRiskComponent;
  sourceConfidence: StableHealthRiskComponent;
}

export interface StableHealthResult {
  symbol: string;
  metadata: StableMetadataView;
  price: StableHealthPriceBlock;
  pegDeviationBps: number | null;
  reserves: StableHealthReservesBlock;
  supply: StableHealthSupplyBlock;
  liquidity: StableHealthLiquidityBlock;
  risk: StableHealthRiskBlock;
  alerts: string[];
  computedAt: string;
}

export interface OhlcvCandle {
  ts:          string;     // ISO timestamp (bucket start, UTC)
  open:        number;
  high:        number;
  low:         number;
  close:       number;
  sampleCount: number;
}

export interface OhlcvResult {
  pair:          string;
  interval:      string;
  windowStart:   string;
  windowEnd:     string;
  candles:       OhlcvCandle[];
  lookbackHours: number;
}

/**
 * Time-aligned bucket merge of two OHLCV series. For each bucket present in
 * BOTH inputs (matched by `ts`), compute peg-deviation in basis points:
 *   pegDevBps = (adaUsdClose / adaStableClose − 1) × 10000
 *
 * Returns the merged time-series sorted ascending by ts.
 */
export interface PegDeviationBucket {
  ts: string;
  bps: number;
  adaUsd: number;
  adaStable: number;
}

export function mergePegDeviationBuckets(
  stableCandles: ReadonlyArray<OhlcvCandle>,
  adaUsdCandles: ReadonlyArray<OhlcvCandle>,
): PegDeviationBucket[] {
  const usdByTs = new Map<string, OhlcvCandle>();
  for (const c of adaUsdCandles) usdByTs.set(c.ts, c);
  const out: PegDeviationBucket[] = [];
  for (const s of stableCandles) {
    const usd = usdByTs.get(s.ts);
    if (!usd) continue;
    if (!(s.close > 0) || !(usd.close > 0)) continue;
    const stableUsd = usd.close / s.close;
    const bps = (stableUsd - 1) * 10000;
    out.push({ ts: s.ts, bps, adaUsd: usd.close, adaStable: s.close });
  }
  out.sort((a, b) => a.ts.localeCompare(b.ts));
  return out;
}

export interface ConvergenceCrossRate {
  fromSymbol: string;
  toSymbol: string;
  impliedRate: number;
  deviationPct: number;
}

export interface ConvergenceResult {
  symbols: string[];
  rates: ConvergenceCrossRate[];
  convergenceScore: number;
  maxDeviationPct: number;
  outliers: string[];
  adaPrices: Array<{ symbol: string; adaPrice: number }>;
  computedAt: string;
}

// ── FluidTokens lending ──────────────────────────────────────────────────

export interface FluidAsset {
  policyId: string;
  assetNameHex: string;
}

export interface FluidAssetRollup {
  /** 'ADA' or lowercase hex unit (policyId + assetNameHex). Field is
   *  named `assetKey` (not `key`) because `key` is a reserved CDS keyword
   *  and CDS rejected the type compile. */
  assetKey: string;
  principalAsset: FluidAsset;
  poolCount: number;
  /** Sum of available principal across pools, raw units (string for BigInt safety). */
  poolsAvailableRaw: string;
  poolsLovelace: string;
  loanCount: number;
  outstandingPrincipalRaw: string;
  currentDebtRaw: string;
  collateralLovelace: string;
  liquidatable: number;
  late: number;
  permissionedPoolCount: number;
}

export interface FluidHealthResult {
  network: string;
  computedAt: string;
  poolsTotal: number;
  loansTotal: number;
  perAsset: FluidAssetRollup[];
  alerts: string[];
}

/** Composite FluidTokens v3 health snapshot. Free endpoint. */
export function getFluidtokensHealth(opts: FetchOpts = {}): Promise<FluidHealthResult> {
  return postAction<FluidHealthResult>('getFluidtokensHealth', {}, opts);
}

// ── Liqwid Finance v2 lending markets ──────────────────────────────────

export interface LiqwidMarketRollup {
  symbol:   'DJED' | 'iUSD' | 'USDM';
  liqwidId: 'DJED' | 'IUSD' | 'USDM';
  txHash:      string;
  outputIndex: number;
  decimals: number;            // uniform 6 for in-scope markets
  /** Raw integer strings — divide by 10^decimals to display whole units. */
  supplyRaw:        string;
  principalRaw:     string;
  reserveRaw:       string;
  totalSuppliedRaw: string;
  qTokenSupplyRaw:  string;
  qTokenRate:  number;          // num/denom from datum field [9]
  utilization: number;          // 0..1, Compound semantics
  /** APY values from Liqwid's GraphQL — null when source down/frozen/private. */
  supplyAPY:    number | null;
  borrowAPY:    number | null;
  lqSupplyAPY:  number | null;
  apyUpdatedAt: string | null;
  /** Observed-on-chain rates derived from interestIndex deltas. Null until
   *  the server has accumulated ≥ 60s of snapshots since startup. Verifiable:
   *  reproduce by snapshotting the same MarketState UTxO between two times. */
  observedBorrowAPR: number | null;
  observedBorrowAPY: number | null;
  observedSupplyAPY: number | null;
  observedDeltaMs:   number | null;
  lastInterestUpdateMs: number;
  nextBatchDeadlineMs:  number;
}

export interface LiqwidHealthResult {
  network:     string;
  computedAt:  string;
  marketCount: number;
  apySource:   'liqwid-api' | 'unavailable';
  perMarket:   LiqwidMarketRollup[];
  alerts:      string[];
}

/** Composite Liqwid v2 health snapshot — stable markets only (DJED/iUSD/USDM). */
export function getLiqwidHealth(opts: FetchOpts = {}): Promise<LiqwidHealthResult> {
  return postAction<LiqwidHealthResult>('getLiqwidHealth', {}, opts);
}

/**
 * Stable-asset rollup keys we surface on the homepage. Constructed as
 * `(policyId + assetNameHex).toLowerCase()` to match what FluidTokens'
 * health endpoint returns. Source: srv/lib/stable-metadata.ts.
 *
 * USDC (Wanchain) is intentionally NOT here — that's a separate Wanchain
 * bridge variant and was dropped from CHAINFEED's stable scope on
 * 2026-05-03 (no liquid direct DEX pools). If FluidTokens has a USDC pool,
 * we ignore it for the dashboard view.
 */
export const FLUID_STABLE_KEYS: Readonly<Record<string, string>> = Object.freeze({
  c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad0014df105553444d: 'USDM',
  '8db269c3ec630e06ae29f74bc39edd1f87c819f1056206e879a1cd61446a65644d6963726f555344': 'DJED',
  f66d78b4a3cb3d37afa0ec36461e51ecbde00f26c8f0a68f94b6988069555344: 'iUSD',
  fe7c786ab321f41c654ef6c1af7b3250a613c24e4213e0425a7ae45655534441: 'USDA',
  '1f3aec8bfe7ea4fe14c5f121e2a92e301afe414147860d557cac7e345553444378': 'USDCx',
});

export function fluidStableLabel(key: string): string | null {
  return FLUID_STABLE_KEYS[key] ?? null;
}

/** True if the rollup key is one of the 5 indexed CHAINFEED stables. */
export function isFluidStable(key: string): boolean {
  return key in FLUID_STABLE_KEYS;
}

/** Reverse lookup: 'USDM' → '<policy><assetname>' or null if symbol not in registry. */
export function fluidKeyForSymbol(symbol: string): string | null {
  const wanted = symbol.toUpperCase();
  for (const [key, sym] of Object.entries(FLUID_STABLE_KEYS)) {
    if (sym.toUpperCase() === wanted) return key;
  }
  return null;
}

/**
 * Convert a raw integer-string to a number, divided by `10^decimals`. Used
 * to display principal totals (most FluidTokens-supported assets are
 * 6-decimal: ADA, USDM, USDCx, FLDT-like CIP-68, etc.).
 */
export function rawToWhole(raw: string, decimals = 6): number {
  if (!raw) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return n / Math.pow(10, decimals);
}

export interface ServiceStatusEntry {
  sourceName: string;
  ttlMs: number;
  cachedPairCount: number;
  pairs: Array<{
    pair: string;
    fetchedAtIso: string;
    ageSeconds: number;
    hasInflightRefresh: boolean;
    lastErrorMessage: string | null;
    lastErrorAtIso: string | null;
  }>;
}

// ── Fetch primitives ─────────────────────────────────────────────────────

interface FetchOpts {
  baseUrl?: string;
  /** Next.js cache TTL in seconds. Pass 0 to disable; default 30. */
  revalidateSec?: number;
}

/** OData decimals come over the wire as strings — convert recursively. */
function coerceDecimals<T>(v: T): T {
  if (v === null || v === undefined) return v;
  if (typeof v === 'string') {
    // Decimal-shaped strings only (digits, optional minus + dot). Leave
    // arbitrary text alone (txHashes, sourceNames, ISO timestamps).
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v) as unknown as T;
    return v;
  }
  if (Array.isArray(v)) return v.map(coerceDecimals) as unknown as T;
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      // Skip coercion for fields that look numeric-string by accident
      // (timestamps, hex, etc.). Heuristic: ISO date OR pure-hex stays string.
      if (typeof val === 'string' && (/^\d{4}-\d{2}-\d{2}T/.test(val) || /^[0-9a-f]+$/i.test(val))) {
        out[k] = val;
      } else {
        out[k] = coerceDecimals(val);
      }
    }
    return out as T;
  }
  return v;
}

async function postAction<T>(
  action: string,
  body: Record<string, unknown>,
  opts: FetchOpts = {},
): Promise<T> {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const revalidateSec = opts.revalidateSec ?? 30;
  const url = `${baseUrl}${ODATA_PATH}/${action}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    next: { revalidate: revalidateSec },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`CHAINFEED ${action} → HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = await res.json();
  // CAP unwraps singletons under `value` for some shapes, others not.
  // getStableHealth returns the result directly.
  return coerceDecimals(json) as T;
}

// ── Public SDK methods ───────────────────────────────────────────────────

/** Composite per-stable dashboard. Free endpoint. */
export function getStableHealth(
  symbol: string,
  opts: FetchOpts = {},
): Promise<StableHealthResult> {
  return postAction<StableHealthResult>('getStableHealth', { symbol }, opts);
}

/** OHLCV candle history. Free endpoint (today; 24h-cap may be enforced later). */
export function getOhlcv(
  pair: string,
  interval: '1m' | '5m' | '15m' | '1h' | '4h' | '1d',
  lookbackHours: number,
  opts: FetchOpts = {},
): Promise<OhlcvResult> {
  return postAction<OhlcvResult>('getOhlcv', { pair, interval, lookbackHours }, opts);
}

/** Per-adapter cache snapshot. Free endpoint. */
export function getServiceStatus(opts: FetchOpts = {}): Promise<ServiceStatusEntry[]> {
  return postAction<ServiceStatusEntry[]>('getServiceStatus', {}, opts);
}

/** Cross-stable convergence matrix. Free endpoint. */
export function getStableConvergence(opts: FetchOpts = {}): Promise<ConvergenceResult> {
  return postAction<ConvergenceResult>('getStableConvergence', {}, opts);
}

// ── Display helpers ──────────────────────────────────────────────────────

export function formatBps(bps: number | null): string {
  if (bps === null || !Number.isFinite(bps)) return '—';
  const sign = bps >= 0 ? '+' : '';
  return `${sign}${bps.toFixed(1)} bps`;
}

export function formatPct(value: number | null, decimals = 2): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${value.toFixed(decimals)}%`;
}

export function formatUsd(value: number | null, fractionDigits = 4): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `$${value.toLocaleString(undefined, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })}`;
}

export function formatAda(value: number | null, fractionDigits = 0): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${value.toLocaleString(undefined, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })} ADA`;
}

/** Map an alert ID to a short human label + severity. */
export function describeAlert(alertId: string): { label: string; severity: 'info' | 'warning' | 'critical' } {
  if (alertId.startsWith('peg-deviation-critical')) return { label: 'Peg deviation critical', severity: 'critical' };
  if (alertId.startsWith('peg-deviation-high'))     return { label: 'Peg deviation elevated', severity: 'warning' };
  if (alertId.startsWith('peg-deviation-unknown'))  return { label: 'Peg deviation unknown', severity: 'warning' };
  if (alertId.startsWith('reserve-coverage-critical')) return { label: 'Reserve coverage critical', severity: 'critical' };
  if (alertId.startsWith('reserve-coverage-warning'))  return { label: 'Reserve coverage low', severity: 'warning' };
  if (alertId === 'reserves-unsubstantiated')       return { label: 'No public reserves attestation', severity: 'warning' };
  if (alertId === 'reserves-source-missing')        return { label: 'Reserves source unavailable', severity: 'warning' };
  if (alertId === 'attestation-stale')              return { label: 'Attestation stale', severity: 'warning' };
  if (alertId === 'attestation-overdue')            return { label: 'Attestation overdue', severity: 'critical' };
  if (alertId === 'price-source-missing')           return { label: 'Price source unavailable', severity: 'critical' };
  if (alertId === 'price-source-degraded')          return { label: 'Price source degraded', severity: 'warning' };
  return { label: alertId, severity: 'info' };
}

/** Map a `healthBucket` string to a Tailwind text-color hint. */
export function bucketColor(bucket: HealthBucket): string {
  switch (bucket) {
    case 'healthy':  return 'text-(--healthy)';
    case 'warning':  return 'text-(--warning)';
    case 'alert':    return 'text-(--warning)';
    case 'critical': return 'text-(--critical)';
    default:         return 'text-(--muted-foreground)';
  }
}

/** Symbol → reservesPair label for the detail page. */
export function reservesPairFor(symbol: string): string | null {
  const m: Record<string, string> = {
    USDM:  'USDM-RESERVES',
    DJED:  'DJED-RESERVES',
    iUSD:  'iUSD-COLLATERAL',
    USDCx: 'USDCx-ATTESTATION',
  };
  return m[symbol] ?? null;
}

export const SUPPORTED_STABLES = ['USDM', 'DJED', 'iUSD', 'USDA', 'USDCx'] as const;
export type SupportedStable = typeof SUPPORTED_STABLES[number];
