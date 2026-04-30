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
}

interface CardanoClient {
  getAddressUtxos(address: string): Promise<RawUtxo[]>;
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
 * Map a Blockfrost-shape UTxO (as returned by CardanoClient.getAddressUtxos)
 * to our flat Utxo shape.
 *
 * Note: getAddressUtxos returns the lite shape — `inlineDatumHex` is NOT
 * populated. Use `getTransactionByHash` if you need datum decoding for a
 * specific UTxO.
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
    referenceScriptHash: u.scriptRef ?? undefined,
  };
}

/** Fetch all UTxOs at a given Bech32 address (lite shape — no inline datum). */
async function getUtxosAtAddress(address: string): Promise<Utxo[]> {
  if (!address || typeof address !== 'string') {
    throw new TypeError('getUtxosAtAddress: address must be a non-empty string');
  }
  await ensureInit();
  const client = od.getCardanoClient();
  const rows = await client.getAddressUtxos(address);
  return Array.isArray(rows) ? rows.map(mapUtxo) : [];
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
  getUtxosWithAsset,
  getTransactionByHash,
  getProtocolParameters,
  submitTransaction,
  shutdown,
  // exposed for tests:
  _mapUtxo: mapUtxo,
};
