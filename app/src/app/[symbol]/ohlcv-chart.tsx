'use client';

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';
import type { OhlcvCandle } from '@/lib/chainfeed-client';

interface ChartPoint {
  ts: number;        // bucket start ms
  label: string;     // X-axis label "HH:MM"
  close: number;
  high: number;
  low: number;
}

export function OhlcvChart({ candles }: { candles: OhlcvCandle[] }) {
  const points: ChartPoint[] = candles.map((c) => {
    const t = new Date(c.ts);
    return {
      ts: t.getTime(),
      label: t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      close: c.close,
      high:  c.high,
      low:   c.low,
    };
  });

  // Y-axis range: clamp around the median to make small movements legible.
  const closes = points.map((p) => p.close).filter((v) => Number.isFinite(v) && v > 0);
  const median = closes.length > 0 ? closes.slice().sort((a, b) => a - b)[Math.floor(closes.length / 2)]! : 0;
  const minY = closes.length > 0 ? Math.min(...closes) : 0;
  const maxY = closes.length > 0 ? Math.max(...closes) : 1;
  const padding = (maxY - minY) * 0.15 || median * 0.005;

  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="2 4" vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fill: 'var(--chart-axis)', fontSize: 11 }}
            axisLine={{ stroke: 'var(--chart-grid)' }}
            tickLine={false}
            interval="preserveStartEnd"
            minTickGap={32}
          />
          <YAxis
            domain={[minY - padding, maxY + padding]}
            tick={{ fill: 'var(--chart-axis)', fontSize: 11 }}
            axisLine={{ stroke: 'var(--chart-grid)' }}
            tickLine={false}
            width={64}
            tickFormatter={(v: number) => v.toFixed(4)}
          />
          <ReferenceLine y={median} stroke="var(--muted-foreground)" strokeDasharray="2 4" />
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
            formatter={(v: number, name: string) => [v.toFixed(6), name]}
          />
          <Line
            type="monotone"
            dataKey="close"
            stroke="var(--accent)"
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
            name="close"
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
