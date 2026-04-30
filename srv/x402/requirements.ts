/**
 * Build the canonical Masumi-spec 402 response body. The shape here is the
 * single source of truth for what we emit on `X-PAYMENT` missing/invalid —
 * stay wire-compatible with `scheme_exact_cardano.md`.
 */

export interface X402Config {
  network: string;
  payTo: string;
  usdmPolicy: string;
  usdmNameHex: string;
  usdmDecimals: number;
}

export interface PaymentRequirementEntry {
  scheme: 'exact';
  network: string;
  maxAmountRequired: string;
  asset: string;
  payTo: string;
  resource: string;
  description: string;
  mimeType: string;
  outputSchema: null;
  maxTimeoutSeconds: number;
  extra: {
    assetNameHex: string;
    decimals: number;
  };
}

export interface PaymentRequirementsBody {
  x402Version: 1;
  error: string;
  accepts: [PaymentRequirementEntry];
}

export interface BuildPaymentRequirementsArgs {
  priceUnits: string | number | bigint;
  resource: string;
  description?: string;
  config?: X402Config;
}

function readEnv(key: string, fallback: string): string {
  const v = process.env[key];
  return v && v.length > 0 ? v : fallback;
}

/**
 * Resolve x402 server-side configuration from process.env.
 * Each call reads fresh so tests can mutate env between cases.
 */
export function resolveConfig(): X402Config {
  const network      = readEnv('X402_NETWORK',        'cardano-preprod');
  const payTo        = readEnv('X402_PAY_TO',         '');
  const usdmPolicy   = readEnv('X402_USDM_POLICY',    '');
  const usdmNameHex  = readEnv('X402_USDM_NAME_HEX',  '0014df105553444d');
  const usdmDecimals = Number(readEnv('X402_USDM_DECIMALS', '6'));
  return { network, payTo, usdmPolicy, usdmNameHex, usdmDecimals };
}

export function buildPaymentRequirements(
  { priceUnits, resource, description, config }: BuildPaymentRequirementsArgs,
): PaymentRequirementsBody {
  const cfg = config ?? resolveConfig();
  if (!cfg.payTo)      throw new Error('X402_PAY_TO not configured');
  if (!cfg.usdmPolicy) throw new Error('X402_USDM_POLICY not configured');

  return {
    x402Version: 1,
    error: 'X-PAYMENT header is required',
    accepts: [{
      scheme:            'exact',
      network:           cfg.network,
      maxAmountRequired: String(priceUnits),
      asset:             cfg.usdmPolicy,
      payTo:             cfg.payTo,
      resource:          String(resource),
      description:       description ?? 'CHAINFEED oracle data',
      mimeType:          'application/json',
      outputSchema:      null,
      maxTimeoutSeconds: 600,
      extra: {
        assetNameHex: cfg.usdmNameHex,
        decimals:     cfg.usdmDecimals,
      },
    }],
  };
}

/**
 * Pull the payment requirements `accepts[0]` for the validator. The
 * full 402 body is for the wire; the validator only needs the requirements.
 */
export function flatRequirements(
  paymentRequirementsBody: PaymentRequirementsBody,
): PaymentRequirementEntry {
  return paymentRequirementsBody.accepts[0];
}
