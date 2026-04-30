/**
 * Smoke test for the ODATANO bridge.
 *
 * Prereqs (in .env.local, sourced into env):
 *   - BLOCKFROST_API_KEY  (preprod or mainnet, matching cds.requires.odatano-core.network)
 *   - X402_PAY_TO         (optional — overridden by argv)
 *
 * Run:
 *   node scripts/smoke-odatano.js [bech32-address]
 */

const FIXTURE_PREVIEW_ADDR =
  'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8';

async function main() {
  const addr = process.argv[2] ?? process.env.X402_PAY_TO ?? FIXTURE_PREVIEW_ADDR;

  if (!process.env.BLOCKFROST_API_KEY) {
    console.error('FAIL: BLOCKFROST_API_KEY not set. Source .env.local first.');
    process.exit(2);
  }

  console.log(`Smoke-testing ODATANO bridge against ${addr}`);
  console.log(`Network: ${process.env.NETWORK ?? '(reading from cds.requires.odatano-core.network)'}`);

  const bridge = require('../srv/external/odatano-bridge');

  const utxos = await bridge.getUtxosAtAddress(addr);
  console.log(`OK: got ${utxos.length} UTxO(s)`);

  if (utxos.length > 0) {
    const total = utxos.reduce((s: bigint, u: { lovelace?: string }) => s + BigInt(u.lovelace || '0'), 0n);
    console.log(`  total: ${total.toString()} lovelace (${Number(total) / 1_000_000} ADA)`);
    for (const u of utxos.slice(0, 3)) {
      const assetSummary = u.assets.length === 0
        ? 'no native assets'
        : `${u.assets.length} asset(s): ${u.assets.slice(0, 2).map((a: { unit: string; quantity: string }) => `${a.unit.slice(0, 16)}…×${a.quantity}`).join(', ')}`;
      console.log(`  ${u.txHash}#${u.outputIndex} — ${u.lovelace} lovelace, ${assetSummary}`);
    }
  }

  await bridge.shutdown();
  process.exit(0);
}

main().catch(async err => {
  console.error('FAIL:', err?.stack ?? err);
  try { await require('../srv/external/odatano-bridge').shutdown(); } catch {}
  process.exit(1);
});
