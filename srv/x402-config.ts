/**
 * CHAINFEED-side x402 server config — resolves the Cardano-x402-v2
 * facilitator settings from environment variables.
 *
 * This is the single source of truth for "is x402 enabled, and with what
 * payTo / network / asset". Both the `gateService` mount in
 * `srv/price-service.ts` and the `subscribePegAlert` / `buildPaymentTx`
 * handlers read from here.
 *
 * Network precedence (highest wins):
 *   1. `X402_NETWORK` env var (if set)
 *   2. `cds.env.requires['odatano-core'].network` (so x402 follows the
 *      same network as the underlying ODATANO bridge by default — no
 *      "x402 verified preprod USDM while UTxOs were read from mainnet"
 *      class of misconfig)
 *   3. `cardano:preprod`
 *
 * `assertNetworkConsistency()` is called from `srv/server.ts` on `served`
 * to fail-fast (in production) if a mismatch is still set after env
 * resolution.
 *
 * v2 shape vs the old in-tree v1:
 *   - `network` is colon-form (`cardano:preprod`), not hyphen-form. We
 *     normalise a stray hyphen value so an un-migrated `.env` still boots,
 *     but the canonical value in `.env` is `cardano:preprod`.
 *   - `asset` is the single v2 string `<policyId>.<assetNameHex>` —
 *     combined here from the still-separate `X402_USDM_POLICY` /
 *     `X402_USDM_NAME_HEX` env vars so operators don't have to re-do the
 *     wallet env file.
 *
 * x402 is considered disabled (dev mode) when `X402_PAY_TO` or
 * `X402_USDM_POLICY` is unset — callers skip gating entirely.
 */

import cds from '@sap/cds';

const DEFAULT_USDM_NAME_HEX = '0014df105553444d'; // CIP-68 (333) USDM
const FALLBACK_NETWORK      = 'cardano:preprod';
const DEFAULT_USDM_DECIMALS = 6;

export interface X402ServerConfig {
  /** True when payTo + asset policy are both configured. */
  enabled: boolean;
  /** Bech32 receiver address. */
  payTo: string;
  /** v2 network identifier, colon-form: `cardano:mainnet|preprod|preview`. */
  network: string;
  /** v2 asset string `<policyId>.<assetNameHex>` (empty when disabled). */
  asset: string;
  /** USDM decimal places — domain info, not part of the v2 requirements body. */
  usdmDecimals: number;
}

function readEnv(key: string, fallback: string): string {
  const v = process.env[key];
  return v && v.length > 0 ? v : fallback;
}

/**
 * Normalise a network string to v2 colon-form. Accepts the v1 hyphen
 * form (`cardano-preprod`) as a courtesy so an un-migrated `.env` keeps
 * working — but the package itself refuses v1 hyphen networks on the
 * wire, so the value emitted here is always colon-form.
 *
 * Also accepts a bare ODATANO-style network (`mainnet`/`preprod`/`preview`)
 * so the odatano-core config value can be passed through unchanged.
 */
export function normalizeNetwork(raw: string): string {
  if (raw.includes(':')) return raw;
  const hyphen = raw.replace(/^cardano-/, 'cardano:');
  if (hyphen.includes(':')) return hyphen;
  // Bare network word — prepend the v2 namespace.
  return `cardano:${raw}`;
}

/**
 * Read the bridge's active network from CAP config. Returns the v2 colon-form
 * value, or null if odatano-core isn't configured (e.g. in unit-test contexts
 * that don't bootstrap CAP).
 */
export function resolveOdatanoNetwork(): string | null {
  try {
    const odatano = (cds.env?.requires as Record<string, { network?: string }> | undefined)?.['odatano-core'];
    if (odatano?.network) return normalizeNetwork(odatano.network);
  } catch {
    // cds.env is not yet initialized in some test entrypoints — fall through.
  }
  return null;
}

/**
 * Resolve x402 server config from `process.env`. Read fresh on every
 * call so tests / `cds watch` reloads pick up env changes.
 */
export function resolveX402Config(): X402ServerConfig {
  const payTo        = readEnv('X402_PAY_TO', '');
  const policyId     = readEnv('X402_USDM_POLICY', '');
  const assetNameHex = readEnv('X402_USDM_NAME_HEX', DEFAULT_USDM_NAME_HEX);
  const networkDefault = resolveOdatanoNetwork() ?? FALLBACK_NETWORK;
  const network      = normalizeNetwork(readEnv('X402_NETWORK', networkDefault));
  const usdmDecimals = Number(readEnv('X402_USDM_DECIMALS', String(DEFAULT_USDM_DECIMALS)));

  const enabled = !!(payTo && policyId);

  return {
    enabled,
    payTo,
    network,
    asset: policyId ? `${policyId.toLowerCase()}.${assetNameHex.toLowerCase()}` : '',
    usdmDecimals: Number.isFinite(usdmDecimals) ? usdmDecimals : DEFAULT_USDM_DECIMALS,
  };
}

/**
 * Verify that the resolved x402 network matches the ODATANO bridge network.
 * A mismatch means x402 will accept payments on one network while the bridge
 * reads UTxOs from another — a misroute risk that should never reach prod.
 *
 * - Returns silently when no mismatch.
 * - Returns silently when x402 is disabled (`enabled === false`) — we don't
 *   block dev boot for a setting that won't gate anything.
 * - In production, throws so the boot sequence dies loud.
 * - Otherwise (dev, x402 enabled), warns via the supplied logger.
 */
export function assertNetworkConsistency(
  log: { warn: (msg: string) => void; error: (msg: string) => void } = console,
): { match: true } | { match: false; x402: string; odatano: string } {
  const cfg = resolveX402Config();
  const odatano = resolveOdatanoNetwork();
  if (!odatano || !cfg.enabled) return { match: true };
  if (cfg.network === odatano) return { match: true };

  const msg =
    `x402 network (${cfg.network}) does not match odatano-core network (${odatano}). ` +
    `This will accept payments on one network while reading UTxOs from another. ` +
    `Set X402_NETWORK to match cds.requires['odatano-core'].network, or unset it to inherit.`;
  if (process.env.NODE_ENV === 'production') {
    log.error(msg);
    throw new Error(msg);
  }
  log.warn(msg);
  return { match: false, x402: cfg.network, odatano };
}
