# Dolos — Cardano mainnet data node

Lightweight Cardano data node (TxPipe Dolos v1.1.1) running locally so
CHAINFEED is no longer rate-limited by Blockfrost / Koios free-tier APIs.

## What it gives us

- **Mini-Blockfrost REST** on `http://localhost:3100` — Blockfrost-API-compatible
  drop-in. ODATANO core can be pointed at it with a fake API key.
  (Host port 3100 instead of Dolos's default 3000 to leave 3000 to Next.js dev.)
- **Mini-Kupo REST** on `http://localhost:1442` — pattern-based UTxO lookups.
- **UTxO RPC (gRPC)** on `localhost:50051` — for Pallas-based consumers.
- **Ouroboros n2c Unix socket** at `/socket/dolos.socket` (inside the named
  volume `dolos-socket`) — for an Ogmios sidecar later if we want JSON-WSP.

## Disk + RAM budget

- **~10–30 GB** disk for the ledger state (Redb v3 backend, ledger-only mode,
  `max_history = 30 days`). Compare to ~300 GB for a full cardano-node.
- **~2–4 GB** RAM working set after sync.
- **~few hours** initial Mithril snapshot bootstrap; then ongoing tip-follow
  costs ~5 MB/min download.

## First-time bootstrap

```sh
# From repo root. Run from outside Docker (host shell).
docker compose -f docker-compose.dolos.yml run --rm dolos bootstrap mithril
```

You'll see progress bars for: snapshot download → certificate verification →
block import → ledger replay. The download step does NOT support resume
(per Dolos docs) — keep the connection alive.

When it finishes (typically 1–4 h on a good connection) the named volume
`dolos-data` holds a synced ledger.

## Daily operation

```sh
# Start
docker compose -f docker-compose.dolos.yml up -d

# Tail logs
docker compose -f docker-compose.dolos.yml logs -f dolos

# Check health
curl http://localhost:3100/api/v0/health

# Stop (data preserved)
docker compose -f docker-compose.dolos.yml down

# Stop + WIPE data (forces a fresh bootstrap)
docker compose -f docker-compose.dolos.yml down -v
```

## Wiring ODATANO at Dolos

Since `@odatano/core` 1.7.7 and `@odatano/watch` 0.1.7 (both 2026-05-06),
the `customBackend` option is exposed as a first-class config field — no
monkey-patch needed.

Once Dolos is bootstrapped and `curl http://localhost:3100/api/v0/health`
returns 200, set the URL in `package.json`:

```jsonc
"cds": {
  "requires": {
    "odatano-core": {
      "blockfrostCustomBackend": "http://localhost:3100/api/v0"
    },
    "watch": {
      "blockfrostCustomBackend": "http://localhost:3100/api/v0"
    }
  }
}
```

Equivalent env override: `BLOCKFROST_CUSTOM_BACKEND=http://localhost:3100/api/v0`
(applies to both plugins). When set, `blockfrostApiKey` becomes optional —
Dolos accepts any project-id header.

Smoke after switching: `npx tsx scripts/smoke-odatano.ts` plus a couple of
adapter smokes (`smoke-djed-reserves.ts`, `smoke-indigo-cdp.ts`).

## Genesis files & Mithril keys

Genesis files (`byron.json` / `shelley.json` / `alonzo.json` / `conway.json`)
are baked into the official Dolos image at `/etc/genesis/mainnet/` — verified
blake2b hashes match `book.world.dev.cardano.org`. The Mithril aggregator URL
and genesis verification key in `daemon.toml` are the IOG-published mainnet
defaults; bump only if the Mithril team publishes a key rotation.

## Troubleshooting

- **`bootstrap mithril` fails on download**: usually flaky CDN. Re-run; it
  re-downloads from scratch (no resume). Use `--retain-snapshot` so a partial
  next time can use `--skip-download`.
- **`up` healthcheck staying unhealthy past 30 min**: tail the logs — usually
  tip-catchup after restore is still running. The 1800s `start_period` covers
  most cases; bump if needed.
- **Port already in use**: the host-side ports we expose are 3100 (MiniBF),
  1442 (MiniKupo), 50051 (gRPC). If anything else on the box already binds
  one, edit `docker-compose.dolos.yml` and pick a free host port.
