/**
 * pino-based structured logger for the demo agents.
 *
 * Mirrors `srv/lib/log.ts` but lives under the `agents/` ESM scope, so it
 * doesn't drag in any CAP module references — agents stay framework-free.
 *
 * Output: always stderr (fd 2). Format flips between pretty (dev) and JSON
 * (NODE_ENV=production or LOG_FORMAT=json) the same way the server-side
 * logger does, so logs from CAP, MCP, and agents are uniformly parseable
 * when piped through Loki/Promtail in production.
 */

import pino, { type Logger } from 'pino';

export type { Logger };

const isProduction = process.env.NODE_ENV === 'production';
const useJson =
  process.env.LOG_FORMAT === 'json' ||
  (process.env.LOG_FORMAT !== 'pretty' && isProduction);

const level = process.env.LOG_LEVEL ?? 'info';

const root: Logger = useJson
  ? pino({ level }, pino.destination(2))
  : pino({
      level,
      transport: {
        target: 'pino-pretty',
        options: {
          destination:    2,
          colorize:       true,
          translateTime:  'HH:MM:ss.l',
          ignore:         'pid,hostname',
          messageFormat:  '{component} | {msg}',
        },
      },
    });

export const logger: Logger = root;

export function getLogger(component: string): Logger {
  return root.child({ component });
}
