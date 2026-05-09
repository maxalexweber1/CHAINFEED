import Link from 'next/link';
import { LogoMark } from '@/components/logo';
import {
  getStableHealth,
  getFluidtokensHealth,
  getLiqwidHealth,
  formatBps,
  formatUsd,
  describeAlert,
  bucketColor,
  fluidStableLabel,
  isFluidStable,
  rawToWhole,
  SUPPORTED_STABLES,
  type StableHealthResult,
  type SupportedStable,
  type FluidHealthResult,
  type FluidAssetRollup,
  type LiqwidHealthResult,
  type LiqwidMarketRollup,
} from '@/lib/chainfeed-client';

// Refresh the cards every 5 min. RSC + ISR — no client-side polling.
// Aligned with the FluidTokens adapter cache (300s) to keep Blockfrost cost
// bounded; peg + reserves don't move at sub-minute cadence anyway.
export const revalidate = 300;

interface FetchSlot {
  symbol: SupportedStable;
  data: StableHealthResult | null;
  error: string | null;
}

async function loadAll(): Promise<FetchSlot[]> {
  return Promise.all(
    SUPPORTED_STABLES.map(async (symbol) => {
      try {
        const data = await getStableHealth(symbol, { revalidateSec: 30 });
        return { symbol, data, error: null };
      } catch (e) {
        return { symbol, data: null, error: (e as Error).message };
      }
    }),
  );
}

async function loadFluidHealth(): Promise<{ data: FluidHealthResult | null; error: string | null }> {
  try {
    const data = await getFluidtokensHealth({ revalidateSec: 60 });
    return { data, error: null };
  } catch (e) {
    return { data: null, error: (e as Error).message };
  }
}

async function loadLiqwidHealth(): Promise<{ data: LiqwidHealthResult | null; error: string | null }> {
  try {
    const data = await getLiqwidHealth({ revalidateSec: 60 });
    return { data, error: null };
  } catch (e) {
    return { data: null, error: (e as Error).message };
  }
}

export default async function HomePage() {
  const [slots, fluid, liqwid] = await Promise.all([loadAll(), loadFluidHealth(), loadLiqwidHealth()]);

  return (
    <div className="space-y-10">
      <Hero slots={slots} />
      <section>
        <div className="flex items-baseline justify-between mb-4">
          <h2 className="text-lg font-semibold">Cardano-native stables</h2>
          <span className="text-sm text-(--muted-foreground) flex items-center gap-2">
            <LiveDot /> Refreshes every 5 min · {SUPPORTED_STABLES.length} stables tracked
          </span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {slots.map((slot) => (
            <StableCard key={slot.symbol} slot={slot} />
          ))}
        </div>
      </section>

      <LendingMarkets fluid={fluid} liqwid={liqwid} />

      <ApiTeaser />
    </div>
  );
}

function Hero({ slots }: { slots: FetchSlot[] }) {
  // Average peg quality across the loaded stables — drives the "system OK"
  // badge under the headline. Vacuously healthy if no data loaded yet.
  const loaded = slots.filter(s => s.data?.pegDeviationBps !== null && s.data?.pegDeviationBps !== undefined);
  const avgAbs = loaded.length > 0
    ? loaded.reduce((sum, s) => sum + Math.abs(s.data!.pegDeviationBps!), 0) / loaded.length
    : 0;
  const systemBadge =
    avgAbs < 50 ? { label: 'All stables on peg', color: 'text-(--healthy)', dot: 'bg-(--healthy)' } :
      avgAbs < 200 ? { label: 'Minor peg drift detected', color: 'text-(--warning)', dot: 'bg-(--warning)' } :
        { label: 'Peg break detected', color: 'text-(--critical)', dot: 'bg-(--critical)' };

  return (
    <section className="border border-(--border) rounded-lg overflow-hidden hero-mesh">
      <div className="px-5 sm:px-8 lg:px-10 pt-8 sm:pt-10 pb-6 sm:pb-8">
        {/* Brand block — composed inline from <LogoMark> + two-tone wordmark
            so it stays transparent over the hero gradient (the source PNG
            had a baked-in white background). */}
        <div className="flex items-center gap-3 sm:gap-4 lg:gap-5 -ml-1">
          <LogoMark className="w-16 h-16 sm:w-20 sm:h-20 lg:w-24 lg:h-24 shrink-0" />
          <div className="min-w-0">
            <div className="flex items-baseline gap-1.5 sm:gap-2 leading-none">
              <span className="text-[2rem] sm:text-5xl lg:text-6xl font-bold tracking-tight text-(--accent)">
                CHAIN
              </span>
              <span className="text-[2rem] sm:text-5xl lg:text-6xl font-bold tracking-tight text-(--accent-soft)">
                FEED
              </span>
            </div>
            <p className="mt-1.5 text-[10px] sm:text-xs tracking-[0.2em] uppercase text-(--accent-soft) font-medium">
              On-chain aggregation for Cardano
            </p>
          </div>
        </div>

        <div className="mt-6 flex items-center gap-2 text-xs uppercase tracking-wider text-(--muted-foreground)">
          <LiveDot />
          <span>Live · {loaded.length}/{slots.length} stables online</span>
        </div>
        <h1 className="mt-3 text-[2rem] sm:text-4xl lg:text-5xl font-bold tracking-tight max-w-3xl leading-[1.1]">
          The Cardano stablecoin
          <br />
          <span className="bg-gradient-to-r from-(--accent) to-(--accent-soft) bg-clip-text text-transparent">
            transparency layer.
          </span>
        </h1>
        <p className="mt-5 text-(--muted-foreground) max-w-2xl text-base sm:text-lg leading-relaxed">
          Live peg, reserves, executable depth, risk score, and lending-market
          state for every Cardano-native stablecoin. Free public reads.
          Pay-per-call API for agents. Gated by{' '}
          <Link href="/developers" className="text-(--accent) hover:underline whitespace-nowrap">
            x402 USDM micropayments
          </Link>
          . No accounts, no API keys.
        </p>

        <div className="mt-6 flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className={`inline-flex items-center gap-2 text-sm font-medium ${systemBadge.color}`}>
            <span className={`w-2 h-2 rounded-full ${systemBadge.dot}`} />
            {systemBadge.label}
          </span>
          <span className="text-(--muted-foreground) hidden sm:inline">·</span>
          <span className="text-sm text-(--muted-foreground)">
            Average |dev| {avgAbs.toFixed(1)} bps
          </span>
          <span className="text-(--muted-foreground) hidden sm:inline">·</span>
          <Link href="/compare" className="text-sm text-(--accent) hover:underline">
            Cross-stable matrix →
          </Link>
        </div>
      </div>

      <Ticker slots={slots} />
    </section>
  );
}

function LiveDot() {
  return (
    <span className="relative inline-flex items-center justify-center w-2.5 h-2.5">
      <span className="absolute inline-flex w-full h-full rounded-full bg-(--accent) opacity-50 pulse-ring" />
      <span className="relative inline-flex w-2 h-2 rounded-full bg-(--accent) pulse-dot" />
    </span>
  );
}

/**
 * CSS-only marquee. The track contains the same content twice; we
 * translateX(-50%) over the animation duration which lines the second
 * copy up perfectly with the first frame, producing a seamless loop.
 *
 * Hover anywhere on the strip pauses the animation so users can read.
 */
function Ticker({ slots }: { slots: FetchSlot[] }) {
  const items = slots.filter(s => s.data !== null).map(s => ({
    symbol: s.symbol,
    price: s.data!.price.value,
    bps: s.data!.pegDeviationBps,
    risk: s.data!.risk.score,
  }));
  if (items.length === 0) return null;

  // Duplicate so the marquee can loop seamlessly. Use a key with a "dup"
  // suffix so React's reconciler doesn't complain about duplicate keys.
  const doubled = [...items, ...items.map(i => ({ ...i, _dup: true }))];

  return (
    <div className="border-t border-(--border) bg-(--background)/40 backdrop-blur-sm overflow-hidden ticker-pause">
      <div className="ticker-track inline-flex whitespace-nowrap py-3">
        {doubled.map((item, idx) => (
          <TickerItem key={`${item.symbol}-${idx}`} {...item} />
        ))}
      </div>
    </div>
  );
}

function TickerItem({
  symbol, price, bps, risk,
}: {
  symbol: string;
  price: number | null;
  bps: number | null;
  risk: number;
}) {
  const bpsColor =
    bps === null ? 'text-(--muted-foreground)' :
      Math.abs(bps) < 50 ? 'text-(--healthy)' :
        Math.abs(bps) < 200 ? 'text-(--warning)' :
          'text-(--critical)';
  const riskColor =
    risk >= 0.85 ? 'text-(--healthy)' :
      risk >= 0.6 ? 'text-(--warning)' :
        'text-(--critical)';

  return (
    <div className="inline-flex items-center gap-2 px-6 text-sm border-r border-(--border)/60 last:border-r-0">
      <span className="font-bold">{symbol}</span>
      <span className="text-(--muted-foreground) font-mono tabular-nums text-xs">
        {price !== null ? `$${price.toFixed(4)}` : '-'}
      </span>
      <span className={`font-mono tabular-nums text-xs font-semibold ${bpsColor}`}>
        {bps === null ? '-' : `${bps >= 0 ? '+' : ''}${bps.toFixed(1)}bps`}
      </span>
      <span className={`text-xs ${riskColor}`}>
        risk {risk.toFixed(2)}
      </span>
    </div>
  );
}

function StableCard({ slot }: { slot: FetchSlot }) {
  const { symbol, data, error } = slot;
  if (error || !data) {
    return (
      <Link
        href={`/${symbol.toLowerCase()}`}
        className="block border border-(--border) rounded-lg p-5 hover:border-(--muted-foreground) transition-colors"
      >
        <div className="flex items-baseline justify-between">
          <span className="font-bold text-lg">{symbol}</span>
          <span className="text-xs text-(--critical)">offline</span>
        </div>
        <p className="mt-2 text-sm text-(--muted-foreground) line-clamp-2">
          {error?.slice(0, 120) ?? 'no data'}
        </p>
      </Link>
    );
  }

  const { metadata, price, reserves, risk, pegDeviationBps, alerts } = data;
  const pegStatus = pegDeviationStatus(pegDeviationBps);

  return (
    <Link
      href={`/${symbol.toLowerCase()}`}
      className="block border border-(--border) rounded-lg p-5 hover:border-(--muted-foreground) transition-colors"
    >
      <div className="flex items-baseline justify-between">
        <span className="font-bold text-lg">{symbol}</span>
        <span className="text-xs text-(--muted-foreground)">
          {metadata.issuerName}
        </span>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
        <Stat
          label="Price"
          value={price.value !== null ? formatUsd(price.value, 4) : '-'}
        />
        <Stat
          label="Peg dev"
          value={formatBps(pegDeviationBps)}
          accent={pegStatus.color}
        />
        <Stat
          label="Reserves"
          value={
            reserves.available
              ? `${reserves.value !== null ? reserves.value.toLocaleString(undefined, { maximumFractionDigits: 0, useGrouping: false }) : '-'} ${reserves.unit === 'ratio_pct' ? '%' :
                reserves.unit === 'usd' ? 'USD' :
                  ''
              }`
              : 'n/a'
          }
          accent={bucketColor(reserves.healthBucket)}
        />
        <Stat
          label="Risk score"
          value={risk.score.toFixed(2)}
          accent={riskColor(risk.score)}
        />
      </div>

      {alerts.length > 0 && (
        <ul className="mt-4 flex flex-wrap gap-1.5">
          {alerts.slice(0, 3).map((a) => {
            const desc = describeAlert(a);
            return (
              <li
                key={a}
                className={`text-xs px-2 py-0.5 rounded border ${desc.severity === 'critical' ? 'border-(--critical) text-(--critical)' :
                    desc.severity === 'warning' ? 'border-(--warning) text-(--warning)' :
                      'border-(--border) text-(--muted-foreground)'
                  }`}
              >
                {desc.label}
              </li>
            );
          })}
          {alerts.length > 3 && (
            <li className="text-xs px-2 py-0.5 rounded border border-(--border) text-(--muted-foreground)">
              +{alerts.length - 3} more
            </li>
          )}
        </ul>
      )}

      <div className="mt-4 pt-3 border-t border-(--border) text-xs text-(--muted-foreground) flex items-center justify-between">
        <span>{metadata.backing}</span>
        <span>
          {price.sourcesUsed ?? 0} source{price.sourcesUsed === 1 ? '' : 's'}
          {price.confidence !== null && ` · conf ${(price.confidence * 100).toFixed(0)}%`}
        </span>
      </div>
    </Link>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: string;
}) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-(--muted-foreground)">
        {label}
      </div>
      <div className={`mt-0.5 font-semibold ${accent ?? ''}`}>{value}</div>
    </div>
  );
}

function pegDeviationStatus(bps: number | null): { color: string } {
  if (bps === null) return { color: 'text-(--muted-foreground)' };
  const abs = Math.abs(bps);
  if (abs < 50) return { color: 'text-(--healthy)' };
  if (abs < 200) return { color: 'text-(--warning)' };
  return { color: 'text-(--critical)' };
}

function riskColor(score: number): string {
  if (score >= 0.85) return 'text-(--healthy)';
  if (score >= 0.6) return 'text-(--warning)';
  return 'text-(--critical)';
}

function LendingMarkets({
  fluid,
  liqwid,
}: {
  fluid:  { data: FluidHealthResult  | null; error: string | null };
  liqwid: { data: LiqwidHealthResult | null; error: string | null };
}) {
  return (
    <section>
      <div className="mb-6">
        <h2 className="text-lg font-semibold">Lending markets</h2>
        <p className="mt-1 text-sm text-(--muted-foreground)">
          Live state on Cardano lending protocols. On-chain UTxO reads with audited contract math.
        </p>
      </div>

      <div className="space-y-8">
        <FluidProtocolBlock fluid={fluid} />
        <LiqwidProtocolBlock liqwid={liqwid} />
      </div>
    </section>
  );
}

function FluidProtocolBlock({
  fluid,
}: {
  fluid: { data: FluidHealthResult | null; error: string | null };
}) {
  const stableRollups: FluidAssetRollup[] = (fluid.data?.perAsset ?? []).filter(r =>
    isFluidStable(r.assetKey),
  );
  const sorted = [...stableRollups].sort(
    (a, b) => b.loanCount - a.loanCount || b.poolCount - a.poolCount,
  );

  const totalStableLoans = sorted.reduce((s, r) => s + r.loanCount, 0);
  const liquidatable     = sorted.reduce((s, r) => s + r.liquidatable, 0);

  // Whole-unit aggregates (all in-scope stables are 6-decimal, peg ≈ $1, so
  // summing across DJED/iUSD/USDM/USDA/USDCx is acceptable for a $-rough view).
  const totalSuppliedWhole = sorted.reduce(
    (s, r) => s + rawToWhole(r.poolsAvailableRaw, 6) + rawToWhole(r.outstandingPrincipalRaw, 6), 0);
  const totalBorrowedWhole = sorted.reduce(
    (s, r) => s + rawToWhole(r.outstandingPrincipalRaw, 6), 0);
  const avgUtilization = totalSuppliedWhole > 0 ? totalBorrowedWhole / totalSuppliedWhole : 0;

  return (
    <div>
      <div className="flex items-baseline justify-between mb-3 flex-wrap gap-y-2">
        <h3 className="font-semibold">
          <a
            href="https://app.fluidtokens.com/lending"
            target="_blank"
            rel="noreferrer"
            className="text-(--accent) hover:underline"
          >
            FluidTokens v3
          </a>
          <span className="ml-2 text-xs font-normal text-(--muted-foreground)">peer-to-peer pools + loans</span>
        </h3>
        <span className="text-xs text-(--muted-foreground) flex items-center gap-2">
          <LiveDot /> {totalStableLoans} active stable loans
        </span>
      </div>

      {fluid.error || !fluid.data ? (
        <div className="border border-(--border) rounded-lg p-5 text-sm text-(--muted-foreground)">
          FluidTokens data temporarily unavailable
          {fluid.error && (
            <span className="block mt-1 text-xs opacity-60">
              {fluid.error.slice(0, 160)}
            </span>
          )}
        </div>
      ) : sorted.length === 0 ? (
        <div className="border border-(--border) rounded-lg p-5 text-sm text-(--muted-foreground)">
          No active stable-asset pools detected on FluidTokens v3 right now.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <SummaryStat
              label="Total supplied"
              value={totalSuppliedWhole.toLocaleString(undefined, { maximumFractionDigits: 0, useGrouping: false })}
            />
            <SummaryStat
              label="Total borrowed"
              value={totalBorrowedWhole.toLocaleString(undefined, { maximumFractionDigits: 0, useGrouping: false })}
            />
            <SummaryStat
              label="Avg utilization"
              value={`${(avgUtilization * 100).toFixed(1)}%`}
            />
            <SummaryStat
              label="Liquidatable"
              value={liquidatable.toString()}
              accent={liquidatable > 0 ? 'text-(--critical)' : 'text-(--healthy)'}
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {sorted.map((r) => (
              <FluidAssetCard key={r.assetKey} rollup={r} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function SummaryStat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: string;
}) {
  return (
    <div className="border border-(--border) rounded-lg px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-(--muted-foreground)">
        {label}
      </div>
      <div className={`mt-0.5 text-base font-semibold tabular-nums ${accent ?? ''}`}>
        {value}
      </div>
    </div>
  );
}

function FluidAssetCard({ rollup }: { rollup: FluidAssetRollup }) {
  const ticker = fluidStableLabel(rollup.assetKey) ?? rollup.assetKey.slice(0, 6);
  // Stables tracked here are all 6-decimal — divide raw units uniformly.
  const availableWhole   = rawToWhole(rollup.poolsAvailableRaw, 6);
  const outstandingWhole = rawToWhole(rollup.outstandingPrincipalRaw, 6);
  const debtWhole        = rawToWhole(rollup.currentDebtRaw, 6);
  const accruedDelta     = debtWhole - outstandingWhole;

  const liquidatable = rollup.liquidatable;
  const late         = rollup.late;
  const status =
    liquidatable > 0 ? { label: 'Liquidatable loans', tone: 'text-(--critical)' } :
      late > 0       ? { label: 'Late loans',          tone: 'text-(--warning)'  } :
                       { label: 'Healthy',              tone: 'text-(--healthy)'  };

  return (
    <div className="border border-(--border) rounded-lg p-5">
      <div className="flex items-baseline justify-between">
        <span className="font-bold text-lg">{ticker}</span>
        <span className={`text-xs ${status.tone}`}>{status.label}</span>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
        <Stat
          label="Pools"
          value={`${rollup.poolCount}${rollup.permissionedPoolCount > 0 ? ` · ${rollup.permissionedPoolCount} KYC` : ''}`}
        />
        <Stat label="Loans" value={rollup.loanCount.toString()} />
        <Stat
          label="Available to borrow"
          value={availableWhole > 0 ? `${availableWhole.toLocaleString(undefined, { maximumFractionDigits: 0, useGrouping: false })} ${ticker}` : '-'}
        />
        <Stat
          label="Outstanding"
          value={outstandingWhole > 0 ? `${outstandingWhole.toLocaleString(undefined, { maximumFractionDigits: 0, useGrouping: false })} ${ticker}` : '-'}
        />
      </div>
      {accruedDelta > 0 && (
        <div className="mt-3 pt-3 border-t border-(--border) text-xs text-(--muted-foreground)">
          Accrued interest:{' '}
          <span className="font-mono tabular-nums">
            +{accruedDelta.toLocaleString(undefined, { maximumFractionDigits: 2, useGrouping: false })} {ticker}
          </span>
        </div>
      )}
    </div>
  );
}

function LiqwidProtocolBlock({
  liqwid,
}: {
  liqwid: { data: LiqwidHealthResult | null; error: string | null };
}) {
  const markets = liqwid.data?.perMarket ?? [];
  const sorted = [...markets].sort((a, b) =>
    Number(BigInt(b.totalSuppliedRaw) - BigInt(a.totalSuppliedRaw)),
  );

  const totalSuppliedWhole = sorted.reduce(
    (s, r) => s + rawToWhole(r.totalSuppliedRaw, r.decimals), 0);
  const totalBorrowedWhole = sorted.reduce(
    (s, r) => s + rawToWhole(r.principalRaw, r.decimals), 0);
  const avgUtilization = sorted.length > 0
    ? sorted.reduce((s, r) => s + r.utilization, 0) / sorted.length
    : 0;
  // Liqwid is pool-based: no per-loan liquidation tracking. Flag markets at
  // high utilization (>= 90%) as "at risk" — borrowers can't easily exit,
  // suppliers may face withdrawal queues. Same column position as
  // FluidTokens' Liquidatable for visual parity across the two protocols.
  const atRiskCount = sorted.filter(m => m.utilization >= 0.9).length;

  return (
    <div>
      <div className="flex items-baseline justify-between mb-3 flex-wrap gap-y-2">
        <h3 className="font-semibold">
          <a
            href="https://app.liqwid.finance"
            target="_blank"
            rel="noreferrer"
            className="text-(--accent) hover:underline"
          >
            Liqwid v2
          </a>
          <span className="ml-2 text-xs font-normal text-(--muted-foreground)">pool-based qToken markets</span>
        </h3>
        <span className="text-xs text-(--muted-foreground) flex items-center gap-2">
          <LiveDot /> {sorted.length} stable markets
        </span>
      </div>

      {liqwid.error || !liqwid.data ? (
        <div className="border border-(--border) rounded-lg p-5 text-sm text-(--muted-foreground)">
          Liqwid data temporarily unavailable
          {liqwid.error && (
            <span className="block mt-1 text-xs opacity-60">
              {liqwid.error.slice(0, 160)}
            </span>
          )}
        </div>
      ) : sorted.length === 0 ? (
        <div className="border border-(--border) rounded-lg p-5 text-sm text-(--muted-foreground)">
          No active stable markets detected on Liqwid right now.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <SummaryStat
              label="Total supplied"
              value={totalSuppliedWhole.toLocaleString(undefined, { maximumFractionDigits: 0, useGrouping: false })}
            />
            <SummaryStat
              label="Total borrowed"
              value={totalBorrowedWhole.toLocaleString(undefined, { maximumFractionDigits: 0, useGrouping: false })}
            />
            <SummaryStat
              label="Avg utilization"
              value={`${(avgUtilization * 100).toFixed(1)}%`}
            />
            <SummaryStat
              label="At risk"
              value={atRiskCount.toString()}
              accent={atRiskCount > 0 ? 'text-(--critical)' : 'text-(--healthy)'}
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {sorted.map((m) => (
              <LiqwidMarketCard key={m.symbol} market={m} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function LiqwidMarketCard({ market }: { market: LiqwidMarketRollup }) {
  const supplied = rawToWhole(market.totalSuppliedRaw, market.decimals);
  const borrowed = rawToWhole(market.principalRaw, market.decimals);
  const utilPct = market.utilization * 100;

  return (
    <div className="border border-(--border) rounded-lg p-5">
      <div className="flex items-baseline justify-between">
        <span className="font-bold text-lg">{market.symbol}</span>
        <span className="text-xs text-(--muted-foreground)">
          q{market.symbol} pool
        </span>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
        <Stat
          label="Supplied"
          value={`${supplied.toLocaleString(undefined, { maximumFractionDigits: 0, useGrouping: false })} ${market.symbol}`}
        />
        <Stat
          label="Borrowed"
          value={`${borrowed.toLocaleString(undefined, { maximumFractionDigits: 0, useGrouping: false })} ${market.symbol}`}
        />
        <Stat
          label="Utilization"
          value={`${utilPct.toFixed(1)}%`}
          accent={utilPct > 90 ? 'text-(--warning)' : undefined}
        />
        <Stat
          label="qToken rate"
          value={market.qTokenRate.toFixed(6)}
        />
      </div>
      {(market.supplyAPY !== null || market.borrowAPY !== null) && (
        <div className="mt-3 pt-3 border-t border-(--border) grid grid-cols-2 gap-3 text-xs">
          <div>
            <div className="uppercase tracking-wide text-(--muted-foreground)">
              Supply APY
            </div>
            <div className="mt-0.5 font-mono tabular-nums text-(--healthy)">
              {market.supplyAPY !== null ? `${(market.supplyAPY * 100).toFixed(2)}%` : '-'}
            </div>
          </div>
          <div>
            <div className="uppercase tracking-wide text-(--muted-foreground)">
              Borrow APY
            </div>
            <div className="mt-0.5 font-mono tabular-nums">
              {market.borrowAPY !== null ? `${(market.borrowAPY * 100).toFixed(2)}%` : '-'}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ApiTeaser() {
  return (
    <section className="grid grid-cols-1 md:grid-cols-2 gap-6">
      <div className="border border-(--border) rounded-lg p-6">
        <h3 className="font-semibold text-lg">Built for AI agents</h3>
        <p className="mt-2 text-sm text-(--muted-foreground)">
          Pay-per-call in USDM micropayments. No API keys, no accounts.
          Your agent settles 0.01 USDM on Cardano per call and gets a
          verifiable response with on-chain provenance. Prices, reserves,
          lending-market state, the lot.
        </p>
        <Link
          href="/agents"
          className="mt-4 inline-block text-sm text-(--accent) hover:underline"
        >
          Agentic patterns →
        </Link>
      </div>
      <div className="border border-(--border) rounded-lg p-6">
        <h3 className="font-semibold text-lg">Verifiable end-to-end</h3>
        <p className="mt-2 text-sm text-(--muted-foreground)">
          Every response ships with on-chain tx hashes, datum-decoding
          source code, and hash-sealed off-chain artifacts. Download an
          audit pack and re-verify against any Cardano node.
        </p>
        <Link
          href="/trust"
          className="mt-4 inline-block text-sm text-(--accent) hover:underline"
        >
          How verification works →
        </Link>
      </div>
    </section>
  );
}
