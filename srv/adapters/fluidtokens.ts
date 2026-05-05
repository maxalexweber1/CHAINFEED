/**
 * FluidTokens Lending V3 adapter.
 *
 * Reads every active lender pool + active loan UTxO from the live mainnet
 * deploy. Surfaces system-wide aggregates (`FLUIDTOKENS-POOLS`,
 * `FLUIDTOKENS-LOANS`) as `AttestationQuote` so it slots into the existing
 * `attestationFanout()` shape without changing the `Quote` union.
 *
 * Heavy data — per-pool / per-loan structured records — lives in
 * `rawPayload` and is also surfaced via the side-door exports
 * `_fetchAllPools` / `_fetchAllLoans` for the composite-health endpoint
 * (`getFluidtokensHealth`) which needs to filter by principal-asset.
 *
 * Bridge calls:
 *   - `bridge.getUtxosAtCredential(poolSpendHash)` → all pool UTxOs in
 *     one Koios round-trip; inline_datum auto-populated by ODATANO 1.7.6.
 *   - `bridge.getUtxosAtCredential(loanSpendHash)` → same for loans.
 *
 * Filtering:
 *   - Pool UTxOs MUST contain exactly 1 token under `poolPolicy` to be
 *     considered an authentic pool. The pool-NFT is the verifiable identity.
 *   - Loan UTxOs MUST contain exactly 1 token under `loanPolicy` (same logic).
 *
 * Pair contract:
 *   - `FLUIDTOKENS-POOLS`  → AttestationQuote, value = active pool count,
 *                            unit = 'count', rawPayload.pools = full list
 *   - `FLUIDTOKENS-LOANS`  → AttestationQuote, value = active loan count,
 *                            unit = 'count', rawPayload.loans = full list
 *
 * The composite endpoint (`srv/lib/fluidtokens-health.ts`) consumes
 * `_fetchAllPools` + `_fetchAllLoans` directly to do per-asset rollups
 * with finance.ak math applied to each loan.
 */

import bridge from '../external/odatano-bridge';
import { assertIsAdapter, type AttestationQuote, type PriceAdapter } from './types';
import {
  cfg, resolveFluidNetwork, type FluidNetwork,
} from '../lib/fluidtokens-config';
import {
  decodePoolDatum, decodeLoanDatum,
  type DecodedPoolDatum, type DecodedLoanDatum,
} from '../lib/fluidtokens-decoder';

const SOURCE_NAME = 'fluidtokens';

const PAIR_POOLS = 'FLUIDTOKENS-POOLS';
const PAIR_LOANS = 'FLUIDTOKENS-LOANS';
const SUPPORTED_PAIRS = new Set([PAIR_POOLS, PAIR_LOANS]);

/** Loose UTxO shape — bridge returns this; tests monkey-patch with the same fields. */
interface BridgeUtxo {
  txHash?: string;
  outputIndex?: number;
  lovelace?: string;
  inlineDatumHex?: string;
  assets?: Array<{ unit?: string; policyId?: string; assetNameHex?: string; quantity?: string }>;
}

// ── Pool aggregation ─────────────────────────────────────────────────

// Type re-exports happen below after the `export = exported` block via the
// `_types` namespace; keeping these as `interface` (not `export interface`)
// because tsc forbids named exports alongside `export =`.
interface PoolSnapshot {
  /** Pool-NFT asset-name hex — stable identifier of this pool across reads. */
  poolIdHex: string;
  txHash: string;
  outputIndex: number;
  /** Lovelace held in the UTxO. For ADA-pools this is liquidity available
   *  to borrow; for non-ADA principal pools the available principal is in
   *  the asset list (computed below into `availablePrincipalRaw`). */
  lovelace: bigint;
  /** Available principal (raw units) to borrow.
   *  - For ADA-principal pools: equals the lovelace value (minus minADA reserve).
   *  - For native-token-principal pools: equals the asset's quantity in the UTxO. */
  availablePrincipalRaw: bigint;
  /** Decoded PoolDatum — full schema for downstream consumers. */
  datum: DecodedPoolDatum;
}

/** Parse one pool UTxO. Returns null if datum doesn't decode or pool-NFT is missing. */
function parsePoolUtxo(u: BridgeUtxo, poolPolicy: string): PoolSnapshot | null {
  if (!u.inlineDatumHex) return null;
  const datum = decodePoolDatum(u.inlineDatumHex);
  if (!datum) return null;

  // Verify pool-NFT membership — the authentic-pool guard.
  const hasPoolNft = (u.assets ?? []).some(a => a.policyId === poolPolicy && a.quantity === '1');
  if (!hasPoolNft) return null;

  const lovelace = BigInt(u.lovelace ?? '0');
  const principal = datum.commonData.principalAsset;
  let availablePrincipalRaw: bigint;
  if (principal.policyId === '' && principal.assetNameHex === '') {
    // ADA-principal pool — available to borrow ≈ lovelace value (caller can
    // subtract minADA if needed; we surface the raw lovelace).
    availablePrincipalRaw = lovelace;
  } else {
    const principalUnit = principal.policyId + principal.assetNameHex;
    const found = (u.assets ?? []).find(a => a.unit === principalUnit);
    availablePrincipalRaw = BigInt(found?.quantity ?? '0');
  }

  return {
    poolIdHex: extractPoolIdFromAssets(u.assets ?? [], poolPolicy),
    txHash: u.txHash ?? '',
    outputIndex: u.outputIndex ?? 0,
    lovelace,
    availablePrincipalRaw,
    datum,
  };
}

function extractPoolIdFromAssets(
  assets: Array<{ policyId?: string; assetNameHex?: string }>,
  poolPolicy: string,
): string {
  const nft = assets.find(a => a.policyId === poolPolicy);
  return nft?.assetNameHex ?? '';
}

/**
 * Fetch every active pool from the live deploy. One bridge call.
 * Side-door API consumed by `srv/lib/fluidtokens-health.ts` and tests;
 * the public path is via `getPrice('FLUIDTOKENS-POOLS')`.
 */
async function fetchAllPools(network: FluidNetwork = resolveFluidNetwork()): Promise<{
  pools: PoolSnapshot[];
  totalUtxos: number;
  skippedNoDatum: number;
  skippedNoPoolNft: number;
  skippedDecode: number;
}> {
  const c = cfg(network);
  const utxos = await bridge.getUtxosAtCredential(c.poolSpendHash) as BridgeUtxo[];
  if (!Array.isArray(utxos)) {
    throw new Error('fluidtokens: bridge.getUtxosAtCredential returned non-array');
  }
  let skippedNoDatum = 0, skippedNoPoolNft = 0, skippedDecode = 0;
  const pools: PoolSnapshot[] = [];
  for (const u of utxos) {
    if (!u.inlineDatumHex) { skippedNoDatum++; continue; }
    const datum = decodePoolDatum(u.inlineDatumHex);
    if (!datum) { skippedDecode++; continue; }
    const hasPoolNft = (u.assets ?? []).some(a => a.policyId === c.poolPolicy && a.quantity === '1');
    if (!hasPoolNft) { skippedNoPoolNft++; continue; }
    const snap = parsePoolUtxo(u, c.poolPolicy);
    if (snap) pools.push(snap);
  }
  return {
    pools, totalUtxos: utxos.length,
    skippedNoDatum, skippedNoPoolNft, skippedDecode,
  };
}

// ── Loan aggregation ─────────────────────────────────────────────────

interface LoanSnapshot {
  /** Loan-NFT asset-name hex — stable loan identifier. */
  loanIdHex: string;
  txHash: string;
  outputIndex: number;
  /** Collateral held in the UTxO (lovelace — primary collateral form). */
  collateralLovelace: bigint;
  /** Native-token collateral (if any) in the UTxO, excluding the loan-NFT. */
  nativeCollateral: Array<{ unit: string; quantity: string }>;
  /** Pool the loan was issued from — links back via PoolDatum.poolIdHex. */
  poolIdHex: string;
  datum: DecodedLoanDatum;
}

/** Parse one loan UTxO. Returns null if datum doesn't decode or loan-NFT is missing. */
function parseLoanUtxo(u: BridgeUtxo, loanPolicy: string): LoanSnapshot | null {
  if (!u.inlineDatumHex) return null;
  const datum = decodeLoanDatum(u.inlineDatumHex);
  if (!datum) return null;

  const loanNft = (u.assets ?? []).find(a => a.policyId === loanPolicy && a.quantity === '1');
  if (!loanNft) return null;

  const nativeCollateral = (u.assets ?? [])
    .filter(a => a.policyId !== loanPolicy && a.unit && a.quantity)
    .map(a => ({ unit: a.unit!, quantity: a.quantity! }));

  return {
    loanIdHex: loanNft.assetNameHex ?? '',
    txHash: u.txHash ?? '',
    outputIndex: u.outputIndex ?? 0,
    collateralLovelace: BigInt(u.lovelace ?? '0'),
    nativeCollateral,
    poolIdHex: datum.poolIdHex,
    datum,
  };
}

/**
 * Fetch every active loan UTxO from the live deploy. One bridge call.
 */
async function fetchAllLoans(network: FluidNetwork = resolveFluidNetwork()): Promise<{
  loans: LoanSnapshot[];
  totalUtxos: number;
  skippedNoDatum: number;
  skippedNoLoanNft: number;
  skippedDecode: number;
}> {
  const c = cfg(network);
  const utxos = await bridge.getUtxosAtCredential(c.loanSpendHash) as BridgeUtxo[];
  if (!Array.isArray(utxos)) {
    throw new Error('fluidtokens: bridge.getUtxosAtCredential returned non-array');
  }
  let skippedNoDatum = 0, skippedNoLoanNft = 0, skippedDecode = 0;
  const loans: LoanSnapshot[] = [];
  for (const u of utxos) {
    if (!u.inlineDatumHex) { skippedNoDatum++; continue; }
    const datum = decodeLoanDatum(u.inlineDatumHex);
    if (!datum) { skippedDecode++; continue; }
    const loanNft = (u.assets ?? []).find(a => a.policyId === c.loanPolicy && a.quantity === '1');
    if (!loanNft) { skippedNoLoanNft++; continue; }
    const snap = parseLoanUtxo(u, c.loanPolicy);
    if (snap) loans.push(snap);
  }
  return {
    loans, totalUtxos: utxos.length,
    skippedNoDatum, skippedNoLoanNft, skippedDecode,
  };
}

// ── PriceAdapter shape ───────────────────────────────────────────────

async function getPrice(pair: string): Promise<AttestationQuote> {
  if (!SUPPORTED_PAIRS.has(pair)) {
    throw new Error(`fluidtokens: pair '${pair}' not supported (FLUIDTOKENS-POOLS | FLUIDTOKENS-LOANS)`);
  }
  const network = resolveFluidNetwork();

  if (pair === PAIR_POOLS) {
    const r = await fetchAllPools(network);
    // Group pools by principal-asset for a quick rollup; consumers can
    // reconstruct from rawPayload.pools if they want different groupings.
    const perAsset: Record<string, { count: number; availableRaw: string; lovelace: string }> = {};
    for (const p of r.pools) {
      const key = principalAssetKey(p.datum.commonData.principalAsset);
      const bucket = perAsset[key] ??= { count: 0, availableRaw: '0', lovelace: '0' };
      bucket.count++;
      bucket.availableRaw = (BigInt(bucket.availableRaw) + p.availablePrincipalRaw).toString();
      bucket.lovelace     = (BigInt(bucket.lovelace) + p.lovelace).toString();
    }
    return {
      kind: 'attestation',
      sourceName: SOURCE_NAME,
      pair,
      value: r.pools.length,
      unit: 'count',
      timestamp: Date.now(),
      rawPayload: {
        network,
        poolCount: r.pools.length,
        perAsset,
        pools: r.pools.map(p => ({
          poolIdHex: p.poolIdHex,
          txHash: p.txHash,
          outputIndex: p.outputIndex,
          lovelace: p.lovelace.toString(),
          availablePrincipalRaw: p.availablePrincipalRaw.toString(),
          principalAsset: p.datum.commonData.principalAsset,
          interestRate: p.datum.commonData.interestRate,
          repaymentMode: p.datum.commonData.repaymentMode,
          liquidationMode: p.datum.commonData.liquidationMode,
          installmentPeriod: p.datum.commonData.installmentPeriod,
          totalInstallments: p.datum.commonData.totalInstallments,
          isPermissioned: p.datum.isPermissioned,
          collateralOptions: p.datum.collateralOptions.map(c => ({
            asset: c.asset,
            oracleTokenAsset: c.oracleTokenAsset,
          })),
        })),
        utxoStats: {
          totalUtxos: r.totalUtxos,
          skippedNoDatum: r.skippedNoDatum,
          skippedNoPoolNft: r.skippedNoPoolNft,
          skippedDecode: r.skippedDecode,
          decoded: r.pools.length,
        },
        configAddress: cfg(network).poolAddrBech32,
      },
    };
  }

  // FLUIDTOKENS-LOANS
  const r = await fetchAllLoans(network);
  const perAsset: Record<string, { count: number; outstandingRaw: string; collateralLovelace: string }> = {};
  for (const l of r.loans) {
    const key = principalAssetKey(l.datum.principalAsset);
    const bucket = perAsset[key] ??= { count: 0, outstandingRaw: '0', collateralLovelace: '0' };
    bucket.count++;
    bucket.outstandingRaw      = (BigInt(bucket.outstandingRaw) + l.datum.principal).toString();
    bucket.collateralLovelace  = (BigInt(bucket.collateralLovelace) + l.collateralLovelace).toString();
  }
  return {
    kind: 'attestation',
    sourceName: SOURCE_NAME,
    pair,
    value: r.loans.length,
    unit: 'count',
    timestamp: Date.now(),
    rawPayload: {
      network,
      loanCount: r.loans.length,
      perAsset,
      loans: r.loans.map(l => ({
        loanIdHex: l.loanIdHex,
        txHash: l.txHash,
        outputIndex: l.outputIndex,
        poolIdHex: l.poolIdHex,
        collateralLovelace: l.collateralLovelace.toString(),
        nativeCollateral: l.nativeCollateral,
        principal: l.datum.principal.toString(),
        principalAsset: l.datum.principalAsset,
        interestRate: l.datum.interestRate,
        lendDateMs: l.datum.lendDateMs,
        repaidInstallments: l.datum.repaidInstallments,
        installmentPeriod: l.datum.installmentPeriod,
        totalInstallments: l.datum.totalInstallments,
        repaymentMode: l.datum.repaymentMode,
        liquidationMode: l.datum.liquidationMode,
      })),
      utxoStats: {
        totalUtxos: r.totalUtxos,
        skippedNoDatum: r.skippedNoDatum,
        skippedNoLoanNft: r.skippedNoLoanNft,
        skippedDecode: r.skippedDecode,
        decoded: r.loans.length,
      },
    },
  };
}

function principalAssetKey(a: { policyId: string; assetNameHex: string }): string {
  if (a.policyId === '' && a.assetNameHex === '') return 'ADA';
  // Hex unit; consumer can resolve to ticker via STABLE_METADATA if recognized.
  return (a.policyId + a.assetNameHex).toLowerCase();
}

function supportsPair(pair: string): boolean {
  return SUPPORTED_PAIRS.has(pair);
}

const adapter: PriceAdapter = { sourceName: SOURCE_NAME, getPrice, supportsPair };
assertIsAdapter(adapter, 'fluidtokens');

const exported = {
  ...adapter,
  // exposed for the composite health endpoint + tests:
  _fetchAllPools: fetchAllPools,
  _fetchAllLoans: fetchAllLoans,
  _PAIR_POOLS: PAIR_POOLS,
  _PAIR_LOANS: PAIR_LOANS,
  _principalAssetKey: principalAssetKey,
};

export = exported;
