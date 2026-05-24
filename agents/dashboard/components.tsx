/**
 * Small render primitives for the CHAINFEED dashboard.
 *
 * Kept in one file because there are only three of them and they share zero
 * state. Splitting per-component would invite premature abstraction.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { AssessmentResponse, Verdict } from '../shared/types.js';

const VERDICT_COLOR: Record<Verdict, 'green' | 'yellow' | 'red'> = {
  ok:      'green',
  caution: 'yellow',
  alert:   'red',
};

/** Colored fixed-width verdict pill. Width 9 chars so rows align regardless of label length. */
export function VerdictPill({ verdict }: { verdict: Verdict }) {
  return (
    <Text color={VERDICT_COLOR[verdict]} bold>
      [{verdict.padEnd(7)}]
    </Text>
  );
}

/** Format peg-deviation as a signed percent string with fixed width. */
function fmtPegBps(bps: number | null): string {
  if (bps === null || !Number.isFinite(bps)) return '   n/a  ';
  const pct = bps / 100;
  const sign = pct > 0 ? '+' : pct < 0 ? '' : ' ';
  return `${sign}${pct.toFixed(2)}%`.padStart(7);
}

/**
 * One stablecoin row: symbol · verdict · peg · risk · headline.
 *
 * Each column lives in a fixed-width `<Box>` so the rows align — without
 * explicit widths ink lets each `<Text>` flow to its natural width, which
 * makes the table look ragged and wraps the verdict pill when a peg field is
 * empty. The trailing headline grows to fill the remainder and truncates.
 */
export function StableRow({ symbol, data, error }: {
  symbol: string;
  data?: AssessmentResponse;
  error?: string;
}) {
  if (error) {
    return (
      <Box>
        <Box width={7}><Text color="gray">{symbol}</Text></Box>
        <Box width={11}><Text color="red">[error]</Text></Box>
        <Box flexGrow={1}><Text color="gray" wrap="truncate">{error}</Text></Box>
      </Box>
    );
  }
  if (!data) {
    return (
      <Box>
        <Box width={7}><Text color="gray">{symbol}</Text></Box>
        <Box width={11}><Text color="gray">loading…</Text></Box>
      </Box>
    );
  }

  const pegBps = data.detail?.pegDeviationBps ?? null;
  const risk = data.riskScore;
  const headline = data.headline ?? '';

  return (
    <Box>
      <Box width={7}><Text bold>{symbol}</Text></Box>
      <Box width={11}><VerdictPill verdict={data.verdict} /></Box>
      <Box width={9}><Text>{fmtPegBps(pegBps)}</Text></Box>
      <Box width={11}><Text color="cyan">risk {risk.toFixed(2)}</Text></Box>
      <Box flexGrow={1}><Text color="gray" wrap="truncate">{headline}</Text></Box>
    </Box>
  );
}

/** Bottom status strip — lending counts + convergence score + key hints. */
export function StatusFooter({
  lending,
  convergenceScore,
  refreshedAt,
  nextRefreshSec,
  refreshing,
  baseUrl,
}: {
  lending?: unknown;
  convergenceScore: number | null;
  refreshedAt: Date | null;
  nextRefreshSec: number;
  refreshing: boolean;
  baseUrl: string;
}) {
  // Best-effort: walk into the loose lending shape without committing types.
  // Field names mirror what `getFluidtokensHealth` / `getLiqwidHealth` return.
  const l = lending as
    | { fluidtokens?: { poolsTotal?: number; loansTotal?: number } | { available: false };
        liqwid?:      { marketCount?: number } | { available: false } }
    | undefined;

  const fluidStr = l?.fluidtokens && 'poolsTotal' in l.fluidtokens
    ? `FluidTokens: ${l.fluidtokens.poolsTotal ?? '?'} pools / ${l.fluidtokens.loansTotal ?? '?'} loans`
    : 'FluidTokens: n/a';
  const liqwidStr = l?.liqwid && 'marketCount' in l.liqwid
    ? `Liqwid: ${l.liqwid.marketCount ?? '?'} markets`
    : 'Liqwid: n/a';

  const convStr = convergenceScore !== null && Number.isFinite(convergenceScore)
    ? convergenceScore.toFixed(2)
    : 'n/a';

  const lastStr = refreshedAt
    ? refreshedAt.toLocaleTimeString()
    : '—';

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="gray">Lending · {fluidStr} · {liqwidStr}</Text>
      <Text color="gray">Convergence score: <Text color="cyan">{convStr}</Text></Text>
      <Box marginTop={1}>
        <Text dimColor>
          last: {lastStr} · next in {Math.max(0, nextRefreshSec)}s
          {refreshing ? ' · refreshing…' : ''} · {baseUrl}
        </Text>
      </Box>
      <Text dimColor>[r] refresh now   [q] quit</Text>
    </Box>
  );
}
