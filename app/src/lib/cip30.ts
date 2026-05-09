/**
 * CIP-30 wallet detection + thin typed wrapper.
 *
 * Detects CHAINFEED-compatible Cardano browser wallets via the standard
 * `window.cardano.<name>` injection. Returns a uniform `Cip30Api` shape
 * regardless of the underlying wallet vendor.
 *
 * No tx-building here — that's server-side via `buildPaymentTx`. This
 * module only handles: detection, connection, address retrieval, and
 * the `signTx` round-trip.
 */

export const SUPPORTED_WALLETS = [
  'lace',
  'eternl',
  'nami',
  'flint',
  'typhon',
  'gerowallet',
  'nufi',
  'yoroi',
] as const;

export type WalletName = typeof SUPPORTED_WALLETS[number];

export interface WalletInfo {
  /** key under window.cardano */
  key: WalletName;
  /** display name (may differ from key, e.g. "Eternl" vs key "eternl") */
  name: string;
  /** data-URL or HTTPS URL of the wallet's icon */
  icon: string;
  /** API version reported by the wallet */
  apiVersion: string;
}

/** Methods exposed by a connected CIP-30 wallet. */
export interface Cip30Api {
  /** CBOR-hex address strings — first one is canonical for receiving. */
  getUsedAddresses(): Promise<string[]>;
  getUnusedAddresses(): Promise<string[]>;
  getChangeAddress(): Promise<string>;
  /** Network identifier — 0 = testnet (preview/preprod), 1 = mainnet. */
  getNetworkId(): Promise<number>;
  /**
   * Sign a transaction. Returns CBOR-hex of a `transaction_witness_set`
   * (NOT the full signed tx — the caller combines tx + witness_set).
   * `partialSign=true` allows wallets to sign only the inputs they
   * recognise; we always pass false because the buyer's own UTxOs are
   * the only inputs in our payment tx.
   */
  signTx(txCborHex: string, partialSign?: boolean): Promise<string>;
  /** UTxOs the wallet considers spendable. Hex-encoded `transaction_unspent_output`. */
  getUtxos(): Promise<string[] | null>;
}

interface InjectedWallet {
  apiVersion: string;
  name?: string;
  icon: string;
  enable(): Promise<Cip30Api>;
  isEnabled?(): Promise<boolean>;
}

declare global {
  interface Window {
    cardano?: Partial<Record<WalletName, InjectedWallet>>;
  }
}

/** List wallets that injected a `window.cardano.<name>` namespace. */
export function detectWallets(): WalletInfo[] {
  if (typeof window === 'undefined' || !window.cardano) return [];
  const out: WalletInfo[] = [];
  for (const key of SUPPORTED_WALLETS) {
    const w = window.cardano[key];
    if (!w) continue;
    out.push({
      key,
      name: w.name ?? key.charAt(0).toUpperCase() + key.slice(1),
      icon: w.icon,
      apiVersion: w.apiVersion,
    });
  }
  return out;
}

/** Connect to a named wallet and return its API. */
export async function connectWallet(key: WalletName): Promise<Cip30Api> {
  if (typeof window === 'undefined' || !window.cardano) {
    throw new Error('CIP-30 wallets are only available in a browser');
  }
  const w = window.cardano[key];
  if (!w) throw new Error(`wallet '${key}' is not installed`);
  return w.enable();
}

/** hex-string → Uint8Array (no Node Buffer dep). */
function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('hexToBytes: odd-length hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Uint8Array → hex-string. */
function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i]!.toString(16).padStart(2, '0');
  return s;
}

/** Uint8Array → base64 (browser btoa works on binary strings). */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

/**
 * CIP-30 returns addresses as CBOR-hex of a `Cardano.Address`. Decoding
 * to bech32 needs CSL; we lazy-load it on first use to keep the demo
 * page's initial bundle lean.
 */
export async function hexAddressToBech32(addrHex: string): Promise<string> {
  const CSL = await import('@emurgo/cardano-serialization-lib-browser');
  const bytes = hexToBytes(addrHex);
  return CSL.Address.from_bytes(bytes).to_bech32();
}

/**
 * Combine an unsigned tx CBOR (from CHAINFEED's `buildPaymentTx`) with
 * a witness-set CBOR (from CIP-30 `signTx`) and return the final signed
 * tx as base64 ready for X-PAYMENT.
 */
export async function combineTxWithWitness(
  unsignedTxCborHex: string,
  witnessSetCborHex: string,
): Promise<{ signedTxCborHex: string; signedTxBase64: string; txHashHex: string }> {
  const CSL = await import('@emurgo/cardano-serialization-lib-browser');

  const tx         = CSL.Transaction.from_bytes(hexToBytes(unsignedTxCborHex));
  const walletWits = CSL.TransactionWitnessSet.from_bytes(hexToBytes(witnessSetCborHex));

  // Merge wallet-supplied vkeys into the (currently empty) witness set on
  // the tx. We keep this defensive in case CIP-30 also returned bootstrap
  // witnesses or native scripts (rare for our flow but legal).
  const merged = CSL.TransactionWitnessSet.new();
  const vkeys = walletWits.vkeys();
  if (vkeys) merged.set_vkeys(vkeys);
  const native = walletWits.native_scripts();
  if (native) merged.set_native_scripts(native);
  const boot = walletWits.bootstraps();
  if (boot) merged.set_bootstraps(boot);

  const auxiliary = tx.auxiliary_data();
  const signed = auxiliary
    ? CSL.Transaction.new(tx.body(), merged, auxiliary)
    : CSL.Transaction.new(tx.body(), merged);
  const signedBytes = signed.to_bytes();
  const txHash = CSL.FixedTransaction.new_from_body_bytes(tx.body().to_bytes()).transaction_hash();

  return {
    signedTxCborHex: bytesToHex(signedBytes),
    signedTxBase64:  bytesToBase64(signedBytes),
    txHashHex:       bytesToHex(txHash.to_bytes()),
  };
}

/**
 * Wrap a base64-CBOR signed tx into the canonical x402 X-PAYMENT header
 * payload. Returns the header value (base64-encoded JSON envelope).
 */
export function buildXPaymentHeader(args: {
  network: string;
  signedTxBase64: string;
}): string {
  const envelope = {
    x402Version: 1,
    scheme:      'exact',
    network:     args.network,
    payload:     { transaction: args.signedTxBase64 },
  };
  // btoa works on binary-string; UTF-8-safe JSON encoding via TextEncoder.
  const utf8 = new TextEncoder().encode(JSON.stringify(envelope));
  return bytesToBase64(utf8);
}
