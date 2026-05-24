/**
 * Root component for the CHAINFEED dashboard.
 *
 * Owns:
 *  - the connected MCP client (received via props — entry handles connect)
 *  - the snapshot state (per-symbol assessments + lending + convergence)
 *  - the 30s refresh interval + the 1s countdown ticker
 *  - keyboard input (r, q)
 *
 * Fetch policy: every refresh fires all 7 calls in parallel via Promise.allSettled.
 * One failing call dims its panel without breaking the others — matches the
 * graceful-degradation pattern already in computeStableHealth on the server side.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdin } from 'ink';
import type { ChainfeedClient } from '../shared/chainfeed-client.js';
import { STABLE_SYMBOLS, type AssessmentResponse, type StableSymbol } from '../shared/types.js';
import { StableRow, StatusFooter } from './components.js';

const REFRESH_INTERVAL_MS = 30_000;

type AssessmentEntry = { data?: AssessmentResponse; error?: string };

interface Snapshot {
  assessments: Record<StableSymbol, AssessmentEntry>;
  lending: unknown;
  convergence: { score: number | null; raw: unknown };
  refreshedAt: Date;
}

/** Best-effort lift: convergence response shape isn't typed yet — pluck the score if present. */
function extractConvergenceScore(raw: unknown): number | null {
  if (raw && typeof raw === 'object' && 'convergenceScore' in raw) {
    const v = (raw as { convergenceScore?: unknown }).convergenceScore;
    return typeof v === 'number' ? v : null;
  }
  return null;
}

/**
 * Keyboard input lives in a subcomponent so it can be conditionally mounted —
 * `useInput` enables raw mode unconditionally in its effect (the `isActive` flag
 * doesn't gate that call), so when stdin isn't a TTY we just don't render this
 * component at all. Rules-of-hooks compatible because we always call the hook
 * when this component is mounted.
 */
function KeyboardHandler({ onRefresh, onQuit }: { onRefresh: () => void; onQuit: () => void }) {
  useInput((input) => {
    if (input === 'q') onQuit();
    else if (input === 'r') onRefresh();
  });
  return null;
}

export function App({ client, baseUrl }: { client: ChainfeedClient; baseUrl: string }) {
  const { exit } = useApp();
  // Raw mode requires a TTY. When piped (CI, screencap tools, smoke tests) we
  // still want to render the snapshot — just skip the keyboard handler.
  const { isRawModeSupported } = useStdin();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [nextRefreshSec, setNextRefreshSec] = useState(REFRESH_INTERVAL_MS / 1000);
  const [fatalError, setFatalError] = useState<string | null>(null);
  // Skip-if-in-flight guard. Ref (not state) so the check doesn't depend on
  // React's render cycle — a cold first-refresh that takes >30s would otherwise
  // dogpile the next interval-fired refresh into a contention spiral.
  const inFlightRef = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setRefreshing(true);
    try {
      const [
        usdm, djed, iusd, usda, usdcx, lending, convergence,
      ] = await Promise.allSettled([
        client.assessStable('USDM'),
        client.assessStable('DJED'),
        client.assessStable('iUSD'),
        client.assessStable('USDA'),
        client.assessStable('USDCx'),
        client.getLendingHealth(),
        client.getStableConvergence(),
      ]);
      const pack = (r: PromiseSettledResult<AssessmentResponse>): AssessmentEntry =>
        r.status === 'fulfilled'
          ? { data: r.value }
          : { error: (r.reason as Error)?.message ?? 'unknown' };
      setSnapshot({
        assessments: {
          USDM:  pack(usdm),
          DJED:  pack(djed),
          iUSD:  pack(iusd),
          USDA:  pack(usda),
          USDCx: pack(usdcx),
        },
        lending: lending.status === 'fulfilled' ? lending.value : { available: false },
        convergence: {
          score: convergence.status === 'fulfilled' ? extractConvergenceScore(convergence.value) : null,
          raw: convergence.status === 'fulfilled' ? convergence.value : null,
        },
        refreshedAt: new Date(),
      });
      setNextRefreshSec(REFRESH_INTERVAL_MS / 1000);
    } catch (e) {
      // Only hit if Promise.allSettled itself throws — practically never.
      setFatalError((e as Error)?.message ?? 'refresh failed');
    } finally {
      setRefreshing(false);
      inFlightRef.current = false;
    }
  }, [client]);

  // Initial fetch + periodic refresh.
  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  // 1Hz countdown — purely cosmetic.
  useEffect(() => {
    const id = setInterval(() => setNextRefreshSec((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, []);

  // (keyboard handling rendered conditionally below — see KeyboardHandler)

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">CHAINFEED Live Dashboard</Text>
        <Text dimColor>  ·  symbol · verdict · peg · risk · headline</Text>
      </Box>

      {fatalError && (
        <Box marginBottom={1}>
          <Text color="red">fatal: {fatalError}</Text>
        </Box>
      )}

      {STABLE_SYMBOLS.map((sym) => (
        <StableRow
          key={sym}
          symbol={sym}
          data={snapshot?.assessments[sym]?.data}
          error={snapshot?.assessments[sym]?.error}
        />
      ))}

      <StatusFooter
        lending={snapshot?.lending}
        convergenceScore={snapshot?.convergence.score ?? null}
        refreshedAt={snapshot?.refreshedAt ?? null}
        nextRefreshSec={nextRefreshSec}
        refreshing={refreshing}
        baseUrl={baseUrl}
      />

      {isRawModeSupported && (
        <KeyboardHandler onRefresh={() => void refresh()} onQuit={exit} />
      )}
    </Box>
  );
}
