/**
 * Stable-metadata registry sanity tests.
 *
 * Pure-TS — no I/O. Verifies the static registry's structural invariants
 * (policyId length, asset-name hex, decimals=6 for current Cardano stables,
 * pegPair shape, etc.) so registry edits can't introduce silent shape
 * regressions.
 *
 * Run: npx tsx scripts/test-stable-metadata.ts
 */

import assert from 'node:assert/strict';
import {
  STABLE_METADATA, allStableSymbols, metadataForPair, metadataForSymbol,
} from '../srv/lib/stable-metadata';

let n = 0, fails = 0;
function t(name: string, fn: () => void) {
  n++;
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) {
    fails++;
    const err = e as Error;
    console.log(`FAIL  ${name}\n      ${err.stack || err.message}`);
  }
}

console.log('stable-metadata ─────────────────────────────────────────');

t('registry has the expected 5 stables', () => {
  const symbols = allStableSymbols().sort();
  assert.deepEqual(symbols, ['DJED', 'USDA', 'USDCx', 'USDM', 'iUSD'].sort());
});

t('every entry has policyId 56-hex (28 bytes)', () => {
  for (const sym of allStableSymbols()) {
    const m = STABLE_METADATA[sym]!;
    assert.equal(m.policyId.length, 56, `${sym}: policyId not 56 hex chars`);
    assert.match(m.policyId, /^[0-9a-f]+$/, `${sym}: policyId not lowercase hex`);
  }
});

t('every entry has assetNameHex (lowercase hex, non-empty, ≤ 32 bytes)', () => {
  for (const sym of allStableSymbols()) {
    const m = STABLE_METADATA[sym]!;
    assert.ok(m.assetNameHex.length > 0, `${sym}: assetNameHex empty`);
    assert.ok(m.assetNameHex.length <= 64, `${sym}: assetNameHex > 32 bytes`);
    assert.match(m.assetNameHex, /^[0-9a-f]+$/, `${sym}: assetNameHex not lowercase hex`);
    assert.equal(m.assetNameHex.length % 2, 0, `${sym}: assetNameHex odd length`);
  }
});

t('every entry has decimals = 6', () => {
  // All current Cardano-native stables (USDM/DJED/iUSD/USDA/USDCx) are
  // 6-decimal. Wanchain-bridged 8-decimal entries (USDT/USDC) were dropped
  // 2026-05-03 with the DexHunter removal — re-introduce the {6,8} band
  // if a future stable ships with 8 decimals.
  for (const sym of allStableSymbols()) {
    const d = STABLE_METADATA[sym]!.decimals;
    assert.equal(d, 6, `${sym}: decimals=${d} is not 6`);
  }
});

t('every entry has pegPair = `ADA-{symbol}`', () => {
  for (const sym of allStableSymbols()) {
    const m = STABLE_METADATA[sym]!;
    assert.equal(m.pegPair, `ADA-${sym}`, `${sym}: pegPair mismatch`);
  }
});

t('peg values are within the supported set', () => {
  const supportedPegs = new Set(['USD', 'EUR', 'XAU']);
  for (const sym of allStableSymbols()) {
    assert.ok(supportedPegs.has(STABLE_METADATA[sym]!.peg), `${sym}: peg not in supported set`);
  }
});

t('backing values are within the supported set', () => {
  const supportedBacking = new Set([
    'fiat-custodial', 'overcollateralized-ada', 'overcollateralized-cdp', 'algorithmic',
  ]);
  for (const sym of allStableSymbols()) {
    assert.ok(supportedBacking.has(STABLE_METADATA[sym]!.backing), `${sym}: backing not in supported set`);
  }
});

t('fiat-custodial entries name a custodian', () => {
  for (const sym of allStableSymbols()) {
    const m = STABLE_METADATA[sym]!;
    if (m.backing === 'fiat-custodial') {
      assert.ok(m.issuer.custodian, `${sym}: fiat-custodial without custodian`);
    }
  }
});

t('liveSince is a parseable ISO date', () => {
  for (const sym of allStableSymbols()) {
    const m = STABLE_METADATA[sym]!;
    const d = new Date(m.liveSince);
    assert.ok(!Number.isNaN(d.getTime()), `${sym}: liveSince not parseable`);
  }
});

t('reservesPair coverage by stable type', () => {
  // On-chain collateral aggregate
  assert.equal(STABLE_METADATA.DJED!.reservesPair, 'DJED-RESERVES');
  assert.equal(STABLE_METADATA.iUSD!.reservesPair, 'iUSD-COLLATERAL');
  // Off-chain Circle attestation (Sprint 2 Day 9)
  assert.equal(STABLE_METADATA.USDCx!.reservesPair, 'USDCx-ATTESTATION');
  // USDM: its on-chain attestation was the Charli3 ODV `USDM-RESERVES` feed,
  // removed when Charli3 shut down (2026-06). No replacement source today, so
  // it now joins USDA under `reserves-unsubstantiated`.
  assert.equal(STABLE_METADATA.USDM!.reservesPair, undefined);
  // USDA: Anzens / BitGo publish no fetchable attestation today —
  // `reserves-unsubstantiated` alert flags the gap to consumers.
  assert.equal(STABLE_METADATA.USDA!.reservesPair, undefined);
});

t('metadataForPair("ADA-USDM") returns USDM metadata', () => {
  const m = metadataForPair('ADA-USDM');
  assert.ok(m, 'expected metadata for ADA-USDM');
  assert.equal(m!.symbol, 'USDM');
  assert.equal(m!.peg, 'USD');
});

t('metadataForPair("ADA-DJED") returns DJED metadata', () => {
  assert.equal(metadataForPair('ADA-DJED')!.symbol, 'DJED');
});

t('metadataForPair("ADA-iUSD") returns iUSD metadata (case preserved)', () => {
  assert.equal(metadataForPair('ADA-iUSD')!.symbol, 'iUSD');
});

t('metadataForPair returns undefined for non-stable pairs', () => {
  assert.equal(metadataForPair('ADA-USD'),    undefined);   // peg reference, not a stable
  assert.equal(metadataForPair('BTC-ADA'),    undefined);
  assert.equal(metadataForPair('NIGHT-ADA'),  undefined);
  assert.equal(metadataForPair('FOO-BAR'),    undefined);
  assert.equal(metadataForPair('USDM-RESERVES'), undefined);  // attestation, not a price pair
});

t('metadataForPair handles malformed pair strings gracefully', () => {
  assert.equal(metadataForPair(''),        undefined);
  assert.equal(metadataForPair('ADA'),     undefined);
  assert.equal(metadataForPair('ADA-'),    undefined);
});

t('metadataForSymbol direct lookup works', () => {
  assert.equal(metadataForSymbol('USDM')!.symbol, 'USDM');
  assert.equal(metadataForSymbol('NOPE'), undefined);
});

t('STABLE_METADATA is frozen — defensive against runtime mutation', () => {
  assert.ok(Object.isFrozen(STABLE_METADATA), 'STABLE_METADATA should be frozen');
});

console.log(`\n${n - fails}/${n} passed`);
process.exit(fails ? 1 : 0);
