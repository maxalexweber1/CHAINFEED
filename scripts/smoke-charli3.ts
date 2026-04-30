/**
 * Live smoke test for the Charli3 adapter — verifies on a real chain that
 * our hard-coded asset names (`OracleFeed` for legacy, `C3AS` for ODV) are
 * actually what sits on the documented oracle script addresses. Closes
 * Risiko #6 from docs/research/charli3-feeds.md.
 *
 * For each configured feed on the chosen network this script:
 *   1. Lists ALL UTxOs at the oracle script address (no asset filter).
 *   2. Picks UTxOs whose multi-asset contains the configured policyId,
 *      and dumps every asset name found under that policy. The expected
 *      name (`OracleFeed` xor `C3AS`) is flagged ✓ / ✗.
 *   3. Calls charli3.getPrice(pair) and prints the resolved quote.
 *
 * Prereqs (export into env or source from .env.local):
 *   - BLOCKFROST_API_KEY          (matching the chosen network)
 *   - NETWORK=mainnet|preprod     (drives the ODATANO bridge backend)
 *   - CHARLI3_NETWORK=...         (optional — defaults to NETWORK)
 *
 * Run:
 *   npx tsx scripts/smoke-charli3.ts                     # all feeds on the active network
 *   npx tsx scripts/smoke-charli3.ts ADA-USD             # one pair only
 *   npx tsx scripts/smoke-charli3.ts ADA-USD BTC-ADA     # several
 */

import bridge from '../srv/external/odatano-bridge';
const charli3 = require('../srv/adapters/charli3');

const VARIANT_NAME: Record<string, string> = { legacy: 'OracleFeed', odv: 'C3AS' };
const VARIANT_HEX:  Record<string, string> = charli3._VARIANT_ASSET_NAME_HEX;

interface UtxoLite {
  txHash: string;
  outputIndex: number;
  lovelace: string;
  assets: Array<{ policyId: string; assetNameHex: string; quantity: string }>;
}

function decodeAssetName(hex: string): string {
  try {
    const buf = Buffer.from(hex, 'hex');
    const utf8 = buf.toString('utf8');
    return /^[\x20-\x7e]*$/.test(utf8) ? utf8 : `0x${hex}`;
  } catch {
    return `0x${hex}`;
  }
}

async function inspectFeed(network: string, pair: string): Promise<{ ok: boolean; reason?: string }> {
  const cfg = (charli3._FEED_CONFIG as Record<string, Record<string, {
    address: string; policyId: string; variant: 'legacy' | 'odv'; invert?: boolean;
  }>>)[network]?.[pair];
  if (!cfg) return { ok: false, reason: 'not configured for this network' };

  const expectedName    = VARIANT_NAME[cfg.variant]!;
  const expectedNameHex = VARIANT_HEX[cfg.variant]!;

  console.log('');
  console.log(`── ${pair} (${cfg.variant})`);
  console.log(`   address:  ${cfg.address}`);
  console.log(`   policyId: ${cfg.policyId}`);
  console.log(`   expects:  asset name "${expectedName}" (hex ${expectedNameHex})${cfg.invert ? '   [will be inverted]' : ''}`);

  // 1. Raw UTxO enumeration — no asset filter, so we see exactly what's there.
  let allUtxos: UtxoLite[];
  try {
    allUtxos = await bridge.getUtxosAtAddress(cfg.address) as UtxoLite[];
  } catch (e) {
    console.log(`   FAIL: bridge.getUtxosAtAddress threw: ${(e as Error).message}`);
    return { ok: false, reason: 'bridge error' };
  }
  console.log(`   total UTxOs at address: ${allUtxos.length}`);
  if (allUtxos.length === 0) {
    return { ok: false, reason: 'no UTxOs at address' };
  }

  // 2. Match by policyId — list every asset name found, mark the expected one.
  const matchingUtxos: UtxoLite[] = [];
  const namesUnderPolicy = new Map<string, number>();
  for (const u of allUtxos) {
    let hit = false;
    for (const a of u.assets) {
      if (a.policyId === cfg.policyId) {
        hit = true;
        namesUnderPolicy.set(a.assetNameHex, (namesUnderPolicy.get(a.assetNameHex) ?? 0) + 1);
      }
    }
    if (hit) matchingUtxos.push(u);
  }
  console.log(`   UTxOs carrying policy ${cfg.policyId.slice(0, 12)}…: ${matchingUtxos.length}`);
  if (namesUnderPolicy.size === 0) {
    console.log(`   FAIL: no UTxO at this address carries the configured policy`);
    return { ok: false, reason: 'policyId not found at address' };
  }
  let assetNameOk = false;
  for (const [hex, count] of namesUnderPolicy) {
    const decoded = decodeAssetName(hex);
    const flag = hex === expectedNameHex ? '✓' : ' ';
    if (hex === expectedNameHex) assetNameOk = true;
    console.log(`     ${flag} "${decoded}"  (hex ${hex})  ×${count}`);
  }
  if (!assetNameOk) {
    console.log(`   FAIL: expected asset name "${expectedName}" not present under policy`);
    return { ok: false, reason: 'asset name mismatch' };
  }

  // 3. End-to-end adapter call — exercises decode + winner selection + invert.
  let quote: Awaited<ReturnType<typeof charli3.getPrice>>;
  try {
    quote = await charli3.getPrice(pair);
  } catch (e) {
    console.log(`   FAIL: charli3.getPrice('${pair}') threw: ${(e as Error).message}`);
    return { ok: false, reason: 'getPrice failed' };
  }
  const raw = quote.rawPayload as {
    rawPrice: string; precision: number; timestamp: number; expiry: number; inverted: boolean;
  };
  const ageMin = (Date.now() - quote.timestamp) / 60000;
  const ttlMin = (raw.expiry - Date.now()) / 60000;
  console.log(`   price:     ${quote.price}${raw.inverted ? `  (inverted from raw ${raw.rawPrice} / 10^${raw.precision})` : ''}`);
  console.log(`   age:       ${ageMin.toFixed(1)} min   (timestamp ${new Date(quote.timestamp).toISOString()})`);
  console.log(`   expires:   ${ttlMin > 0 ? 'in ' + ttlMin.toFixed(1) + ' min' : (-ttlMin).toFixed(1) + ' min ago'}   isStale=${quote.isStale}`);
  console.log(`   tx:        ${quote.txHash}`);
  return { ok: true };
}

async function main() {
  const argv = process.argv.slice(2);
  const network = process.env.CHARLI3_NETWORK || process.env.NETWORK || 'preprod';

  if (!process.env.BLOCKFROST_API_KEY) {
    console.error('FAIL: BLOCKFROST_API_KEY not set. Source .env.local first.');
    process.exit(2);
  }
  if (network !== 'mainnet' && network !== 'preprod') {
    console.error(`FAIL: Charli3 only deploys on mainnet + preprod (got '${network}')`);
    process.exit(2);
  }

  console.log(`Charli3 live smoke — network=${network}`);
  console.log(`(Ensure NETWORK env matches the bridge's configured backend, otherwise lookups will hit the wrong chain silently.)`);

  const allPairs = Object.keys(
    (charli3._FEED_CONFIG as Record<string, Record<string, unknown>>)[network] ?? {},
  );
  if (allPairs.length === 0) {
    console.error(`FAIL: no feeds configured for network '${network}'`);
    process.exit(2);
  }
  const pairs = argv.length > 0 ? argv : allPairs;

  let passed = 0, failed = 0;
  const failures: Array<{ pair: string; reason: string }> = [];
  for (const pair of pairs) {
    const r = await inspectFeed(network, pair);
    if (r.ok) passed++;
    else { failed++; failures.push({ pair, reason: r.reason ?? 'unknown' }); }
  }

  console.log('');
  console.log('───────────────────────────────────────────');
  console.log(`${passed}/${pairs.length} feeds verified live`);
  if (failures.length > 0) {
    console.log('Failures:');
    for (const f of failures) console.log(`  - ${f.pair}: ${f.reason}`);
  }
  await bridge.shutdown();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async err => {
  console.error('runner crash:', err?.stack ?? err);
  try { await bridge.shutdown(); } catch { /* ignore */ }
  process.exit(2);
});
