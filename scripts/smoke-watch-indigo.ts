/**
 * ODATANO-WATCH 0.1.4 POC smoke — Indigo CDP credential watching.
 *
 * Boots a minimal CAP instance, registers the watch + bus listener, and
 * polls for events on a 60-second cadence (the watcher's default credential
 * polling interval). Every cardano.credential.newTransactions event for
 * the indigo-cdp tag is logged with its UTxO deltas.
 *
 * Manual smoke — leave running for 5-10 minutes during a known active
 * window (mainnet Indigo CDPs see mint/burn activity multiple times per
 * hour). Each tx that touches the credential should produce one log line
 * here AND a "cache invalidated for indigo-cdp" line via the registered
 * subscriber.
 *
 * Run:
 *   npx tsx scripts/smoke-watch-indigo.ts
 */

import cds from '@sap/cds';
import { registerWatchSubscriptions } from '../srv/external/watch-subscriptions';

interface CredEvent {
  paymentCredHex?: string;
  tag?: string;
  count?: number;
  blockHeight?: number;
  utxosCreated?: Array<{ txHash: string; outputIndex: number; lovelace?: string; assets?: Array<unknown>; inlineDatumHex?: string }>;
  utxosSpent?:   Array<{ txHash: string; outputIndex: number }>;
  transactions?: string[];
}

async function main() {
  console.log('ODATANO-WATCH Indigo CDP smoke (mainnet)');
  console.log('────────────────────────────────────────');

  // Boot CAP — needed so the @odatano/watch plugin loads and the
  // CardanoWatcherAdminService becomes reachable via cds.connect.to.
  await cds.connect.to('db');
  // Trigger the plugin's `served` hook by serving the bare service surface.
  // We don't actually need an HTTP listener — just the in-process registration.
  // CAP sets up plugin services on first cds.connect.to that touches them.

  // Attach an additional logger BEFORE registering subscriptions so we
  // can inspect every event payload, not just the tag-based dispatch.
  (cds as unknown as { on(ev: string, handler: (e: CredEvent) => void): void })
    .on('cardano.credential.newTransactions', (e: CredEvent) => {
      console.log('');
      console.log(`▼ cardano.credential.newTransactions  tag=${e.tag ?? '—'}`);
      console.log(`  cred=${e.paymentCredHex}`);
      console.log(`  block=${e.blockHeight ?? '?'}  txCount=${e.count ?? '?'}`);
      console.log(`  utxosCreated=${e.utxosCreated?.length ?? 0}  utxosSpent=${e.utxosSpent?.length ?? 0}`);
      const sample = e.utxosCreated?.[0];
      if (sample) {
        console.log(`  sample created: tx=${sample.txHash.slice(0, 14)}…#${sample.outputIndex} lovelace=${sample.lovelace} assets=${sample.assets?.length ?? 0} datum=${sample.inlineDatumHex ? sample.inlineDatumHex.length + 'h' : '∅'}`);
      }
      if (e.transactions && e.transactions.length > 0) {
        console.log(`  txs: ${e.transactions.slice(0, 3).join(', ')}${e.transactions.length > 3 ? '…' : ''}`);
      }
    });

  await registerWatchSubscriptions();
  console.log('Subscribed. Listening for events… (Ctrl+C to exit)');

  // Keep the process alive. The watcher polls in the background.
  await new Promise<void>(() => { /* never resolves */ });
}

main().catch(err => {
  console.error('runner crash:', err?.stack ?? err);
  process.exit(2);
});
