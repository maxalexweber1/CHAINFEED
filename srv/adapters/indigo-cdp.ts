/**
 * Indigo Protocol iUSD CDP-aggregator.
 *
 * Reads every CDP UTxO at Indigo's CDP-manager script (mainnet), decodes
 * each datum to extract the iAsset name + debt amount, sums collateral
 * (lovelace value of the UTxO) for iUSD-tagged CDPs, and computes the
 * system-wide collateral-ratio in USD terms.
 *
 * Data source: **Koios `credential_utxos` (extended)** — public, no API
 * key, returns all UTxOs + inline_datum bytes in a single call. We
 * deliberately don't iterate the ODATANO bridge here because the bridge's
 * `getUtxosAtAddress` doesn't populate `inlineDatumHex` (the Blockfrost
 * lite shape), and 493 sequential per-tx fetches would take 30+ seconds.
 * One Koios call returns the full set in ~2s.
 *
 * **TEMPORARY WORKAROUND — migrate to ODATANO bridge once it ships:**
 *   - Priority 1 (inline-datum hydration on `getUtxosAtAddress`)
 *   - Priority 2 (`getUtxosAtCredential(credHash)` for stake-cred-agnostic
 *     queries — Indigo's CDP-manager has two bech32 forms sharing the
 *     same payment cred)
 * See `docs/odatano-feedback.md` for the proposal. Once both land, this
 * adapter switches to: `bridge.getUtxosAtCredential(CDP_PAYMENT_CRED, { withInlineDatums: true })`
 * — same data, no off-bridge HTTP, full backend-failover support.
 *
 * Output: AttestationQuote { kind:'attestation', unit:'ratio_pct' }.
 *
 * Datum schema (verified empirically across 493 live CDPs, 2026-05-02):
 *   Outer Constr 0:                          ; CDPDatum (skip Constr 1 = IAssetDatum registry)
 *     Field 0: Constr 0:                     ; CDP record
 *       Field 0: owner = Constr 0 [Bytes 28] ; PaymentPubKeyHash newtype, "Just" wrap.
 *                                            ; Constr 1 [] = Nothing (frozen).
 *       Field 1: Bytes                       ; iAsset name (ASCII: "iUSD","iBTC","iETH","iSOL")
 *       Field 2: Int                         ; minted amount (raw, /1e6 for whole units)
 *       Field 3: Constr 0 [...]              ; v2 interest snapshot — ignored for debt
 *
 * Sources:
 *   - https://docs.indigoprotocol.io/readme/collateral-debt-position-cdp
 *   - https://github.com/IndigoProtocol/indigo-smart-contracts (BUSL, v1)
 *   - https://github.com/IndigoProtocol/indigo-upgrade-details-v2 (UPLC, v2)
 *
 * **Migrated 2026-05-02 from direct Koios HTTP → ODATANO bridge** when
 * `@odatano/core` 1.7.6 shipped `getCredentialUtxos` (P2 from our
 * feedback doc, see `docs/odatano-feedback.md`). The bridge call
 * captures both bech32 forms of the CDP-manager script in one
 * round-trip, with `inlineDatumHex` auto-populated. No more direct-HTTP
 * dependency — full backend-failover support, request-coalescing, and
 * rate-limit awareness flow through ODATANO's CardanoClient.
 */

import * as CSL from '@emurgo/cardano-serialization-lib-nodejs';
import bridge from '../external/odatano-bridge';
import { getJson } from './http';
import { assertIsAdapter, type AttestationQuote, type PriceAdapter } from './types';

const SOURCE_NAME = 'indigo-cdp';
const PAIR_IUSD   = 'iUSD-COLLATERAL';
const PAIR_IBTC   = 'iBTC-COLLATERAL';
const PAIR_IETH   = 'iETH-COLLATERAL';
const PAIR_ISOL   = 'iSOL-COLLATERAL';

// Indigo's CDP-manager payment credential (mainnet). Both bech32 variants
// (with and without stake credential) share this payment cred — querying by
// credential captures all CDP UTxOs in either form.
const CDP_PAYMENT_CRED = '0805d8541db33f4841585fed4c3a7e87e2ff7018243038f06ceb660c';
const CDP_MANAGER_ADDR_BECH32 =
  'addr1zyyqtkz5rken7jzptp076np606r79lmsrqjrqw8sdn4kvrq8723r7g3ag32crvt9f7kj7x8qakk73t3xwnat623xhfsqv9hw5u';

// Per-pair config: pair → iAsset name bytes inside the CDP datum (ASCII).
// iUSD is USD-pegged; iBTC/iETH/iSOL track external crypto prices and are
// NOT stables — exposing them here gives consumers visibility into the
// full Indigo synthetics system collateralization, useful for cross-stable
// risk dashboards. Risk-score interpretation differs per iAsset:
//   - iUSD: peg = $1; ratio = (collateralUsd / debtUsd) directly
//   - iBTC/iETH/iSOL: ratio is ADA-collateral against synthetic debt that
//     itself fluctuates with the underlying. Consumers compute their own
//     "ratio" using a fresh BTC/ETH/SOL price reference; we expose raw debt.
interface PairCfg { iAssetNameHex: string; isUsdPegged: boolean }
const PAIR_CONFIG: Readonly<Record<string, PairCfg>> = Object.freeze({
  [PAIR_IUSD]: { iAssetNameHex: '69555344', isUsdPegged: true  }, // ASCII "iUSD"
  [PAIR_IBTC]: { iAssetNameHex: '69425443', isUsdPegged: false }, // ASCII "iBTC"
  [PAIR_IETH]: { iAssetNameHex: '69455448', isUsdPegged: false }, // ASCII "iETH"
  [PAIR_ISOL]: { iAssetNameHex: '69534f4c', isUsdPegged: false }, // ASCII "iSOL"
});

// Legacy alias retained for backwards-compat — equals PAIR_CONFIG[PAIR_IUSD].iAssetNameHex.
const IUSD_ASSET_NAME_HEX = '69555344';

// ADA-USD reference — same source as DJED-reserves, keeps cross-stable
// reserve metrics consistent with the user-facing ADA-USD price.
const MINSWAP_ADA_PRICE_URL = 'https://agg-api.minswap.org/aggregator/ada-price?currency=usd';

// System-wide health buckets. Per-CDP minimum is 110-150% (Indigo enforces),
// so aggregate well above that range is the steady state. Below 200% means
// many CDPs are near liquidation or ADA depreciated against USD.
const HEALTH_HEALTHY_PCT  = 300;
const HEALTH_WARNING_PCT  = 200;
const HEALTH_ALERT_PCT    = 150;

const SUPPORTED_PAIRS = new Set([PAIR_IUSD, PAIR_IBTC, PAIR_IETH, PAIR_ISOL]);

/**
 * Bridge UTxO shape — kept loose-typed since `bridge.getUtxosAtCredential`
 * is monkey-patched in tests with synthetic objects.
 */
interface BridgeUtxo {
  txHash?: string;
  outputIndex?: number;
  lovelace?: string;
  inlineDatumHex?: string;
}

interface MinswapAdaPriceResp { value?: { price?: number | string } }

interface DecodedCdp {
  iAssetHex: string;
  /** raw integer debt (divide by 10^6 for whole iAsset) */
  debt: bigint;
  /** 28-byte hex pkh, or null for frozen CDPs (Maybe = Nothing) */
  ownerPkh: string | null;
}

/**
 * Decode an Indigo CDP datum. Returns null for IAssetDatum entries
 * (Constr 1 — protocol registry rows that share the script address) and
 * for any datum that doesn't match the expected nested-Constr-0 shape.
 *
 * Tolerates BOTH v1 (3 fields) and v2 (4 fields with interest snapshot).
 */
function decodeIndigoCdpDatum(datumHex: string): DecodedCdp | null {
  let root: CSL.PlutusData;
  try { root = CSL.PlutusData.from_hex(datumHex); }
  catch { return null; }

  const outer = root.as_constr_plutus_data();
  if (!outer) return null;
  // Constr 0 = CDPDatum. Constr 1 = IAssetDatum (registry, skip).
  if (outer.alternative().to_str() !== '0') return null;

  const outerFields = outer.data();
  if (outerFields.len() < 1) return null;

  // Outer wraps a single field that is itself the CDP-record Constr 0.
  // (Indigo's `makeIsDataIndexed [('CDP, 0)]` produces this nested shape.)
  const cdpRecord = outerFields.get(0).as_constr_plutus_data();
  if (!cdpRecord) return null;
  if (cdpRecord.alternative().to_str() !== '0') return null;

  const f = cdpRecord.data();
  // Need at least owner + iAsset + debt; v2 adds interest snapshot at idx 3.
  if (f.len() < 3) return null;

  // Field 0: owner = Maybe PaymentPubKeyHash. Constr 0 [Bytes 28] = Just pkh,
  // Constr 1 [] = Nothing (frozen CDP — collateral/debt still count).
  let ownerPkh: string | null = null;
  const ownerConstr = f.get(0).as_constr_plutus_data();
  if (ownerConstr && ownerConstr.alternative().to_str() === '0') {
    const ownerFields = ownerConstr.data();
    if (ownerFields.len() >= 1) {
      const pkhBytes = ownerFields.get(0).as_bytes();
      if (pkhBytes && pkhBytes.length === 28) {
        ownerPkh = Buffer.from(pkhBytes).toString('hex');
      }
    }
  }

  // Field 1: iAsset TokenName (raw bytes). ASCII "iUSD" = 0x69555344.
  const iAssetBytes = f.get(1).as_bytes();
  if (!iAssetBytes) return null;
  const iAssetHex = Buffer.from(iAssetBytes).toString('hex');

  // Field 2: minted amount (debt) — raw integer, decimals=6 for iUSD.
  const debtInt = f.get(2).as_integer();
  if (!debtInt) return null;
  const debt = BigInt(debtInt.to_str());
  if (debt < 0n) return null;

  return { iAssetHex, debt, ownerPkh };
}

interface PerIAssetTotals {
  count: number;
  collateralLovelace: bigint;
  debt: bigint;
}

async function getPrice(pair: string): Promise<AttestationQuote> {
  if (!SUPPORTED_PAIRS.has(pair)) throw new Error(`indigo-cdp: pair '${pair}' not supported`);

  // 1. Pull every CDP UTxO via the bridge (Koios-backed). One round-trip
  //    captures both bech32 forms of the CDP manager. Inline datum hex
  //    is auto-populated by ODATANO 1.7.6 — no per-tx fetch needed.
  const utxos = await bridge.getUtxosAtCredential(CDP_PAYMENT_CRED) as BridgeUtxo[];
  if (!Array.isArray(utxos) || utxos.length === 0) {
    throw new Error('indigo-cdp: bridge.getUtxosAtCredential returned no UTxOs at CDP manager');
  }

  // 2. Decode + aggregate. One pass — bucket by iAsset for per-asset breakdown.
  //    Note: spent UTxOs are NOT returned by the bridge call (Koios filters
  //    them at the API level), so we don't need an is_spent guard like the
  //    pre-1.7.6 direct-Koios path used.
  let unspentTotal = 0;
  let skippedNoDatum = 0;
  let skippedNonCdp = 0;
  const perAsset = new Map<string, PerIAssetTotals>();

  for (const u of utxos) {
    unspentTotal++;
    const datumHex = u.inlineDatumHex;
    if (!datumHex) { skippedNoDatum++; continue; }
    const dec = decodeIndigoCdpDatum(datumHex);
    if (!dec) { skippedNonCdp++; continue; }

    const lovelace = BigInt(u.lovelace ?? '0');
    let bucket = perAsset.get(dec.iAssetHex);
    if (!bucket) {
      bucket = { count: 0, collateralLovelace: 0n, debt: 0n };
      perAsset.set(dec.iAssetHex, bucket);
    }
    bucket.count++;
    bucket.collateralLovelace += lovelace;
    bucket.debt += dec.debt;
  }

  const cfg = PAIR_CONFIG[pair]!;
  const target = perAsset.get(cfg.iAssetNameHex);
  if (!target || target.count === 0) {
    throw new Error(`indigo-cdp: no ${pair.split('-')[0]} CDPs decoded from Koios response`);
  }

  const iAssetSymbol = Buffer.from(cfg.iAssetNameHex, 'hex').toString('utf8'); // e.g. "iUSD"
  const collateralAda = Number(target.collateralLovelace) / 1_000_000;
  const debtRaw       = target.debt;
  const debtUnits     = Number(debtRaw) / 1_000_000;   // iAssets are 6-decimal across the board
  if (debtUnits <= 0) {
    throw new Error(`indigo-cdp: ${iAssetSymbol} debt aggregate is non-positive (${debtUnits})`);
  }

  // 3. Live ADA-USD reference.
  const adaResp = await getJson<MinswapAdaPriceResp>(MINSWAP_ADA_PRICE_URL);
  const adaUsdPrice = Number(adaResp?.value?.price);
  if (!Number.isFinite(adaUsdPrice) || adaUsdPrice <= 0) {
    throw new Error(`indigo-cdp: invalid ADA-USD reference ${adaResp?.value?.price}`);
  }

  // 4. Compute headline value + unit per pair semantics.
  //    iUSD:  ratio_pct = (collateralUsd / debtUsd) × 100, USD-comparable
  //    iBTC/iETH/iSOL: synthetic_debt — can't compute a clean ratio here
  //      because we'd need a fresh BTC/ETH/SOL price oracle (out of scope
  //      for this adapter — the price service composes that separately).
  //      Expose total debt in synthetic units so consumers can derive their
  //      own collateralization with an external price reference.
  const collateralUsd = collateralAda * adaUsdPrice;
  let value: number;
  let unit: 'ratio_pct' | 'synthetic_debt';
  if (cfg.isUsdPegged) {
    const debtUsd = debtUnits * 1.0;
    value = (collateralUsd / debtUsd) * 100;
    unit  = 'ratio_pct';
  } else {
    value = debtUnits;       // total debt in synthetic units (e.g. 9.027 iBTC)
    unit  = 'synthetic_debt';
  }

  // Health-bucket only meaningful for USD-pegged iUSD (the value IS a ratio).
  // For iBTC/iETH/iSOL the consumer needs an external price ref to compute
  // their own bucket, so we return null here.
  const healthBucket: 'healthy' | 'warning' | 'alert' | 'critical' | null =
    !cfg.isUsdPegged                     ? null
    : value >= HEALTH_HEALTHY_PCT        ? 'healthy'
    : value >= HEALTH_WARNING_PCT        ? 'warning'
    : value >= HEALTH_ALERT_PCT          ? 'alert'
    :                                      'critical';

  // Per-iAsset breakdown — the same Koios pull already gave us iBTC/iETH/iSOL
  // totals; we expose them in rawPayload so a future iBTC-COLLATERAL etc. pair
  // (out of scope today, but trivial) can read the same source.
  const perAssetSummary: Record<string, { count: number; collateralAda: number; debtRaw: string }> = {};
  for (const [hex, v] of perAsset.entries()) {
    let label = hex;
    try { label = Buffer.from(hex, 'hex').toString('utf8'); } catch { /* keep hex */ }
    perAssetSummary[label] = {
      count: v.count,
      collateralAda: Number(v.collateralLovelace) / 1_000_000,
      debtRaw: v.debt.toString(),
    };
  }

  return {
    kind: 'attestation',
    sourceName: SOURCE_NAME,
    pair,
    value,
    unit,
    timestamp: Date.now(),
    rawPayload: {
      cdpManagerAddress: CDP_MANAGER_ADDR_BECH32,
      paymentCred:       CDP_PAYMENT_CRED,
      iAsset:            iAssetSymbol,
      isUsdPegged:       cfg.isUsdPegged,
      cdpCount:          target.count,
      collateralAda,
      debtUnits,            // raw synthetic-asset units (e.g. 9.027 iBTC)
      adaUsdReference:   adaUsdPrice,
      collateralUsd,
      healthBucket,
      thresholds: cfg.isUsdPegged
        ? { healthyPct: HEALTH_HEALTHY_PCT, warningPct: HEALTH_WARNING_PCT, alertPct: HEALTH_ALERT_PCT }
        : null,
      perAssetSummary,
      utxoStats: { totalUnspent: unspentTotal, skippedNoDatum, skippedNonCdp, decodedCdps: Array.from(perAsset.values()).reduce((s, v) => s + v.count, 0) },
      formula: cfg.isUsdPegged
        ? '(collateralAda × adaUsdPrice) / (debtUnits × $1) × 100'
        : 'value = debtUnits (synthetic). For ratio compute (collateralUsd / (debtUnits × <iAsset>-USD-spot)) externally.',
      caveat: cfg.isUsdPegged
        ? 'System-wide aggregate. Per-CDP minimum is 110-150%; healthy users sit far above.'
        : 'Synthetic-asset CDPs. Adapter does NOT compute collateralization ratio here (would need fresh BTC/ETH/SOL price oracle, out of scope). Consumers fetch the underlying price separately.',
    },
  };
}

function supportsPair(pair: string): boolean {
  return SUPPORTED_PAIRS.has(pair);
}

const adapter: PriceAdapter = { sourceName: SOURCE_NAME, getPrice, supportsPair };
assertIsAdapter(adapter, 'indigo-cdp');

const exported = {
  ...adapter,
  // exposed for tests:
  _decodeIndigoCdpDatum: decodeIndigoCdpDatum,
  _CDP_PAYMENT_CRED: CDP_PAYMENT_CRED,
  _CDP_MANAGER_ADDR_BECH32: CDP_MANAGER_ADDR_BECH32,
  _MINSWAP_ADA_PRICE_URL: MINSWAP_ADA_PRICE_URL,
  _IUSD_ASSET_NAME_HEX: IUSD_ASSET_NAME_HEX,
};

export = exported;
