/**
 * CHAINFEED-side x402 server config — resolves the Cardano-x402-v2
 * facilitator settings from environment variables.
 *
 * This is the single source of truth for "is x402 enabled, and with what
 * payTo / network / asset". Both the `gateService` mount in
 * `srv/price-service.ts` and the `subscribePegAlert` / `buildPaymentTx`
 * handlers read from here.
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

const DEFAULT_USDM_NAME_HEX = '0014df105553444d'; // CIP-68 (333) USDM
const DEFAULT_NETWORK       = 'cardano:preprod';
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
 */
export function normalizeNetwork(raw: string): string {
  if (raw.includes(':')) return raw;
  return raw.replace(/^cardano-/, 'cardano:');
}

/**
 * Resolve x402 server config from `process.env`. Read fresh on every
 * call so tests / `cds watch` reloads pick up env changes.
 */
export function resolveX402Config(): X402ServerConfig {
  const payTo        = readEnv('X402_PAY_TO', '');
  const policyId     = readEnv('X402_USDM_POLICY', '');
  const assetNameHex = readEnv('X402_USDM_NAME_HEX', DEFAULT_USDM_NAME_HEX);
  const network      = normalizeNetwork(readEnv('X402_NETWORK', DEFAULT_NETWORK));
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
