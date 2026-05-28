/**
 * DNS-rebind defense for outbound webhooks.
 *
 * `validateWebhookUrl` (alert-detector.ts) only inspects the literal hostname
 * at subscribe time — a public DNS name pointing at a private IP passes that
 * gate, and the record can flip after validation. This module resolves the
 * hostname and re-checks every returned address against the same private-range
 * patterns immediately before the peg-monitor POSTs. It closes the TOCTOU/
 * rebind window the static check documented as a limitation.
 *
 * Enforced only in production by default (dev/test webhooks legitimately
 * target localhost); pass `enforce` to override for tests.
 */

import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { isPrivateHostLiteral } from './alert-detector';

export type EgressCheck = { ok: true } | { ok: false; reason: string };

/** Resolver shape — always called with `{ all: true }`, returns every record. */
export type EgressResolver = (hostname: string, opts: { all: true }) => Promise<LookupAddress[]>;

export interface EgressOptions {
  /** Injectable resolver for tests. Defaults to node:dns/promises lookup. */
  lookupImpl?: EgressResolver;
  /** Force the check on/off. Defaults to `NODE_ENV === 'production'`. */
  enforce?: boolean;
}

const defaultResolver: EgressResolver = (hostname, opts) => lookup(hostname, opts);

/**
 * Resolve `hostname` and verify none of its A/AAAA records fall in a
 * private/loopback/link-local range. Returns `{ ok: true }` when the check is
 * not enforced, when resolution is clean, and `{ ok: false, reason }` on a
 * private literal, a private resolution, or a DNS failure (fail closed).
 */
export async function assertPublicEgress(
  hostname: string,
  opts: EgressOptions = {},
): Promise<EgressCheck> {
  const enforce = opts.enforce ?? (process.env.NODE_ENV === 'production');
  if (!enforce) return { ok: true };

  // A literal-IP host skips DNS entirely — still reject it if it's private.
  if (isPrivateHostLiteral(hostname)) {
    return { ok: false, reason: `host ${hostname} is a private/loopback address` };
  }

  const resolve = opts.lookupImpl ?? defaultResolver;
  let records: LookupAddress[];
  try {
    records = await resolve(hostname, { all: true });
  } catch {
    // Fail closed: if we can't verify where it points, don't send.
    return { ok: false, reason: `DNS lookup failed for ${hostname}` };
  }

  if (records.length === 0) {
    return { ok: false, reason: `DNS returned no records for ${hostname}` };
  }
  for (const r of records) {
    if (isPrivateHostLiteral(r.address)) {
      return { ok: false, reason: `host ${hostname} resolves to private address ${r.address}` };
    }
  }
  return { ok: true };
}
