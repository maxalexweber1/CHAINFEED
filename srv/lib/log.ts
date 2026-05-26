/**
 * pino-based structured logger for CHAINFEED non-CAP code.
 *
 * Why a separate logger from cds.log:
 *   - CAP's `cds.log()` already covers CAP-internal code paths (price-service,
 *     adapters, etc.). It emits JSON in production when `CDS_LOG_FORMAT=json`.
 *   - Standalone modules (`srv/mcp/`, the peg-monitor worker, anything
 *     bootstrapped outside the CAP server) don't have `cds.log` available
 *     consistently and have historically used raw `process.stderr.write`.
 *     Funnelling them through pino gives us the same JSON wire format Loki/
 *     Promtail will scrape in Week 6, without forcing them into CAP's runtime.
 *
 * Output policy: ALWAYS writes to stderr (fd 2), never stdout. This is
 * non-negotiable for `srv/mcp/server.ts` where stdout is the MCP JSON-RPC
 * wire protocol — a stray log line on stdout corrupts the protocol. Keeping
 * stderr-only here makes the rule globally invariant.
 *
 * Format flip:
 *   - Default              → pretty (colorized, human-readable)
 *   - NODE_ENV=production  → json (one record per line, Loki-friendly)
 *   - LOG_FORMAT=json|pretty overrides the default in either direction
 *   - CDS_LOG_FORMAT=json  ALSO enables json (so a single env-var in
 *                          docker-compose flips CAP + this in unison)
 *
 * Level: LOG_LEVEL env, default `info`. Standard pino levels apply
 * (trace < debug < info < warn < error < fatal).
 */

import pino, { type Logger } from 'pino';

export type { Logger };

const isProduction = process.env.NODE_ENV === 'production';
const useJson =
  process.env.LOG_FORMAT === 'json' ||
  process.env.CDS_LOG_FORMAT === 'json' ||
  (process.env.LOG_FORMAT !== 'pretty' && isProduction);

const level = process.env.LOG_LEVEL ?? 'info';

const root: Logger = useJson
  ? pino({ level }, pino.destination(2))      // fd 2 = stderr
  : pino({
      level,
      transport: {
        target: 'pino-pretty',
        options: {
          destination:    2,                   // pretty also writes to stderr
          colorize:       true,
          translateTime:  'HH:MM:ss.l',
          ignore:         'pid,hostname',
          messageFormat:  '{component} | {msg}',
        },
      },
    });

/** Default logger — fine for one-off lines. Prefer `getLogger(name)` for any
 *  module-level use so per-component filtering works later. */
export const logger: Logger = root;

/** Returns a child logger tagged with `component=<name>` — the field Loki/
 *  Promtail will index on in Week 6. Pass dotted names for sub-namespaces
 *  (`mcp:http`, `watcher:tick`, …). */
export function getLogger(component: string): Logger {
  return root.child({ component });
}
