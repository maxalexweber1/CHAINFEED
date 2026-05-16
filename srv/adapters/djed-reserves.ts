/**
 * DJED Reserve-Ratio adapter — reads Coti's Djed reserve script to expose
 * the on-chain collateral coverage of circulating DJED.
 *
 * What this is, what it isn't:
 *   - **Is**: a naive coverage indicator. Sums ALL ADA at the reserve
 *     script, multiplies by live ADA-USD, divides by circulating DJED.
 *     That gives "if every reserve dollar were available to redeem DJED,
 *     coverage would be X%".
 *   - **Isn't**: Coti's protocol-internal mintable-headroom number. The
 *     real protocol tranches reserves between DJED (senior) and SHEN
 *     (junior equity) — actual mintable headroom requires the SHEN-equity
 *     formula. The naive metric is **always ≥ the protocol metric** —
 *     an upper bound. It's still the right signal for health monitoring:
 *     when this drops below 400% the protocol is constrained, below 200%
 *     it's stressed, below 100% it's depegging.
 *
 * Returns `AttestationQuote { kind: 'attestation', unit: 'ratio_pct' }`
 * so it never enters price-aggregation. Consumers query via the new
 * `attestationFanout()` path or directly through the (yet-to-ship)
 * `getStableHealth(symbol='DJED')` endpoint (Sprint 2 Day 6-7).
 *
 * Reserve-script address verified live 2026-05-03 via Koios:
 *   - 33.13M ADA balance (3 UTxOs)
 *   - holds 99.999% of DjedMicroUSD + ShenMicroUSD total supply (the
 *     unminted inventory — circulating supply = total - this script)
 *   - script_address: true; ~180 txs / 85 days, actively used
 *
 * **2026-05-03 fix:** the previous constant `addr1z84q0denmyep98p...`
 * was MISIDENTIFIED — that address is Minswap V2's `poolCreationAddress`
 * (per `@minswap/sdk` `DexV2Constant.CONFIG[mainnet].poolCreationAddress`).
 * Its 36 M ADA / 3 231 UTxOs are Minswap V2 pool reserves, NOT DJED
 * collateral, so every ratio computed before this fix was the sum of
 * Minswap V2 ADA-paired pool reserves divided by DJED supply — meaningless.
 *
 * The 2023-launch-era address (`addr1z8ru2k4eqtwrf95fvmgxu04pugezz7xg8...`)
 * is **EMPTY today** — also DO NOT use it. Coti redeployed at some point
 * between 2023 and 2026; the agent that verified the current script
 * traced it via the `asset_addresses` top-holder query for the DJED
 * mint policy (it holds 99.999 % of the unminted supply).
 */

import bridge from '../external/odatano-bridge';
import { getJson } from './http';
import { assertIsAdapter, type AttestationQuote, type PriceAdapter } from './types';

const SOURCE_NAME = 'djed-reserves';
const PAIR = 'DJED-RESERVES';

// Mainnet reserve script — current (2026-05-03), verified by Koios live probe.
// 33.13M ADA balance with 3 UTxOs holding 99.999 % of the unminted DJED +
// SHEN inventory. Found by tracing `asset_addresses` for the DJED policy.
// Payment credential: f780e15a96aa9ddeedd419404a9bb14c09a4c8deac716edeba87fe54.
const RESERVE_SCRIPT_ADDRESS =
  'addr1z8mcpc26j64fmhhd6sv5qj5mk9xqnfxgm6k8zmk7h2rlu4qm5kjdmrpmng059yellupyvwgay2v0lz6663swmds7hp0qhxg9gt';

// Single policy for both DJED and SHEN. Asset-name distinguishes them.
const DJED_POLICY = '8db269c3ec630e06ae29f74bc39edd1f87c819f1056206e879a1cd61';
const DJED_ASSETNAMEHEX = '446a65644d6963726f555344';   // "DjedMicroUSD"
const SHEN_ASSETNAMEHEX = '5368656e4d6963726f555344';   // "ShenMicroUSD"
// Concatenated asset ID format used by Minswap's metrics endpoint.
const DJED_ASSET_ID = DJED_POLICY + DJED_ASSETNAMEHEX;

// **Migrated 2026-05-02 from Minswap-supply HTTP → bridge.getAssetInfo**
// when ODATANO 1.7.6 shipped Priority 3 (see `docs/odatano-feedback.md`).
// Native-asset supply now reads from the same backend as our other
// chain-state queries (Blockfrost + Koios via ODATANO's CardanoClient),
// removing the Minswap-availability dependency for the reserves metric.
//
// ADA-USD reference STAYS on Minswap's aggregator endpoint — this is a
// multi-pool weighted price, distinct from any single on-chain feed,
// and not replicable via the bridge alone.
const MINSWAP_ADA_PRICE_URL =
  'https://agg-api.minswap.org/aggregator/ada-price?currency=usd';

// Asset units (policyId + assetNameHex) for bridge.getAssetInfo lookups.
const DJED_ASSET_UNIT = DJED_ASSET_ID;
const SHEN_ASSET_UNIT = `${DJED_POLICY}${SHEN_ASSETNAMEHEX}`;

// Coverage thresholds — Coti's published protocol bands.
// < 400% triggers the "no new DJED mints" guard inside the contract;
// 800% is the comfortable steady-state range.
const COVERAGE_WARN_PCT  = 400;
const COVERAGE_ALERT_PCT = 200;

interface MinswapAdaPriceResp {
  value?: { price?: number | string };
}

const SUPPORTED_PAIRS = new Set([PAIR]);

interface UtxoLite { lovelace: string; assets?: Array<{ policyId?: string; assetNameHex?: string; quantity?: string }> }

async function getPrice(pair: string): Promise<AttestationQuote> {
  if (!SUPPORTED_PAIRS.has(pair)) throw new Error(`djed-reserves: pair '${pair}' not supported`);

  // 1. Sum ADA + DJED + SHEN held at the reserve script.
  const utxos = await bridge.getUtxosAtAddress(RESERVE_SCRIPT_ADDRESS) as UtxoLite[];
  if (!Array.isArray(utxos) || utxos.length === 0) {
    throw new Error(`djed-reserves: no UTxOs at reserve script ${RESERVE_SCRIPT_ADDRESS}`);
  }

  // Sum only ADA from UTxOs that actually carry DJED or SHEN inventory.
  // Otherwise an unrelated UTxO that Coti parks at this script address
  // (vault setup, migration UTxOs, fee accounting) would inflate
  // `totalLovelace` and over-state coverage. Today the reserve script
  // hosts exactly 3 UTxOs, all of which carry inventory, but the filter
  // makes the invariant explicit.
  let totalLovelace = 0n;
  let djedInventory = 0n;
  let shenInventory = 0n;
  let countedUtxoCount = 0;
  for (const u of utxos) {
    let utxoHasInventory = false;
    for (const a of u.assets ?? []) {
      if (a.policyId !== DJED_POLICY) continue;
      if (a.assetNameHex === DJED_ASSETNAMEHEX) {
        djedInventory += BigInt(a.quantity ?? '0');
        utxoHasInventory = true;
      } else if (a.assetNameHex === SHEN_ASSETNAMEHEX) {
        shenInventory += BigInt(a.quantity ?? '0');
        utxoHasInventory = true;
      }
    }
    if (utxoHasInventory) {
      totalLovelace += BigInt(u.lovelace ?? '0');
      countedUtxoCount++;
    }
  }
  if (countedUtxoCount === 0) {
    throw new Error(
      `djed-reserves: no UTxOs at ${RESERVE_SCRIPT_ADDRESS} carry DJED/SHEN inventory — ` +
      `address may have been retired or the script redeployed.`,
    );
  }
  const adaCollateral = Number(totalLovelace) / 1_000_000;

  // 2. Circulating DJED via Minswap analytics. Decimals=6 for DJED — Minswap
  //    reports `circulating_supply` already normalised to whole tokens (USD).
  // Three calls in parallel:
  //   - DJED supply via bridge.getAssetInfo (ODATANO 1.7.6+, multi-backend)
  //   - SHEN supply via bridge.getAssetInfo (best-effort — null on failure)
  //   - ADA-USD via Minswap aggregator (multi-pool weighted; not a single
  //     on-chain feed, hence not replaceable by bridge today)
  //
  // SHEN is the equity-tranche reserve coin; per-SHEN equity is a useful
  // second-order signal (when SHEN trades above its protocol-implied
  // equity-per-share, market is pricing in expected reserve growth;
  // below = bearish DJED-protocol-risk signal).
  const [djedAsset, shenAsset, adaPriceResp] = await Promise.all([
    bridge.getAssetInfo(DJED_ASSET_UNIT),
    bridge.getAssetInfo(SHEN_ASSET_UNIT).catch(() => null),
    getJson<MinswapAdaPriceResp>(MINSWAP_ADA_PRICE_URL),
  ]) as [{ totalSupply?: string; registryDecimals?: number | null } | null,
         { totalSupply?: string; registryDecimals?: number | null } | null,
         MinswapAdaPriceResp];

  // DJED uses a CIP-68-style **pre-mint pattern**: at protocol deployment
  // 1e18 raw units of DjedMicroUSD + ShenMicroUSD are minted in one tx,
  // and circulating = total - what's still locked at the reserve script.
  // So `bridge.getAssetInfo(DJED).totalSupply` returns the always-1e18
  // pre-mint constant, NOT the user-held supply. Subtract the script's
  // own inventory to get the actual circulating amount.
  const djedTotalRaw = djedAsset?.totalSupply;
  if (!djedTotalRaw) {
    throw new Error(`djed-reserves: bridge.getAssetInfo returned no totalSupply for DJED (unit=${DJED_ASSET_UNIT})`);
  }
  const djedCirculatingRaw = BigInt(djedTotalRaw) - djedInventory;
  if (djedCirculatingRaw <= 0n) {
    throw new Error(`djed-reserves: derived circulating supply is non-positive (totalSupply=${djedTotalRaw}, scriptInventory=${djedInventory})`);
  }
  const circulating = Number(djedCirculatingRaw) / 1_000_000;
  if (!Number.isFinite(circulating) || circulating <= 0) {
    throw new Error(`djed-reserves: DJED supply parse failed (totalRaw=${djedTotalRaw}, scriptInventory=${djedInventory})`);
  }

  // SHEN circulating uses the same pre-mint subtraction. Best-effort —
  // if `bridge.getAssetInfo` fails for SHEN (registry gap, backend
  // hiccup), per-SHEN equity surfaces as null and the headline coverage
  // metric stays unaffected.
  const shenCirculating = (() => {
    if (!shenAsset?.totalSupply) return null;
    try {
      const raw = BigInt(shenAsset.totalSupply) - shenInventory;
      if (raw <= 0n) return null;
      const v = Number(raw) / 1_000_000;
      return Number.isFinite(v) && v > 0 ? v : null;
    } catch { return null; }
  })();

  const adaUsdPrice = Number(adaPriceResp?.value?.price);
  if (!Number.isFinite(adaUsdPrice) || adaUsdPrice <= 0) {
    throw new Error(`djed-reserves: invalid ADA-USD reference ${adaPriceResp?.value?.price}`);
  }

  // 4. Naive coverage = (adaCollateral × adaUsd) / (circulating × peg) × 100.
  //    DJED is USD-pegged, so circulating × 1.0 is the ideal-redemption USD.
  const collateralUsd = adaCollateral * adaUsdPrice;
  const circulatingUsd = circulating * 1.0;
  const ratioPct = (collateralUsd / circulatingUsd) * 100;

  // SHEN cushion = the absolute dollar buffer above DJED's redemption ceiling.
  // This is the "equity tranche" backing DJED — when negative, the protocol is
  // mechanically undercollateralized and minting halts. When positive, SHEN
  // holders share this cushion proportionally to their SHEN holdings.
  // Note: this is a REDUNDANT-with-ratioPct view of the same data
  // (cushionUsd = collateralUsd - circulatingUsd; cushionPctOfDjed = ratioPct - 100).
  // Surfacing it explicitly because risk dashboards want absolute dollar
  // figures alongside ratios.
  const cushionUsd = collateralUsd - circulatingUsd;
  const cushionPctOfDjed = (cushionUsd / circulatingUsd) * 100;

  // Per-SHEN equity = cushionUsd ÷ SHEN circulating. Tells you the
  // protocol-implied USD value backing each SHEN token. Compare vs
  // SHEN's market price (DEX) to identify SHEN trading at premium
  // (market expects reserve growth) vs discount (DJED-protocol-risk).
  // null when SHEN supply lookup failed — surfaces as null, never throws.
  const equityPerShenUsd = shenCirculating !== null && shenCirculating > 0
    ? cushionUsd / shenCirculating
    : null;

  // Health bucket — surfaced via rawPayload so consumers can alert.
  const healthBucket: 'healthy' | 'warning' | 'alert' | 'critical' =
    ratioPct >= 800             ? 'healthy'
    : ratioPct >= COVERAGE_WARN_PCT  ? 'warning'
    : ratioPct >= COVERAGE_ALERT_PCT ? 'alert'
    :                                  'critical';

  return {
    kind: 'attestation',
    sourceName: SOURCE_NAME,
    pair,
    value: ratioPct,
    unit: 'ratio_pct',
    timestamp: Date.now(),
    rawPayload: {
      reserveScriptAddress: RESERVE_SCRIPT_ADDRESS,
      utxoCount: utxos.length,
      countedUtxoCount,
      adaCollateral,
      djedReserveInventoryRaw: djedInventory.toString(),
      shenReserveInventoryRaw: shenInventory.toString(),
      djedCirculating: circulating,
      adaUsdReference: adaUsdPrice,
      collateralUsd,
      circulatingUsd,
      cushionUsd,            // Absolute dollar cushion — what's left for SHEN holders if all DJED redeemed
      cushionPctOfDjed,      // Same signal as ratioPct - 100, in % of DJED outstanding
      shenCirculating,       // SHEN circulating supply (whole tokens). null if Minswap lookup failed.
      equityPerShenUsd,      // Protocol-implied per-SHEN USD value. null if shenCirculating unknown.
      cushionNote: 'Negative cushion = protocol-undercollateralized (mint halts). equityPerShenUsd compares vs SHEN market price (DEX) to identify premium/discount.',
      healthBucket,
      thresholds: { warnPct: COVERAGE_WARN_PCT, alertPct: COVERAGE_ALERT_PCT, healthyPct: 800 },
      formula: 'naive: (adaCollateral × adaUsdPrice) / (djedCirculating × 1) × 100',
      caveat: "Upper bound. Coti's mintable-headroom formula tranches reserves between DJED (senior) and SHEN (junior equity); actual mint cap requires SHEN-equity math. This metric is suitable for health monitoring, not for predicting precise mint capacity.",
    },
  };
}

function supportsPair(pair: string): boolean {
  return SUPPORTED_PAIRS.has(pair);
}

const adapter: PriceAdapter = { sourceName: SOURCE_NAME, getPrice, supportsPair };
assertIsAdapter(adapter, 'djed-reserves');

const exported = {
  ...adapter,
  // exposed for tests:
  _RESERVE_SCRIPT_ADDRESS: RESERVE_SCRIPT_ADDRESS,
  _DJED_POLICY: DJED_POLICY,
  _DJED_ASSETNAMEHEX: DJED_ASSETNAMEHEX,
  _SHEN_ASSETNAMEHEX: SHEN_ASSETNAMEHEX,
  _DJED_ASSET_UNIT: DJED_ASSET_UNIT,
  _SHEN_ASSET_UNIT: SHEN_ASSET_UNIT,
  _MINSWAP_ADA_PRICE_URL: MINSWAP_ADA_PRICE_URL,
};

export = exported;
