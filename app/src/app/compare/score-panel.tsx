'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface Props {
  convergenceScore: number;
  maxDeviationPct: number;
  outliers: string[];
  symbolCount: number;
}

/**
 * Animated convergence-score panel.
 *
 * Three coordinated animations:
 *   1. 270° SVG arc that sweeps from 0 to `convergenceScore` over 800ms,
 *      coloured by a red→yellow→green gradient that the arc traces out.
 *   2. Number count-up using requestAnimationFrame (cubic ease-out) so the
 *      headline number advances in lock-step with the arc.
 *   3. Max-deviation horizontal bar that fills from 0 to clamp(maxDev/5, 0, 1).
 *
 * Outliers get a pulse-ring badge — reuses the same animation defined in
 * globals.css for the home-page live indicator. Each badge is a Link to the
 * affected stable's detail page so a viewer can drill in immediately.
 */

const ARC_LENGTH    = 188.5;     // 270° of a 40-radius circle
const ANIM_DURATION = 800;
const MAX_DEV_FLOOR = 5;         // 5% maxDev = bar fully red-end

export function AnimatedScorePanel({
  convergenceScore, maxDeviationPct, outliers, symbolCount,
}: Props) {
  const score      = useCountUp(convergenceScore, ANIM_DURATION);
  const dev        = useCountUp(maxDeviationPct,  ANIM_DURATION);
  const arcOffset  = ARC_LENGTH * (1 - score);
  const barFillPct = Math.min(100, Math.max(0, (dev / MAX_DEV_FLOOR) * 100));

  const scoreColor =
    convergenceScore >= 0.95 ? 'text-(--healthy)' :
    convergenceScore >= 0.8  ? 'text-(--warning)' :
                               'text-(--critical)';

  return (
    <section className="grid grid-cols-1 sm:grid-cols-3 gap-4">
      {/* Score gauge */}
      <div className="border border-(--border) rounded-lg p-5 flex flex-col">
        <div className="text-sm uppercase tracking-wide text-(--muted-foreground)">
          Convergence score
        </div>
        <div className="mt-2 flex items-center gap-4">
          <ScoreGauge offset={arcOffset} />
          <div>
            <div className={`text-4xl font-bold ${scoreColor} tabular-nums`}>
              {score.toFixed(3)}
            </div>
            <div className="text-xs text-(--muted-foreground)">/ 1.000</div>
          </div>
        </div>
        <div className="mt-3 text-xs text-(--muted-foreground)">
          1.0 = perfect parity · 0.0 = chaotic spread (≥ 5%)
        </div>
      </div>

      {/* Max-deviation bar */}
      <div className="border border-(--border) rounded-lg p-5">
        <div className="text-sm uppercase tracking-wide text-(--muted-foreground)">
          Max deviation
        </div>
        <div className={`mt-2 text-4xl font-bold tabular-nums ${
          maxDeviationPct >= 1 ? 'text-(--warning)' : 'text-(--healthy)'
        }`}>
          {dev.toFixed(2)}%
        </div>
        <div
          className="mt-4 h-2 rounded-full bg-(--muted) relative overflow-hidden"
          aria-hidden="true"
        >
          <div
            className="absolute inset-y-0 left-0 rounded-full transition-[width] ease-out"
            style={{
              width: `${barFillPct}%`,
              transitionDuration: `${ANIM_DURATION}ms`,
              background:
                'linear-gradient(to right, var(--healthy) 0%, var(--warning) 50%, var(--critical) 100%)',
              backgroundSize: `${100 / Math.max(barFillPct, 1) * 100}% 100%`,
            }}
          />
        </div>
        <div className="mt-2 text-xs text-(--muted-foreground)">
          across {symbolCount} stables · scale capped at 5%
        </div>
      </div>

      {/* Outliers */}
      <div className="border border-(--border) rounded-lg p-5">
        <div className="text-sm uppercase tracking-wide text-(--muted-foreground)">
          Outliers
        </div>
        {outliers.length === 0 ? (
          <div className="mt-2 text-2xl font-semibold text-(--healthy) flex items-center gap-2">
            none
            <span className="relative inline-flex items-center justify-center w-2 h-2">
              <span className="absolute inline-flex w-full h-full rounded-full bg-(--healthy) opacity-50 pulse-ring" />
              <span className="relative inline-flex w-2 h-2 rounded-full bg-(--healthy) pulse-dot" />
            </span>
          </div>
        ) : (
          <div className="mt-2 flex flex-wrap gap-2">
            {outliers.map(o => (
              <OutlierBadge key={o} symbol={o} />
            ))}
          </div>
        )}
        <div className="mt-2 text-xs text-(--muted-foreground)">
          median |dev| against the basket exceeds 1%
        </div>
      </div>
    </section>
  );
}

function ScoreGauge({ offset }: { offset: number }) {
  return (
    <svg
      width="80"
      height="60"
      viewBox="0 0 100 100"
      aria-hidden="true"
      className="shrink-0"
    >
      <defs>
        <linearGradient id="gauge-grad" x1="0" y1="0" x2="100" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0%"   stopColor="#ef4444" />
          <stop offset="50%"  stopColor="#eab308" />
          <stop offset="100%" stopColor="#22c55e" />
        </linearGradient>
      </defs>
      {/* Background track */}
      <path
        d="M 21.7 78.3 A 40 40 0 1 1 78.3 78.3"
        stroke="var(--border)"
        strokeWidth="8"
        strokeLinecap="round"
        fill="none"
      />
      {/* Foreground (animated) — fills from start (red) to end (green) */}
      <path
        d="M 21.7 78.3 A 40 40 0 1 1 78.3 78.3"
        stroke="url(#gauge-grad)"
        strokeWidth="8"
        strokeLinecap="round"
        fill="none"
        strokeDasharray={ARC_LENGTH}
        strokeDashoffset={offset}
        style={{
          transition: `stroke-dashoffset ${ANIM_DURATION}ms cubic-bezier(0.16, 1, 0.3, 1)`,
        }}
      />
    </svg>
  );
}

function OutlierBadge({ symbol }: { symbol: string }) {
  return (
    <Link
      href={`/${symbol.toLowerCase()}`}
      className="relative inline-flex items-center gap-2 px-3 py-1 rounded-full border border-(--warning) text-(--warning) text-sm font-medium hover:bg-(--warning)/10 transition-colors"
    >
      <span className="relative inline-flex items-center justify-center w-1.5 h-1.5">
        <span className="absolute inline-flex w-full h-full rounded-full bg-(--warning) opacity-50 pulse-ring" />
        <span className="relative inline-flex w-1.5 h-1.5 rounded-full bg-(--warning)" />
      </span>
      {symbol}
    </Link>
  );
}

/**
 * Cubic ease-out count-up. requestAnimationFrame-driven so 60fps and never
 * drops a tick. Resets on `target` change (rare — once on mount in our case).
 */
function useCountUp(target: number, durationMs: number): number {
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (!Number.isFinite(target)) { setValue(target); return; }
    let raf = 0;
    const start = performance.now();
    const initial = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(initial + (target - initial) * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs]);
  return value;
}
