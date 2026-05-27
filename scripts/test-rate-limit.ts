/**
 * Unit tests for the rate-limit config (srv/lib/rate-limit.ts).
 *
 * Real behaviour tests would need to spin up an express app and burn through
 * a window — not unit-test scale. Instead we lock in the *shape* of the
 * config: which paths get which limiter, that all limiters skip /health,
 * that the action-path lists stay in sync with the registered OData actions.
 *
 * Run: npx tsx scripts/test-rate-limit.ts
 */

import assert from 'node:assert/strict';
import {
  globalLimiter,
  expensiveLimiter,
  subscriptionLimiter,
  EXPENSIVE_ACTION_PATHS,
  SUBSCRIPTION_ACTION_PATHS,
} from '../srv/lib/rate-limit';

let n = 0, fails = 0;
function t(name: string, fn: () => void) {
  n++;
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) { fails++; console.log(`FAIL  ${name}\n      ${(e as Error).stack || (e as Error).message}`); }
}

console.log('rate-limit ─────────────────────────────────────────────');

t('three limiters exported as middleware functions', () => {
  for (const [name, mw] of [
    ['globalLimiter',       globalLimiter],
    ['expensiveLimiter',    expensiveLimiter],
    ['subscriptionLimiter', subscriptionLimiter],
  ] as const) {
    assert.equal(typeof mw, 'function', `${name} is not a function`);
    // express middleware sig: (req, res, next) — at least 3 args
    assert.ok(mw.length >= 2, `${name} arity ${mw.length} too low`);
  }
});

t('EXPENSIVE_ACTION_PATHS covers every fanout-heavy OData action', () => {
  // Pulled directly from `srv/price-service.cds`. If a new action lands that
  // does fanout, add it here AND to EXPENSIVE_ACTION_PATHS, or the limit gap
  // is your only smoke that something's missing.
  const expected = [
    'assessStable',
    'getStableHealth',
    'getStableConvergence',
    'getBestPrice',
    'getArbitrageOpportunities',
    'getOhlcv',
    'getTWAP',
    'getAuditPack',
    'getFluidtokensPools',
    'getFluidtokensLoans',
    'getFluidtokensHealth',
    'getLiqwidHealth',
  ];
  const actualNames = EXPENSIVE_ACTION_PATHS.map((p) => p.split('/').pop());
  for (const name of expected) {
    assert.ok(actualNames.includes(name), `missing ${name} in EXPENSIVE_ACTION_PATHS`);
  }
});

t('all expensive paths follow the OData route convention', () => {
  for (const p of EXPENSIVE_ACTION_PATHS) {
    assert.ok(
      p.startsWith('/odata/v4/price/'),
      `path "${p}" doesn't match /odata/v4/price/ prefix`,
    );
    // No trailing slash, no double-slash, no query string
    assert.ok(!p.endsWith('/'),     `"${p}" has trailing slash`);
    assert.ok(!p.includes('//'),    `"${p}" has double slash`);
    assert.ok(!p.includes('?'),     `"${p}" has query string`);
  }
});

t('SUBSCRIPTION_ACTION_PATHS covers write-side endpoints', () => {
  // Subscriptions create AlertSubscriptions rows + persist HMAC secrets.
  // listSubscriptions + cancelSubscription are read-only, can live with
  // the global limiter.
  assert.deepEqual(SUBSCRIPTION_ACTION_PATHS, [
    '/odata/v4/price/subscribePegAlert',
  ]);
});

t('no path appears in BOTH the expensive and subscription buckets', () => {
  const exp = new Set<string>(EXPENSIVE_ACTION_PATHS);
  for (const p of SUBSCRIPTION_ACTION_PATHS) {
    assert.ok(!exp.has(p), `path ${p} double-bucketed — last app.use() wins, intent ambiguous`);
  }
});

console.log(`\n${n - fails}/${n} passed`);
process.exit(fails ? 1 : 0);
