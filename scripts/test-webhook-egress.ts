/**
 * Unit tests for the DNS-rebind egress guard (srv/lib/webhook-egress.ts).
 *
 * Uses an injected resolver so no real DNS is hit. Verifies that a public
 * resolution passes, a private resolution / private literal / DNS failure all
 * fail closed, and that the check no-ops when not enforced.
 *
 * Run: npx tsx scripts/test-webhook-egress.ts
 */

import assert from 'node:assert/strict';
import type { LookupAddress } from 'node:dns';
import { assertPublicEgress } from '../srv/lib/webhook-egress';

let n = 0, fails = 0;
async function t(name: string, fn: () => Promise<void>) {
  n++;
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (e) { fails++; console.log(`FAIL  ${name}\n      ${(e as Error).stack || (e as Error).message}`); }
}

const resolveTo = (...addrs: string[]) =>
  async (): Promise<LookupAddress[]> => addrs.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

async function main() {
  console.log('webhook-egress ─────────────────────────────────────────');

  await t('public resolution passes when enforced', async () => {
    const r = await assertPublicEgress('example.com', { enforce: true, lookupImpl: resolveTo('93.184.216.34') });
    assert.deepEqual(r, { ok: true });
  });

  await t('private resolution (10.x) is blocked — the rebind case', async () => {
    const r = await assertPublicEgress('evil.example.com', { enforce: true, lookupImpl: resolveTo('10.0.0.5') });
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /private address 10\.0\.0\.5/);
  });

  await t('mixed records blocked if ANY is private', async () => {
    const r = await assertPublicEgress('mix.example.com', { enforce: true, lookupImpl: resolveTo('8.8.8.8', '192.168.1.9') });
    assert.equal(r.ok, false);
  });

  await t('IPv6 loopback (::1) is blocked', async () => {
    const r = await assertPublicEgress('v6.example.com', { enforce: true, lookupImpl: resolveTo('::1') });
    assert.equal(r.ok, false);
  });

  await t('literal private host is blocked before DNS', async () => {
    let called = false;
    const r = await assertPublicEgress('169.254.169.254', {
      enforce: true,
      lookupImpl: async () => { called = true; return []; },
    });
    assert.equal(r.ok, false);
    assert.equal(called, false, 'should short-circuit before DNS for a private literal');
  });

  await t('DNS failure fails closed', async () => {
    const r = await assertPublicEgress('broken.example.com', {
      enforce: true,
      lookupImpl: async () => { throw new Error('ENOTFOUND'); },
    });
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /DNS lookup failed/);
  });

  await t('empty DNS result fails closed', async () => {
    const r = await assertPublicEgress('empty.example.com', { enforce: true, lookupImpl: resolveTo() });
    assert.equal(r.ok, false);
  });

  await t('not enforced → no-op pass (does not even resolve)', async () => {
    let called = false;
    const r = await assertPublicEgress('10.0.0.1', {
      enforce: false,
      lookupImpl: async () => { called = true; return []; },
    });
    assert.deepEqual(r, { ok: true });
    assert.equal(called, false);
  });

  console.log(`\n${n - fails}/${n} passed`);
  process.exit(fails ? 1 : 0);
}

void main();
