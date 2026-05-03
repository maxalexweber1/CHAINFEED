/**
 * Static registry for the Cardano-native stablecoins CHAINFEED indexes.
 *
 * Pure-TS lookup, no DB. Updated only when a new stable launches on Cardano.
 *
 * Pair convention (matches the rest of the project): `X-Y` reads as
 * "Y per 1 X". So `ADA-USDM = USDM per 1 ADA` ≈ `ADA-USD` when USDM is at
 * peg. The peg-deviation calculation derives the stable's USD price from
 * `adaUsdPrice / adaStablePrice` — see `srv/aggregation/index.ts`.
 *
 * `policyId` + `assetNameHex` are verified live against Minswap's asset
 * registry on 2026-05-01 (see `srv/adapters/minswap-v2.ts` and
 * `srv/adapters/wingriders.ts` for the same IDs in PAIR_CONFIG).
 */

export type Peg = 'USD' | 'EUR' | 'XAU';

export type Backing =
  | 'fiat-custodial'           // USDM (Mehen), USDA (Anzens/BitGo), USDCx (Circle)
  | 'overcollateralized-ada'   // DJED (Coti) — backed by ADA in a reserve script
  | 'overcollateralized-cdp'   // iUSD (Indigo) — backed by per-user CDP positions
  | 'algorithmic';             // none on Cardano today

export interface StableIssuer {
  name: string;
  jurisdiction?: string;
  custodian?: string;          // for fiat-custodial only
}

export interface StableMetadata {
  /** Canonical short symbol, e.g. 'USDM', 'DJED'. */
  symbol: string;
  /** Reference fiat/commodity the stable tracks. */
  peg: Peg;
  /** Backing model — drives reserves-attestation availability. */
  backing: Backing;
  /** Issuer + custodian info for downstream Trust/Risk consumers. */
  issuer: StableIssuer;
  /** 28-byte policy ID (56 hex chars). */
  policyId: string;
  /** Hex-encoded asset name. Empty string only for ADA (not in this registry). */
  assetNameHex: string;
  /** Decimals as published in the Cardano Token Registry. All current stables = 6. */
  decimals: number;
  /** ISO date the asset first appeared on mainnet. */
  liveSince: string;
  /**
   * The CHAINFEED pair name that prices this stable against ADA, used by
   * the peg-deviation pipeline. Always `ADA-{symbol}` for USD-pegged stables.
   */
  pegPair: string;
  /**
   * Optional pair name carrying the on-chain reserves attestation feed for
   * this stable, e.g. `USDM-RESERVES` (Charli3 ODV). Off-chain attestations
   * (Circle USDCx, BitGo USDA) are wired separately in the off-chain scraper.
   */
  reservesPair?: string;
}

/**
 * Stables CHAINFEED indexes today. Adding a new entry here is the single
 * source of truth — `metadataForPair`, `metadataForSymbol`, and the
 * peg-deviation pipeline all read from this map.
 */
export const STABLE_METADATA: Readonly<Record<string, StableMetadata>> = Object.freeze({
  USDM: {
    symbol:      'USDM',
    peg:         'USD',
    backing:     'fiat-custodial',
    issuer:      { name: 'Mehen', jurisdiction: 'US', custodian: 'unknown-bank-trust' },
    policyId:    'c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad',
    assetNameHex:'0014df105553444d',
    decimals:    6,
    liveSince:   '2024-03-17',
    pegPair:     'ADA-USDM',
    reservesPair:'USDM-RESERVES',   // Charli3 ODV attestation feed
  },
  DJED: {
    symbol:      'DJED',
    peg:         'USD',
    backing:     'overcollateralized-ada',
    issuer:      { name: 'Coti' },
    policyId:    '8db269c3ec630e06ae29f74bc39edd1f87c819f1056206e879a1cd61',
    assetNameHex:'446a65644d6963726f555344',  // ASCII "DjedMicroUSD"
    decimals:    6,
    liveSince:   '2023-01-29',
    pegPair:     'ADA-DJED',
    // Naive on-chain reserve coverage (sum ADA at the Djed reserve script,
    // divide by circulating × peg) shipped in `srv/adapters/djed-reserves.ts`.
    // Returned as AttestationQuote with unit='ratio_pct'.
    reservesPair:'DJED-RESERVES',
  },
  iUSD: {
    symbol:      'iUSD',
    peg:         'USD',
    backing:     'overcollateralized-cdp',
    issuer:      { name: 'Indigo Protocol' },
    policyId:    'f66d78b4a3cb3d37afa0ec36461e51ecbde00f26c8f0a68f94b69880',
    assetNameHex:'69555344',  // ASCII "iUSD"
    decimals:    6,
    liveSince:   '2022-11-21',
    pegPair:     'ADA-iUSD',
    // System-wide CDP collateralization-ratio aggregated from all live
    // Indigo CDP UTxOs. Adapter: `srv/adapters/indigo-cdp.ts`. Returned
    // as AttestationQuote with unit='ratio_pct'.
    reservesPair:'iUSD-COLLATERAL',
  },
  USDA: {
    symbol:      'USDA',
    peg:         'USD',
    backing:     'fiat-custodial',
    issuer:      { name: 'Anzens / EMURGO', jurisdiction: 'US', custodian: 'BitGo Trust' },
    policyId:    'fe7c786ab321f41c654ef6c1af7b3250a613c24e4213e0425a7ae456',
    assetNameHex:'55534441',  // ASCII "USDA"
    decimals:    6,
    liveSince:   '2025-01-01',  // approximate; refine when EMURGO publishes exact launch
    pegPair:     'ADA-USDA',
    // No reservesPair — verified 2026-05-02 that NEITHER anzens.com NOR
    // bitgo.com publishes a fetchable attestation/proof-of-reserves URL.
    // Anzens' landing page only states "USDA is backed by dollars and dollar
    // equivalents" without linking auditor reports. BitGo's transparency
    // page returns 404 / not present at the standard URLs. Re-enable when
    // either issuer publishes an indexable attestation; until then the
    // `reserves-unsubstantiated` alert correctly flags the gap to consumers.
  },
  USDCx: {
    symbol:      'USDCx',
    peg:         'USD',
    backing:     'fiat-custodial',
    issuer:      { name: 'Circle (via IOG xReserve)', jurisdiction: 'US', custodian: 'Circle' },
    policyId:    '1f3aec8bfe7ea4fe14c5f121e2a92e301afe414147860d557cac7e34',
    assetNameHex:'5553444378',  // ASCII "USDCx"
    decimals:    6,
    liveSince:   '2026-02-18',
    pegPair:     'ADA-USDCx',
    // Off-chain monthly attestation: Circle's USDC examination report
    // (Deloitte-audited) covers all chains incl. Cardano via xReserve as
    // one global pool. Adapter `srv/adapters/circle-usdc-attestation.ts`
    // hash-seals the latest PDF + signals freshness via the timestamp.
    reservesPair:'USDCx-ATTESTATION',
  },
  // Wanchain-bridged USDT + USDC dropped 2026-05-03 with the DexHunter
  // removal — no liquid direct DEX pool for either (all pools < 1k ADA
  // TVL, Wanchain bridge winding down post-USDCx). Re-add when liquidity
  // returns.
});

/**
 * Lookup by `ADA-X` pair name. Returns the metadata for X if X is a
 * registered stable. Used by the price-service to decide whether to
 * compute peg-deviation for a request.
 */
export function metadataForPair(pair: string): StableMetadata | undefined {
  const m = pair.match(/^ADA-(.+)$/);
  if (!m) return undefined;
  return STABLE_METADATA[m[1]!];
}

/** Direct symbol lookup. Symbol is case-sensitive (we ship them lowercase-rare). */
export function metadataForSymbol(symbol: string): StableMetadata | undefined {
  return STABLE_METADATA[symbol];
}

/** All registered symbols in declaration order. */
export function allStableSymbols(): string[] {
  return Object.keys(STABLE_METADATA);
}
