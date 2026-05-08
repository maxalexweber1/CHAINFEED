/**
 * Liqwid Finance v2 — static on-chain configuration (mainnet).
 *
 * Reverse-engineered 2026-05-08 from live MarketState UTxOs. Liqwid v2 is
 * closed-source Plutarch (Aiken v3 announced but not deployed); these
 * addresses + policies were derived from on-chain inspection via Koios.
 *
 * Anchor sources:
 *   - qDJED batch tx cd1736c23a2713f6635def23b3a1376a6da289d4e3a80c09578e52e7ff632683
 *   - qiUSD batch tx 5f46b02969889fcdefe6ec1669439480de74abc6a52d0edec966105724f1ada1
 *   - qUSDM batch tx dc896369dd351f66cf427e5d1d9dce25fddea05c9daa3193c3c2f7f847baac1b
 *
 * Each market has a 3-script architecture (MarketState singleton +
 * MarketInbox singleton + 4 SupplyBatch UTxOs sharded). CHAINFEED reads
 * MarketState only — `field[0]` aggregates idle supply post-batch-settle,
 * and the rate-curve params live in `field[6]` whose encoding is unknown.
 * Hybrid strategy: on-chain for supply/borrow/utilization/qTokenRate,
 * GraphQL (https://v2.api.liqwid.finance/graphql) for supplyAPY/borrowAPY.
 *
 * No preview/preprod entries — Liqwid does not have a meaningful testnet
 * deploy as of 2026-05-08.
 */

export type LiqwidNetwork = 'mainnet';

export interface LiqwidMarket {
  /** Canonical CHAINFEED ticker (matches stable-metadata registry where overlapping). */
  symbol: 'DJED' | 'iUSD' | 'USDM';
  /** Liqwid GraphQL `id` field — used for the API fallback (APY data). */
  liqwidId: 'DJED' | 'IUSD' | 'USDM';
  /** Bech32 of the singleton MarketState UTxO (one per market). */
  marketStateAddrBech32: string;
  /** Payment-credential hex of marketStateAddrBech32 — used for bridge.getUtxosAtCredential. */
  marketStateHash: string;
  /** qToken policy ID. Asset name is empty (CIP-26 registered). */
  qTokenPolicy: string;
  /** Underlying-asset decimals. Used to scale raw → whole units uniformly with the rest of CHAINFEED. */
  decimals: 6;
}

interface LiqwidNetworkConfig {
  markets: ReadonlyArray<LiqwidMarket>;
  /** Liqwid v2 GraphQL API root. CORS open, no auth required. */
  graphqlEndpoint: string;
}

export const LIQWID_CONFIG: Readonly<Record<LiqwidNetwork, LiqwidNetworkConfig>> = Object.freeze({
  mainnet: {
    graphqlEndpoint: 'https://v2.api.liqwid.finance/graphql',
    markets: [
      {
        symbol: 'DJED',
        liqwidId: 'DJED',
        marketStateAddrBech32: 'addr1w85g7uhkk3nnmduwlc2gk8xep35fz9wak0t7x44qqqc53ncahh4lz',
        marketStateHash:       'e88f72f6b4673db78efe148b1cd90c689115ddb3d7e356a0003148cf',
        qTokenPolicy:          '6df63e2fdde8b2c3b3396265b0cc824aa4fb999396b1c154280f6b0c',
        decimals: 6,
      },
      {
        symbol: 'iUSD',
        liqwidId: 'IUSD',
        marketStateAddrBech32: 'addr1w94gxm5tksyw75gs5arhqwdf7h7yre2ma878ad2xfhhcy6cq7q4tp',
        marketStateHash:       '6a836e8bb408ef5110a7477039a9f5fc41e55be9fc7eb5464def826b',
        qTokenPolicy:          'd15c36d6dec655677acb3318294f116ce01d8d9def3cc54cdd78909b',
        decimals: 6,
      },
      {
        symbol: 'USDM',
        liqwidId: 'USDM',
        marketStateAddrBech32: 'addr1wyz6rmlg2g88hnp8ugeakh6m2p9nng2w39a4vss0x0u0z0cqvh2js',
        marketStateHash:       '05a1efe8520e7bcc27e233db5f5b504b39a14e897b56420f33f8f13f',
        qTokenPolicy:          '9e00df0615de0a7b121a7f961d43e23165b8e81b64786c6eb708d370',
        decimals: 6,
      },
    ],
  },
} as const satisfies Readonly<Record<LiqwidNetwork, LiqwidNetworkConfig>>);

/**
 * Resolve the active Liqwid network. FluidTokens-style override:
 *   LIQWID_NETWORK > NETWORK > 'mainnet' (the only deployed network).
 * Throws on any non-mainnet value so a stray `NETWORK=preview` env
 * doesn't silently produce empty results.
 */
export function resolveLiqwidNetwork(): LiqwidNetwork {
  const raw = (process.env.LIQWID_NETWORK || process.env.NETWORK || 'mainnet').toLowerCase();
  if (raw !== 'mainnet') {
    throw new Error(
      `liqwid: unsupported network '${raw}' (only 'mainnet' is deployed; ` +
      `set LIQWID_NETWORK=mainnet to override a global NETWORK=${raw})`,
    );
  }
  return 'mainnet';
}

export function cfg(network: LiqwidNetwork = resolveLiqwidNetwork()): LiqwidNetworkConfig {
  const c = LIQWID_CONFIG[network];
  if (!c) throw new Error(`liqwid: missing config for network '${network}'`);
  return c;
}

/** Lookup a market by symbol. Returns null if not in scope (not DJED/iUSD/USDM). */
export function marketBySymbol(
  symbol: string,
  network: LiqwidNetwork = resolveLiqwidNetwork(),
): LiqwidMarket | null {
  const wanted = symbol.toUpperCase();
  return cfg(network).markets.find(m => m.symbol.toUpperCase() === wanted) ?? null;
}
