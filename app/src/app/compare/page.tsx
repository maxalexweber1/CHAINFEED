import Link from 'next/link';
import {
  getStableConvergence,
  type ConvergenceResult,
  type ConvergenceCrossRate,
} from '@/lib/chainfeed-client';
import { AnimatedScorePanel } from './score-panel';

export const revalidate = 300;

export const metadata = { title: 'CHAINFEED · Compare · Stable convergence' };

export default async function ComparePage() {
  let data: ConvergenceResult | null = null;
  let error: string | null = null;
  try {
    data = await getStableConvergence({ revalidateSec: 30 });
  } catch (e) {
    error = (e as Error).message;
  }

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-3xl font-bold tracking-tight">Stable convergence</h1>
        <p className="mt-3 text-(--muted-foreground) max-w-3xl">
          Implied stable-vs-stable cross-rates derived through the ADA pivot.
          Perfectly-pegged stables cross at 1.000; persistent deviation in one
          row points at a stable-specific peg break, while uniform drift across
          the basket points at a data-quality issue with the ADA-USD reference.
        </p>
      </header>

      {error && (
        <div className="border border-(--critical) rounded-lg p-4 text-sm text-(--critical)">
          Failed to load convergence: {error}
        </div>
      )}

      {data && (
        <>
          <AnimatedScorePanel
            convergenceScore={data.convergenceScore}
            maxDeviationPct={data.maxDeviationPct}
            outliers={data.outliers}
            symbolCount={data.symbols.length}
          />
          <Heatmap data={data} />
          <SnapshotTable data={data} />
        </>
      )}

      <Methodology />
    </div>
  );
}

function Heatmap({ data }: { data: ConvergenceResult }) {
  const { symbols, rates, outliers } = data;
  const outlierSet = new Set(outliers);
  // Index rates by from→to for O(1) cell lookup.
  const lookup = new Map<string, ConvergenceCrossRate>();
  for (const r of rates) lookup.set(`${r.fromSymbol}→${r.toSymbol}`, r);

  return (
    <section>
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
        <h2 className="font-semibold">Cross-rate matrix</h2>
        <Legend />
      </div>
      <div className="border border-(--border) rounded-lg overflow-x-auto">
        <table className="text-sm border-separate" style={{ borderSpacing: 0, minWidth: 'max-content', width: '100%' }}>
          <thead>
            <tr>
              <th
                className="sticky left-0 z-20 bg-(--background) border-r border-(--border) px-3 py-3 text-left text-xs uppercase tracking-wide text-(--muted-foreground) font-medium"
              >
                from \ to
              </th>
              {symbols.map(s => {
                const isOutlier = outlierSet.has(s);
                return (
                  <th
                    key={s}
                    className={`px-3 py-3 text-center text-xs uppercase tracking-wide font-medium border-b border-(--border) ${
                      isOutlier
                        ? 'text-(--warning) border-b-2 border-(--warning)/60'
                        : 'text-(--muted-foreground)'
                    }`}
                  >
                    {s}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {symbols.map(from => {
              const isOutlierRow = outlierSet.has(from);
              const rowBg = isOutlierRow ? 'bg-(--warning)/[0.04]' : '';
              return (
                <tr key={from} className={rowBg}>
                  <td
                    className={`sticky left-0 z-10 border-t border-r border-(--border) px-3 py-3 font-semibold ${
                      isOutlierRow
                        ? 'bg-(--warning)/10 border-l-2 border-l-(--warning)/60'
                        : 'bg-(--background)'
                    }`}
                  >
                    <Link
                      href={`/${from.toLowerCase()}`}
                      className={`hover:underline ${isOutlierRow ? 'text-(--warning)' : ''}`}
                    >
                      {from}
                    </Link>
                  </td>
                  {symbols.map(to => {
                    if (from === to) {
                      return (
                        <td key={to} className="px-1 py-1 border-t border-(--border)">
                          <div className="h-16 min-w-24 flex items-center justify-center bg-(--muted) rounded text-(--muted-foreground) text-xs">
                            -
                          </div>
                        </td>
                      );
                    }
                    const cell = lookup.get(`${from}→${to}`);
                    return (
                      <td key={to} className="px-1 py-1 border-t border-(--border)">
                        <Cell entry={cell} />
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-(--muted-foreground) sm:hidden">
        Tip: scroll horizontally to view all stables. The leftmost column stays pinned.
      </p>
    </section>
  );
}

function Cell({ entry }: { entry: ConvergenceCrossRate | undefined }) {
  if (!entry) {
    return (
      <div className="h-16 min-w-24 flex items-center justify-center text-(--muted-foreground) text-xs">
        n/a
      </div>
    );
  }
  const dev = entry.deviationPct;
  const { bg, fg } = devColor(dev);
  return (
    <div
      className="h-16 min-w-24 rounded flex flex-col items-center justify-center"
      style={{ backgroundColor: bg, color: fg }}
      title={`Implied: ${entry.impliedRate.toFixed(6)} · ${dev >= 0 ? '+' : ''}${dev.toFixed(3)}%`}
    >
      <div className="font-mono font-semibold tabular-nums text-sm">
        {dev >= 0 ? '+' : ''}{dev.toFixed(2)}%
      </div>
      <div className="font-mono text-[10px] opacity-80 tabular-nums">
        {entry.impliedRate.toFixed(4)}
      </div>
    </div>
  );
}

/**
 * Color scale: green → yellow → red, intensity based on |deviation|.
 * Sign of deviation determines hue direction (green-leaning for ≤ 0, red-leaning for > 0).
 *
 * Bands:
 *   |dev| < 0.25%   → near-parity (green)
 *   |dev| < 1.0%    → drift (amber)
 *   |dev| ≥ 1.0%    → outlier (red)
 */
function devColor(dev: number): { bg: string; fg: string } {
  const abs = Math.abs(dev);
  // Light-mode-tuned: higher opacity for visibility on warm-off-white,
  // darker fg (Tailwind 800-tier) for readable text on tinted bg.
  if (abs < 0.25)  return { bg: 'rgba(22, 163, 74, 0.14)',  fg: '#166534' };  // green-800
  if (abs < 0.5)   return { bg: 'rgba(22, 163, 74, 0.08)',  fg: '#166534' };
  if (abs < 1.0)   return { bg: 'rgba(217, 119, 6, 0.14)',  fg: '#854d0e' };  // amber-800
  if (abs < 2.0)   return { bg: 'rgba(217, 119, 6, 0.24)',  fg: '#713f12' };  // amber-900
  if (abs < 5.0)   return { bg: 'rgba(220, 38, 38, 0.18)',  fg: '#991b1b' };  // red-800
  return            { bg: 'rgba(220, 38, 38, 0.32)',  fg: '#7f1d1d' };       // red-900
}

function Legend() {
  const bands: Array<{ label: string; bg: string }> = [
    { label: '< 0.25%',  bg: 'rgba(22, 163, 74, 0.14)' },
    { label: '< 1%',     bg: 'rgba(217, 119, 6, 0.14)' },
    { label: '< 2%',     bg: 'rgba(217, 119, 6, 0.24)' },
    { label: '< 5%',     bg: 'rgba(220, 38, 38, 0.18)' },
    { label: '≥ 5%',     bg: 'rgba(220, 38, 38, 0.32)' },
  ];
  return (
    <div className="flex items-center gap-2 text-xs text-(--muted-foreground)">
      <span className="hidden sm:inline">|deviation|</span>
      {bands.map(b => (
        <span key={b.label} className="flex items-center gap-1">
          <span
            className="inline-block w-3 h-3 rounded-sm border border-(--border)"
            style={{ backgroundColor: b.bg }}
          />
          <span>{b.label}</span>
        </span>
      ))}
    </div>
  );
}

function SnapshotTable({ data }: { data: ConvergenceResult }) {
  return (
    <section className="border border-(--border) rounded-lg p-5">
      <h2 className="font-semibold mb-3">Input snapshot</h2>
      <p className="text-sm text-(--muted-foreground) mb-3">
        ADA-X aggregated price per stable used as input to the matrix.
        Computed at {new Date(data.computedAt).toLocaleString()}.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-(--muted-foreground)">
              <th className="px-3 py-2 font-medium">Symbol</th>
              <th className="px-3 py-2 font-medium text-right">ADA price</th>
              <th className="px-3 py-2 font-medium text-right">Implied USD per stable</th>
            </tr>
          </thead>
          <tbody>
            {data.adaPrices.map(({ symbol, adaPrice }) => {
              // ADA-stable median across the basket gives an implicit ADA-USD;
              // implied USD value of the stable = adaPrice (X per ADA) → 1 X = (1 / adaPrice) ADA.
              // Caller can compare across rows for visual sanity-check.
              return (
                <tr key={symbol} className="border-t border-(--border)">
                  <td className="px-3 py-2 font-semibold">
                    <Link href={`/${symbol.toLowerCase()}`} className="hover:underline">
                      {symbol}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    {adaPrice.toFixed(6)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-(--muted-foreground)">
                    {adaPrice > 0 ? `1 ${symbol} ≈ ${(1 / adaPrice).toFixed(4)} ADA` : '-'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Methodology() {
  return (
    <section className="border border-(--border) rounded-lg p-5">
      <h2 className="font-semibold mb-3">Methodology</h2>
      <ul className="space-y-2 text-sm text-(--muted-foreground)">
        <li>
          For each pair (A, B): <code className="font-mono text-xs bg-(--muted) px-1 py-0.5 rounded">impliedRate = ADA-B / ADA-A</code>,
          the price of B in units of A, derived through the ADA pivot.
        </li>
        <li>
          <code className="font-mono text-xs bg-(--muted) px-1 py-0.5 rounded">deviationPct = (impliedRate − 1.0) × 100</code>: distance from theoretical parity.
        </li>
        <li>
          A stable is flagged as an <strong className="text-(--foreground)">outlier</strong> if its <em>median</em> |deviation| against the rest of the basket exceeds 1% (warning band, configurable).
          Median is robust to a single rogue counterparty.
        </li>
        <li>
          <code className="font-mono text-xs bg-(--muted) px-1 py-0.5 rounded">convergenceScore = max(0, min(1, 1 − maxDev/5))</code>: 1.0 if every cross-rate sits at parity, 0.0 if any crosses ≥ 5% off-peg.
        </li>
        <li>
          The matrix is symmetric: <code className="font-mono text-xs bg-(--muted) px-1 py-0.5 rounded">deviation(A,B) ≈ −deviation(B,A)</code> modulo float-rounding.
          Both directions are surfaced so consumers can index by either side.
        </li>
      </ul>
    </section>
  );
}
