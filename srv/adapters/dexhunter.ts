/**
 * DexHunter adapter — multi-DEX aggregator. Sends a small "estimate"
 * request to `/swap/estimate` and computes the executable price as
 * `expected_output / amount_in`.
 *
 * "Small amount" matters: a tiny notional minimises price impact, so the
 * resulting ratio is close to the true mid-price across DexHunter's
 * routed pools. We send 100 ADA (= 100_000_000 lovelace).
 *
 * Auth: docs say `X-Partner-Id` is required; in practice (verified
 * 2026-04-27) the endpoint accepts unauthenticated requests for read-only
 * estimates. We send the header IF an env var provides one, never block
 * on its absence.
 *
 * Source: dexhunter.gitbook.io/dexhunter-partners
 */

import { postJson } from './http';
import { assertIsAdapter, type PriceAdapter, type PriceQuote } from './types';

const SOURCE_NAME = 'dexhunter';
const URL = 'https://api-us.dexhunterv3.app/swap/estimate';

// ADA in DexHunter's API is the empty string. USDM is policy+nameHex concatenated.
const TOKEN_ADA  = '';
const TOKEN_USDM = 'c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad0014df105553444d';

// 100 ADA — small enough that price impact stays near zero on a deep
// venue, large enough that integer rounding inside DexHunter doesn't bias
// the ratio. Verified empirically: amount_in is in WHOLE ADA units (not
// lovelace), total_output likewise in WHOLE USDM. So
// total_output/amount_in == USDM-per-ADA spot rate directly.
const PROBE_AMOUNT_ADA = 100;

const SUPPORTED_PAIRS = new Set(['ADA-USDM']);

interface DexHunterSplit {
  dex?: string;
  amount_in?: number | string;
  expected_output?: number | string;
  pool_fee?: number | string;
}

interface DexHunterResponse {
  total_output?: number | string;
  net_price?: number;
  splits?: DexHunterSplit[];
}

async function getPrice(pair: string): Promise<PriceQuote> {
  if (!SUPPORTED_PAIRS.has(pair)) throw new Error(`dexhunter: pair '${pair}' not supported`);

  const headers: Record<string, string> = {};
  if (process.env.DEXHUNTER_PARTNER_ID) {
    headers['X-Partner-Id'] = process.env.DEXHUNTER_PARTNER_ID;
  }

  const body = {
    token_in:        TOKEN_ADA,
    token_out:       TOKEN_USDM,
    amount_in:       PROBE_AMOUNT_ADA,
    slippage:        0.5,
    blacklisted_dexes: [] as string[],
  };

  const r = await postJson<DexHunterResponse>(URL, body, { headers, timeoutMs: 8_000 });

  // Sum splits if the top-level field is missing — defensive against schema drift.
  let totalOut: number;
  if (Number.isFinite(Number(r?.total_output))) {
    totalOut = Number(r.total_output);
  } else if (Array.isArray(r?.splits) && r.splits.length > 0) {
    totalOut = r.splits.reduce((s, x) => s + Number(x?.expected_output ?? 0), 0);
  } else {
    throw new Error('dexhunter: response missing total_output and splits[]');
  }
  if (!Number.isFinite(totalOut) || totalOut <= 0) {
    throw new Error(`dexhunter: invalid expected_output ${totalOut}`);
  }

  // amount_in / total_output are in WHOLE units, so the ratio is direct.
  const price = totalOut / PROBE_AMOUNT_ADA;

  return {
    sourceName: SOURCE_NAME,
    pair,
    price,
    timestamp:  Date.now(),
    rawPayload: {
      probeAmountAda: PROBE_AMOUNT_ADA,
      totalOutput:    totalOut,
      netPrice:       r?.net_price,
      splits:         (r?.splits ?? []).map(s => ({
        dex:             s?.dex,
        amount_in:       s?.amount_in,
        expected_output: s?.expected_output,
        pool_fee:        s?.pool_fee,
      })),
    },
  };
}

function supportsPair(pair: string): boolean {
  return SUPPORTED_PAIRS.has(pair);
}

const adapter: PriceAdapter = { sourceName: SOURCE_NAME, getPrice, supportsPair };
assertIsAdapter(adapter, 'dexhunter');

export = adapter;
