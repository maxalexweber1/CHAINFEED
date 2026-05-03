/**
 * ODATANO bridge — wraps the @odatano/core programmatic API in a small,
 * stable internal API for CHAINFEED adapters and middleware.
 *
 * Why bypass the CDS services and go direct: the CAP-served services from
 * ODATANO are designed for HTTP consumers (BI tools, dapps). In-process,
 * we want fewer layers — the CardanoClient is already battle-tested with
 * Blockfrost/Koios/Ogmios failover and circuit breakers. Going direct
 * also sidesteps the `cds.serve` lifecycle, which is awkward to boot
 * inside ad-hoc scripts.
 */

import * as odatano from '@odatano/core';

interface UtxoAsset {
  /** policyId + assetNameHex (concatenated, lowercase hex) */
  unit: string;
  policyId: string;
  assetNameHex: string;
  /** raw asset units (string to preserve precision) */
  quantity: string;
}

interface Utxo {
  txHash: string;
  outputIndex: number;
  address: string;
  lovelace: string;
  assets: UtxoAsset[];
  dataHash?: string;
  inlineDatumHex?: string;
  referenceScriptHash?: string;
}

interface RawAmount { unit?: string; quantity?: string | number }
interface RawUtxo {
  txHash?: string;
  outputIndex?: number | string;
  address?: string;
  amount?: RawAmount[];
  datumHash?: string;
  scriptRef?: string;
  /**
   * Inline datum hex — auto-populated since @odatano/core 1.7.6 across
   * Blockfrost + Koios backends. Eliminates the previous "fetch full tx
   * just to read one output's datum" round-trip pattern.
   */
  inlineDatum?: string | null;
}

/**
 * Native-asset metadata as returned by ODATANO's `getAssetInfo`. Available
 * since 1.7.6. Cross-backend (Blockfrost + Koios). Field availability
 * differs per backend — `initialMintTime` is null on Blockfrost, registry
 * fields are null on Koios for non-CIP-26-listed assets.
 */
interface AssetInfo {
  unit: string;
  policyId: string;
  assetNameHex: string;
  assetName: string | null;
  fingerprint: string;
  totalSupply: string;
  mintOrBurnCount: number;
  initialMintTxHash: string | null;
  initialMintTime: string | null;
  onchainMetadata: unknown;
  registryName?: string | null;
  registryTicker?: string | null;
  registryDecimals?: number | null;
  registryDescription?: string | null;
  registryUrl?: string | null;
  registryLogo?: string | null;
}

interface CardanoClient {
  getAddressUtxos(address: string): Promise<RawUtxo[]>;
  /** Since 1.7.6 — Koios-only. Throws on Blockfrost/Ogmios. */
  getCredentialUtxos(credHash: string): Promise<RawUtxo[]>;
  /** Since 1.7.6 — Blockfrost+Koios. Per-backend field availability differs. */
  getAssetInfo(unit: string): Promise<AssetInfo>;
  getTransaction(txHash: string): Promise<unknown>;
  getProtocolParameters(): Promise<unknown>;
  submitTransaction(cborHex: string): Promise<string>;
}

interface OdatanoModule {
  initialize(): Promise<unknown>;
  shutdown(): Promise<unknown>;
  getCardanoClient(): CardanoClient;
}

const od = odatano as unknown as OdatanoModule;

let _initPromise: Promise<unknown> | null = null;

async function ensureInit(): Promise<unknown> {
  if (!_initPromise) {
    _initPromise = od.initialize().catch(err => {
      _initPromise = null;
      throw err;
    });
  }
  return _initPromise;
}

/**
 * Map a Blockfrost / Koios UTxO into our flat Utxo shape.
 *
 * Since @odatano/core 1.7.6, `inlineDatum` is auto-populated on the
 * RawUtxo across both backends. We pass it through as `inlineDatumHex`
 * — eliminating the historical pattern of "fetch full tx to read one
 * output's datum" that previously slowed iUSD-CDP-like enumeration to
 * 30+ seconds on multi-UTxO scripts.
 */
function mapUtxo(u: RawUtxo): Utxo {
  const amount = u.amount ?? [];
  const lovelaceEntry = amount.find(a => a.unit === 'lovelace');
  const lovelace = lovelaceEntry?.quantity ?? '0';

  const assets: UtxoAsset[] = amount
    .filter(a => a.unit !== 'lovelace')
    .map(a => {
      const unit = String(a.unit ?? '').toLowerCase();
      // Policy ID is the first 28 bytes (56 hex chars); the rest is asset name hex.
      const policyId = unit.slice(0, 56);
      const assetNameHex = unit.slice(56);
      return {
        unit,
        policyId,
        assetNameHex,
        quantity: String(a.quantity ?? '0'),
      };
    });

  return {
    txHash:              String(u.txHash ?? ''),
    outputIndex:         Number(u.outputIndex ?? 0),
    address:             String(u.address ?? ''),
    lovelace:            String(lovelace),
    assets,
    dataHash:            u.datumHash ?? undefined,
    inlineDatumHex:      u.inlineDatum ?? undefined,
    referenceScriptHash: u.scriptRef ?? undefined,
  };
}

/**
 * Fetch all UTxOs at a Bech32 address. Since ODATANO 1.7.6, `inlineDatumHex`
 * is auto-populated on each UTxO — no separate `getTransactionByHash` call
 * required for datum decoding.
 */
async function getUtxosAtAddress(address: string): Promise<Utxo[]> {
  if (!address || typeof address !== 'string') {
    throw new TypeError('getUtxosAtAddress: address must be a non-empty string');
  }
  await ensureInit();
  const client = od.getCardanoClient();
  const rows = await client.getAddressUtxos(address);
  return Array.isArray(rows) ? rows.map(mapUtxo) : [];
}

/**
 * Fetch all UTxOs sharing a 28-byte payment credential (script-hash for
 * scripts, key-hash for wallets). Captures both bech32 forms (with and
 * without stake credential) in one round-trip — solves the "Indigo CDP
 * manager has two bech32 variants" problem natively.
 *
 * Since ODATANO 1.7.6. Backend: **Koios-only** — throws on
 * Blockfrost/Ogmios deployments because they don't support the
 * credential-based query natively. The bridge surfaces that as a clear
 * error so callers know to either change backend config or fall back to
 * per-bech32 enumeration.
 */
async function getUtxosAtCredential(credHash: string): Promise<Utxo[]> {
  if (!credHash || typeof credHash !== 'string' || credHash.length !== 56 || !/^[0-9a-f]+$/i.test(credHash)) {
    throw new TypeError('getUtxosAtCredential: credHash must be 56-char lowercase hex (28-byte payment credential)');
  }
  await ensureInit();
  const client = od.getCardanoClient();
  const rows = await client.getCredentialUtxos(credHash);
  return Array.isArray(rows) ? rows.map(mapUtxo) : [];
}

/**
 * Fetch native-asset metadata (total supply, mint/burn count, registry
 * fields, …). Since ODATANO 1.7.6. Cross-backend (Blockfrost + Koios) —
 * field availability differs per backend.
 *
 * `unit` is `policyId + assetNameHex` concatenated, lowercase hex.
 */
async function getAssetInfo(unit: string): Promise<AssetInfo> {
  if (!unit || typeof unit !== 'string') {
    throw new TypeError('getAssetInfo: unit (policyId + assetNameHex) must be a non-empty string');
  }
  await ensureInit();
  const client = od.getCardanoClient();
  return client.getAssetInfo(unit.toLowerCase());
}

/** Fetch UTxOs at an address that hold a specific native asset. */
async function getUtxosWithAsset(
  address: string,
  policyId: string,
  assetNameHex: string,
): Promise<Utxo[]> {
  if (!policyId) throw new TypeError('getUtxosWithAsset: policyId required');
  const unit = (policyId + (assetNameHex ?? '')).toLowerCase();
  const all = await getUtxosAtAddress(address);
  return all.filter(u => u.assets.some(a => a.unit === unit));
}

/**
 * Fetch a transaction by hash, including full input/output data with
 * `inlineDatum` populated where present. Used by the Orcfax adapter to
 * decode price datums and by x402 settlement confirmation.
 *
 * Returns ODATANO's Transaction shape, or `null` if not yet visible.
 */
async function getTransactionByHash(txHash: string): Promise<unknown> {
  if (!txHash) throw new TypeError('getTransactionByHash: txHash required');
  await ensureInit();
  const client = od.getCardanoClient();
  try {
    return await client.getTransaction(txHash);
  } catch (err) {
    const e = err as { code?: number; statusCode?: number; message?: string };
    if (e?.code === 404 || e?.statusCode === 404 || /not.?found/i.test(e?.message ?? '')) {
      return null;
    }
    throw err;
  }
}

/**
 * Fetch current ledger protocol parameters. Used by tx-building scripts.
 * Pass-through of ODATANO's normalised shape — caller maps to CSL config.
 */
async function getProtocolParameters(): Promise<unknown> {
  await ensureInit();
  const client = od.getCardanoClient();
  return client.getProtocolParameters();
}

/**
 * Submit a signed transaction (CBOR hex) to the network.
 * Returns the tx hash on acceptance.
 */
async function submitTransaction(signedTxCborHex: string): Promise<string> {
  if (!signedTxCborHex) throw new TypeError('submitTransaction: signedTxCborHex required');
  await ensureInit();
  const client = od.getCardanoClient();
  return client.submitTransaction(signedTxCborHex);
}

/**
 * Cleanly shut down the underlying ODATANO client (closes Ogmios websockets etc).
 * Intended for scripts that boot the bridge ad-hoc and need to exit cleanly.
 */
async function shutdown(): Promise<void> {
  if (!_initPromise) return;
  await od.shutdown();
  _initPromise = null;
}

// Plain CJS export so tests can monkey-patch bridge methods at runtime.
export = {
  getUtxosAtAddress,
  getUtxosAtCredential,    // since ODATANO 1.7.6 — Koios-only
  getUtxosWithAsset,
  getAssetInfo,            // since ODATANO 1.7.6
  getTransactionByHash,
  getProtocolParameters,
  submitTransaction,
  shutdown,
  // exposed for tests:
  _mapUtxo: mapUtxo,
};
