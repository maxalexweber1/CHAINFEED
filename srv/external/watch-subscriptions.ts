/**
 * ODATANO-WATCH event subscriptions for CHAINFEED chain-state adapters.
 *
 * On CAP `served`, this module:
 *   1. Registers `addWatchedCredential` for each adapter that benefits from
 *      event-driven cache invalidation. Idempotent — re-registering an
 *      existing credential is a no-op on the watcher's side.
 *   2. Subscribes to `cardano.credential.newTransactions` on the CDS bus.
 *      On match, invalidates the corresponding registry-cached adapter so
 *      the next `getPrice()` does a fresh fetch.
 *
 * Failure mode: if the watch package isn't loaded, the subscriptions can't
 * register, and we silently fall back to TTL-based polling. Same for any
 * upstream Koios/Blockfrost outage — events stop, polling stays.
 *
 * **POC scope**: only Indigo CDP today (Phase A of the ODATANO-WATCH 0.1.4
 * migration). Add new credentials to `WATCHED_CREDENTIALS` once the pattern
 * is validated.
 */

import cds from '@sap/cds';
import { invalidateSource } from '../adapters/registry';

const log = cds.log('watch-subs');

interface WatchedCredentialConfig {
  paymentCredHex: string;
  description: string;
  /** Tag echoed back in events — used to dispatch the right cache invalidation. */
  tag: string;
  /** Adapter sourceName to invalidate when an event fires for this credential. */
  invalidateSourceName: string;
  /** Optional milliseconds to coalesce bursts into one event with cumulative deltas. */
  coalesceMs?: number;
  /**
   * Optional asset filter — JSON-stringified array of `{policyId, assetNameHex}`.
   * When present, the watcher only fires events for txs whose outputs touch
   * at least one listed asset. Used to scope noisy script credentials
   * (Minswap V2 sees thousands of swaps/min for tokens we don't track).
   */
  includesAssetsJson?: string;
}

// Stable assets we care about — used to scope the Minswap V2 watch's
// `includesAssetsJson` filter so we only fire on swaps touching the
// indexed Cardano stables. Without this filter the watcher would fan
// out events on every NIGHT/SNEK/IAG/etc swap on Minswap V2 — thousands
// per minute peak.
const STABLE_ASSETS_FILTER = JSON.stringify([
  { policyId: 'c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad', assetNameHex: '0014df105553444d' },         // USDM
  { policyId: 'fe7c786ab321f41c654ef6c1af7b3250a613c24e4213e0425a7ae456', assetNameHex: '55534441' },                  // USDA
  { policyId: '8db269c3ec630e06ae29f74bc39edd1f87c819f1056206e879a1cd61', assetNameHex: '446a65644d6963726f555344' }, // DJED
  { policyId: 'f66d78b4a3cb3d37afa0ec36461e51ecbde00f26c8f0a68f94b69880', assetNameHex: '69555344' },                  // iUSD
  { policyId: '1f3aec8bfe7ea4fe14c5f121e2a92e301afe414147860d557cac7e34', assetNameHex: '5553444378' },                // USDCx
]);

const WATCHED_CREDENTIALS: WatchedCredentialConfig[] = [
  {
    paymentCredHex:       '0805d8541db33f4841585fed4c3a7e87e2ff7018243038f06ceb660c',
    description:          'Indigo Protocol CDP-manager (mainnet)',
    tag:                  'indigo-cdp',
    invalidateSourceName: 'indigo-cdp',
    coalesceMs:           2_000,
  },
  {
    paymentCredHex:       'f780e15a96aa9ddeedd419404a9bb14c09a4c8deac716edeba87fe54',
    description:          'Coti DJED reserve script (mainnet) — 33 M ADA + DJED/SHEN inventory',
    tag:                  'djed-reserves',
    invalidateSourceName: 'djed-reserves',
    coalesceMs:           2_000,
  },
  {
    paymentCredHex:       'ea07b733d932129c378af627436e7cbc2ef0bf96e0036bb51b3bde6b',
    description:          'Minswap V2 pool credential (mainnet) — filtered to indexed Cardano stables only',
    tag:                  'minswap-v2',
    invalidateSourceName: 'minswap-v2',
    coalesceMs:           5_000,                  // pool swaps burst — coalesce a bit longer
    includesAssetsJson:   STABLE_ASSETS_FILTER,
  },
];

interface WatchedAddressConfig {
  address: string;
  description: string;
  tag: string;
  /** Adapter sourceName to invalidate when an event fires for this address. */
  invalidateSourceName: string;
  coalesceMs?: number;
}

// Charli3 + Orcfax both publish to per-feed script addresses (not a
// shared credential). Each entry below maps one feed-address to the
// adapter source-name whose cache should be invalidated when that feed
// updates. Multiple Charli3 entries share the `charli3` tag because
// `invalidateSource('charli3')` clears the cache for ALL pairs in one
// shot — finer per-pair invalidation isn't worth the dispatch-map
// complexity right now (the cache hit rate stays > 95% either way).
const WATCHED_ADDRESSES: WatchedAddressConfig[] = [
  // Charli3 mainnet feeds
  { address: 'addr1wyvxns52tsgz8ggvrh4np5gjyfk0g5fshqq2ytvu9t7pe8qp3adw6', description: 'Charli3 ADA-USD legacy feed', tag: 'charli3', invalidateSourceName: 'charli3' },
  { address: 'addr1w98dq70hqh8we52jgnck535n277ajkz7pg9cpk275lkyt9gjjc97g', description: 'Charli3 ADA-USDM legacy feed', tag: 'charli3', invalidateSourceName: 'charli3' },
  { address: 'addr1wyujem6fwxju9arc45lm98z0uwgwm0t8aerjp5mgahpgx7snfcpuu', description: 'Charli3 BTC-ADA legacy feed', tag: 'charli3', invalidateSourceName: 'charli3' },
  { address: 'addr1w8z46wa8ajgqj5zy90nrjp2hd4ssjtuuunpcuyfpplex4nclv9peu', description: 'Charli3 NIGHT-ADA legacy feed', tag: 'charli3', invalidateSourceName: 'charli3' },
  { address: 'addr1w88fmwyufz9vdqkukzhaerjxcfm488wsnyrft9cpjtd4utsnw5ym7', description: 'Charli3 USDM-RESERVES ODV feed', tag: 'charli3', invalidateSourceName: 'charli3' },
  // Orcfax mainnet FS UTxO script — one address covers every FS publication
  { address: 'addr1wyvnaejjzxanknsw5hm4raq4y6f4tfjsut3hqmmztn035jc4rpcfn', description: 'Orcfax FS UTxO script (mainnet)', tag: 'orcfax', invalidateSourceName: 'orcfax' },
];

/** Minimal subset of CredentialNewTransactionsEvent we read off the bus. */
interface CredEventLike {
  paymentCredHex?: string;
  tag?: string;
  count?: number;
  blockHeight?: number;
}

let registered = false;

/**
 * Register watches + bus listeners. Safe to call multiple times — the
 * `registered` flag guards against double-listener attachment on hot
 * reload. The watcher itself dedupes its own internal state.
 */
export async function registerWatchSubscriptions(): Promise<void> {
  if (registered) return;
  registered = true;

  // The plugin exposes its admin service at `/odata/v4/cardano-watcher-admin`.
  // For LOCAL (in-process) services, `cds.services[<name>]` resolves directly
  // — `cds.connect.to(<name>)` would treat it as a remote service requiring
  // a `cds.requires` config block, which we don't (and shouldn't) ship.
  type AdminSrv = {
    addWatchedCredential: (args: Record<string, unknown>) => Promise<unknown>;
    addWatchedAddress:    (args: Record<string, unknown>) => Promise<unknown>;
    run: (q: unknown) => Promise<unknown>;
  };
  const services = (cds as unknown as { services: Record<string, AdminSrv | undefined> }).services;
  const adminSrv = services?.CardanoWatcherAdminService;
  if (!adminSrv
      || typeof adminSrv.addWatchedCredential !== 'function'
      || typeof adminSrv.addWatchedAddress    !== 'function') {
    log.warn('CardanoWatcherAdminService not found in cds.services — @odatano/watch plugin may not be loaded. Staying on TTL polling.');
    return;
  }

  // 1. Register every credential watch. Each call is best-effort.
  // Since @odatano/watch 0.1.5 the plugin defaults `lastCheckedBlock` to
  // the current Blockfrost tip on insert, so watches start in
  // "forward-only" mode without us needing to pin anything manually.
  // Historical backfill is opt-in via the package's `backfillCredential`.
  for (const cfg of WATCHED_CREDENTIALS) {
    try {
      await adminSrv.addWatchedCredential({
        paymentCredHex:     cfg.paymentCredHex,
        description:        cfg.description,
        tag:                cfg.tag,
        coalesceMs:         cfg.coalesceMs,
        includesAssetsJson: cfg.includesAssetsJson,
      });
      log.info(`watching credential ${cfg.paymentCredHex.slice(0, 12)}… (${cfg.tag}) → invalidates ${cfg.invalidateSourceName}${cfg.includesAssetsJson ? ' [asset-filtered]' : ''}`);
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      // Re-add of an already-registered credential is a soft error in older
      // watcher versions. Log + continue.
      log.warn(`addWatchedCredential(${cfg.tag}) failed: ${msg}`);
    }
  }

  // 2. Register every address watch (Charli3 per-pair feeds, Orcfax FS).
  for (const cfg of WATCHED_ADDRESSES) {
    try {
      await adminSrv.addWatchedAddress({
        address:     cfg.address,
        description: cfg.description,
        tag:         cfg.tag,
        coalesceMs:  cfg.coalesceMs,
      });
      log.info(`watching address ${cfg.address.slice(0, 18)}… (${cfg.tag}) → invalidates ${cfg.invalidateSourceName}`);
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      log.warn(`addWatchedAddress(${cfg.tag}) failed: ${msg}`);
    }
  }

  // 3. Bus listeners — dispatch by tag. Same `tagToSource` map handles
  //    BOTH credential and address events; a tag can come from either
  //    array (we don't share tags across credential-watches and
  //    address-watches today, but the lookup still works either way).
  const tagToSource = new Map<string, string>([
    ...WATCHED_CREDENTIALS.map(c => [c.tag, c.invalidateSourceName] as const),
    ...WATCHED_ADDRESSES  .map(a => [a.tag, a.invalidateSourceName] as const),
  ]);

  // CAP's bus types: `cds.on(eventName, handler)`. The typings don't
  // model arbitrary event names, so we cast. Call `.on` DIRECTLY on
  // cds — extracting it into a local variable loses the `this` context
  // and EventEmitter's internal `this._events` lookup blows up.
  type BusCds = { on: (event: string, handler: (e: unknown) => void) => unknown };
  const busCds = cds as unknown as BusCds;

  busCds.on('cardano.credential.newTransactions', (raw: unknown) => {
    const e = raw as CredEventLike;
    const tag = e.tag;
    if (!tag) return;
    const source = tagToSource.get(tag);
    if (!source) return;

    const ok = invalidateSource(source);
    log.info(
      `event[cred] tag=${tag} cred=${e.paymentCredHex?.slice(0, 12)}… count=${e.count ?? '?'} block=${e.blockHeight ?? '?'} → ${ok ? `invalidated ${source}` : `source ${source} not found`}`,
    );
  });

  busCds.on('cardano.address.newTransactions', (raw: unknown) => {
    const e = raw as CredEventLike & { address?: string };
    const tag = e.tag;
    if (!tag) return;
    const source = tagToSource.get(tag);
    if (!source) return;

    const ok = invalidateSource(source);
    log.info(
      `event[addr] tag=${tag} addr=${e.address?.slice(0, 18)}… count=${e.count ?? '?'} block=${e.blockHeight ?? '?'} → ${ok ? `invalidated ${source}` : `source ${source} not found`}`,
    );
  });

  log.info(`bus listeners attached (${tagToSource.size} tag${tagToSource.size === 1 ? '' : 's'} routed across credential + address events)`);

  // 3. Optional one-shot historical backfill — gated by env var so live
  //    boots stay fast. Useful for end-to-end pipeline validation when
  //    you want to see events immediately rather than wait for fresh
  //    on-chain activity. Set CHAINFEED_WATCH_BACKFILL_BLOCKS=1000
  //    (or however many blocks back you want; 1000 ≈ 5h on mainnet).
  const backfillBlocks = Number(process.env.CHAINFEED_WATCH_BACKFILL_BLOCKS);
  if (Number.isFinite(backfillBlocks) && backfillBlocks > 0) {
    await runBackfillForRegisteredCredentials(adminSrv, backfillBlocks);
  }
}

/**
 * Rewind every registered credential's `lastCheckedBlock` by `nBlocks`
 * and trigger `backfillCredential`. Each historical tx fires through
 * the same bus listener attached above — ensures the consumer pipeline
 * is exercised end-to-end without waiting for fresh on-chain activity.
 *
 * Best-effort: any single credential's backfill failing logs but
 * doesn't abort the rest.
 */
async function runBackfillForRegisteredCredentials(
  adminSrv: { run: (q: unknown) => Promise<unknown> },
  nBlocks: number,
): Promise<void> {
  // Resolve current tip via Koios (free, no auth).
  let currentTip: number | null = null;
  try {
    const tipRes = await fetch('https://api.koios.rest/api/v1/tip');
    if (tipRes.ok) {
      const tipBody = (await tipRes.json()) as Array<{ block_no?: number }>;
      const tip = Array.isArray(tipBody) && tipBody[0]?.block_no;
      if (typeof tip === 'number' && tip > 0) currentTip = tip;
    }
  } catch (err) {
    log.warn(`backfill: failed to resolve Koios tip: ${(err as Error)?.message ?? err}`);
    return;
  }
  if (currentTip === null) return;
  const rewindTo = Math.max(0, currentTip - nBlocks);
  log.info(`backfill: rewinding ${WATCHED_CREDENTIALS.length} watch(es) to block ${rewindTo} (tip ${currentTip}, -${nBlocks} blocks)`);

  // Lazy-load backfill module so pure live-boot paths don't pay the
  // require cost when the env var isn't set.
  let backfill: {
    backfillCredential: (cred: string) => Promise<void>;
    backfillAddress:    (addr: string) => Promise<void>;
  };
  try {
    backfill = require('@odatano/watch/src/backfill') as typeof backfill;
  } catch (err) {
    log.warn(`backfill: failed to load @odatano/watch/src/backfill: ${(err as Error)?.message ?? err}`);
    return;
  }

  for (const cfg of WATCHED_CREDENTIALS) {
    try {
      await adminSrv.run(
        UPDATE('WatchedCredentials')
          .set({ lastCheckedBlock: rewindTo })
          .where({ paymentCredHex: cfg.paymentCredHex }),
      );
      const t0 = Date.now();
      await backfill.backfillCredential(cfg.paymentCredHex);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      log.info(`backfill: ${cfg.tag} (cred) complete in ${elapsed}s`);
    } catch (err) {
      log.warn(`backfill: ${cfg.tag} (cred) failed: ${(err as Error)?.message ?? err}`);
    }
  }

  for (const cfg of WATCHED_ADDRESSES) {
    try {
      await adminSrv.run(
        UPDATE('WatchedAddresses')
          .set({ lastCheckedBlock: rewindTo })
          .where({ address: cfg.address }),
      );
      const t0 = Date.now();
      await backfill.backfillAddress(cfg.address);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      log.info(`backfill: ${cfg.tag} ${cfg.address.slice(0, 18)}… (addr) complete in ${elapsed}s`);
    } catch (err) {
      log.warn(`backfill: ${cfg.tag} (addr) failed: ${(err as Error)?.message ?? err}`);
    }
  }
}
