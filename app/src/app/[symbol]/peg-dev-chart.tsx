'use client';

import {
  LineChart, Line, XAxis, YAxis, Tooltip, ReferenceLine, ReferenceArea,
  ResponsiveContainer, CartesianGrid,
} from 'recharts';
import type { PegDeviationBucket } from '@/lib/chainfeed-client';

interface ChartPoint {
  label: string;
  bps: number;
}

/**
 * Peg-deviation history chart.
 *
 * Plots `pegDeviationBps` over time (one point per OHLCV bucket where both
 * the stable's ADA price AND the ADA-USD reference had observations).
 * Reference bands at ±50 bps (healthy), ±200 bps (warning); reference line
 * at 0 (parity). Line color shifts by max-abs in the window.
 */
export function PegDevChart({ buckets }: { buckets: PegDeviationBucket[] }) {
  const points: ChartPoint[] = buckets.map(b => {
    const t = new Date(b.ts);
    return {
      label: t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      bps: b.bps,
    };
  });

  const maxAbs = points.reduce((m, p) => Math.max(m, Math.abs(p.bps)), 0);
  // Resolve color tokens directly so recharts (which doesn't follow CSS
  // currentColor) gets a static hex from the right band.
  const lineColor =
    maxAbs < 50   ? '#16a34a' :     // healthy (green-600 — readable on white)
    maxAbs < 200  ? '#d97706' :     // warning (amber-600)
                    '#dc2626';      // critical (red-600)

  // Y-axis range: at least ±50 bps so the bands are visible even on very
  // healthy stables. Expand to fit the actual data with 20% headroom.
  const yMin = Math.min(-50, -Math.ceil(maxAbs * 1.2 / 50) * 50);
  const yMax = Math.max( 50,  Math.ceil(maxAbs * 1.2 / 50) * 50);

  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="2 4" vertical={false} />

          {/* Health bands — reference areas painted under the line */}
          <ReferenceArea y1={-50}  y2={50}   fill="#16a34a" fillOpacity={0.06} />
          <ReferenceArea y1={50}   y2={200}  fill="#d97706" fillOpacity={0.06} />
          <ReferenceArea y1={-200} y2={-50}  fill="#d97706" fillOpacity={0.06} />
          <ReferenceArea y1={200}  y2={yMax} fill="#dc2626" fillOpacity={0.06} />
          <ReferenceArea y1={yMin} y2={-200} fill="#dc2626" fillOpacity={0.06} />

          <XAxis
            dataKey="label"
            tick={{ fill: 'var(--chart-axis)', fontSize: 11 }}
            axisLine={{ stroke: 'var(--chart-grid)' }}
            tickLine={false}
            interval="preserveStartEnd"
            minTickGap={32}
          />
          <YAxis
            domain={[yMin, yMax]}
            tick={{ fill: 'var(--chart-axis)', fontSize: 11 }}
            axisLine={{ stroke: 'var(--chart-grid)' }}
            tickLine={false}
            width={56}
            tickFormatter={(v: number) => `${v >= 0 ? '+' : ''}${v}`}
          />
          {/* Peg parity line */}
          <ReferenceLine y={0} stroke="var(--muted-foreground)" strokeDasharray="2 4" />
          <Tooltip
            cursor={{ stroke: 'var(--muted-foreground)', strokeWidth: 1 }}
            contentStyle={{
              background: 'var(--chart-tooltip-bg)',
              border: '1px solid var(--chart-tooltip-border)',
              borderRadius: '6px',
              fontSize: '12px',
              color: 'var(--chart-tooltip-text)',
              boxShadow: '0 4px 12px rgba(15, 23, 42, 0.08)',
            }}
            labelStyle={{ color: 'var(--chart-tooltip-label)' }}
            formatter={(v: number) => [`${v >= 0 ? '+' : ''}${v.toFixed(1)} bps`, 'peg dev']}
          />
          <Line
            type="monotone"
            dataKey="bps"
            stroke={lineColor}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
            name="peg dev"
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
