/**
 * Typed errors for x402 verification.
 *
 * The `code` field is what we surface in the 402 response body's `error`
 * field, so it doubles as machine-readable diagnostic. Stay in lower_snake
 * to match the masumi spec convention (`invalid_transaction_state`,
 * `insufficient_funds`, etc.).
 */
export class X402Error extends Error {
  readonly code: string;

  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = 'X402Error';
    this.code = code;
  }
}

export const Codes = Object.freeze({
  // decode
  MISSING_HEADER:        'missing_payment_header',
  INVALID_BASE64:        'invalid_base64',
  INVALID_JSON:          'invalid_json',
  MISSING_FIELD:         'missing_field',
  UNSUPPORTED_VERSION:   'unsupported_version',
  UNSUPPORTED_SCHEME:    'unsupported_scheme',
  INVALID_CBOR:          'invalid_cbor',

  // validate
  NETWORK_MISMATCH:      'network_mismatch',
  WRONG_RECIPIENT:       'wrong_recipient',
  WRONG_ASSET:           'wrong_asset',
  INSUFFICIENT_AMOUNT:   'insufficient_amount',
  UNSIGNED_TRANSACTION:  'unsigned_transaction',

  // nonce / settle
  REPLAY:                'replay_detected',
  SUBMIT_FAILED:         'submit_failed',
  PENDING:               'invalid_transaction_state', // matches masumi spec
} as const);

export type X402Code = typeof Codes[keyof typeof Codes];
