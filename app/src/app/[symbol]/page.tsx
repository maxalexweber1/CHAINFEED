import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  getStableHealth,
  getOhlcv,
  getFluidtokensHealth,
  getLiqwidHealth,
  mergePegDeviationBuckets,
  fluidKeyForSymbol,
  rawToWhole,
  formatBps,
  formatUsd,
  formatAda,
  formatPct,
  describeAlert,
  bucketColor,
  reservesPairFor,
  SUPPORTED_STABLES,
  type SupportedStable,
  type FluidAssetRollup,
  type LiqwidMarketRollup,
} from '@/lib/chainfeed-client';
import { OhlcvChart } from './ohlcv-chart';
import { PegDevChart } from './peg-dev-chart';

export const revalidate = 300;

export function generateStaticParams() {
  return SUPPORTED_STABLES.map((symbol) => ({ symbol: symbol.toLowerCase() }));
}

function resolveSymbol(slug: string): SupportedStable | null {
  const upper = slug.toUpperCase();
  for (const s of SUPPORTED_STABLES) {
    if (s.toUpperCase() === upper) return s;
  }
  return null;
}

export default async function DetailPage({
  params,
}: {
  params: Promise<{ symbol: string }>;
}) {
  const { symbol: slug } = await params;
  const symbol = resolveSymbol(slug);
  if (!symbol) notFound();

  const [healthRes, ohlcvRes, adaUsdOhlcvRes, fluidRes, liqwidRes] = await Promise.allSettled([
    getStableHealth(symbol),
    getOhlcv(`ADA-${symbol}`, '1h', 24),
    getOhlcv('ADA-USD', '1h', 24),
    getFluidtokensHealth({ revalidateSec: 60 }),
    getLiqwidHealth({ revalidateSec: 60 }),
  ]);

  if (healthRes.status === 'rejected') {
    return (
      <div className="space-y-4">
        <Link href="/" className="text-sm text-(--accent) hover:underline">← All stables</Link>
        <h1 className="text-2xl font-bold">{symbol}</h1>
        <div className="border border-(--critical) rounded-lg p-6 text-(--critical)">
          Failed to load health: {healthRes.reason?.message ?? 'unknown'}
        </div>
      </div>
    );
  }

  const data = healthRes.value;
  const candles = ohlcvRes.status === 'fulfilled' ? ohlcvRes.value.candles : [];
  // Peg-deviation buckets — joined client-side from the two OHLCV pulls.
  // Skips buckets where either side has no observation (gap-honest).
  const pegBuckets =
    ohlcvRes.status === 'fulfilled' && adaUsdOhlcvRes.status === 'fulfilled'
      ? mergePegDeviationBuckets(ohlcvRes.value.candles, adaUsdOhlcvRes.value.candles)
      : [];

  // Filter lending data to this stable. Both Fluid + Liqwid endpoints return
  // multi-asset rollups; we narrow to the symbol on the page.
  const fluidKey = fluidKeyForSymbol(symbol);
  const fluidRollup: FluidAssetRollup | null =
    fluidRes.status === 'fulfilled' && fluidKey
      ? fluidRes.value.perAsset.find(r => r.assetKey === fluidKey) ?? null
      : null;
  const liqwidMarket: LiqwidMarketRollup | null =
    liqwidRes.status === 'fulfilled'
      ? liqwidRes.value.perMarket.find(m => m.symbol.toUpperCase() === symbol.toUpperCase()) ?? null
      : null;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <Link href="/" className="text-sm text-(--accent) hover:underline">← All stables</Link>
          <h1 className="text-3xl font-bold tracking-tight">{symbol}</h1>
          <span className="text-sm text-(--muted-foreground)">{data.metadata.issuerName}</span>
        </div>
        <span className="text-xs text-(--muted-foreground)">
          Computed {new Date(data.computedAt).toLocaleTimeString()} · refresh 30s
        </span>
      </div>

      {data.alerts.length > 0 && <AlertStrip alerts={data.alerts} />}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <PriceBlock data={data} />
        <ReservesBlock data={data} />
        <RiskBlock data={data} />
      </div>

      <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="border border-(--border) rounded-lg p-5">
          <div className="flex items-baseline justify-between mb-4">
            <h2 className="font-semibold">ADA-{symbol} price · 24h</h2>
            <span className="text-xs text-(--muted-foreground)">
              {candles.length} bucket{candles.length === 1 ? '' : 's'}
            </span>
          </div>
          {candles.length > 0 ? (
            <OhlcvChart candles={candles} />
          ) : (
            <div className="h-64 flex items-center justify-center text-sm text-(--muted-foreground)">
              No history available yet for this pair on the configured network.
            </div>
          )}
        </div>

        <div className="border border-(--border) rounded-lg p-5">
          <div className="flex items-baseline justify-between mb-4">
            <h2 className="font-semibold">Peg deviation · 24h</h2>
            <span className="text-xs text-(--muted-foreground)">
              {pegBuckets.length} matched bucket{pegBuckets.length === 1 ? '' : 's'}
            </span>
          </div>
          {pegBuckets.length > 0 ? (
            <>
              <PegDevChart buckets={pegBuckets} />
              <div className="mt-3 flex items-center gap-3 text-xs text-(--muted-foreground)">
                <span className="flex items-center gap-1">
                  <span className="inline-block w-2 h-2 rounded-sm bg-(--healthy)/30" />
                  ±50 healthy
                </span>
                <span className="flex items-center gap-1">
                  <span className="inline-block w-2 h-2 rounded-sm bg-(--warning)/30" />
                  ±200 warning
                </span>
                <span className="flex items-center gap-1">
                  <span className="inline-block w-2 h-2 rounded-sm bg-(--critical)/30" />
                  beyond critical
                </span>
              </div>
            </>
          ) : (
            <div className="h-64 flex items-center justify-center text-sm text-(--muted-foreground) text-center px-4">
              Not enough overlapping price history yet. Peg deviation needs both ADA-{symbol} and ADA-USD samples in the same buckets.
            </div>
          )}
        </div>
      </section>

      <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <SupplyBlock data={data} />
        <LiquidityBlock data={data} />
      </section>

      <MetadataBlock data={data} />

      <LendingExposure symbol={symbol} fluid={fluidRollup} liqwid={liqwidMarket} />

      <PaidActions symbol={symbol} />
    </div>
  );
}

// ── Block components ────────────────────────────────────────────────────

import type { StableHealthResult } from '@/lib/chainfeed-client';

function AlertStrip({ alerts }: { alerts: string[] }) {
  return (
    <ul className="flex flex-wrap gap-2">
      {alerts.map((a) => {
        const desc = describeAlert(a);
        return (
          <li
            key={a}
            className={`text-xs px-3 py-1 rounded border ${
              desc.severity === 'critical' ? 'border-(--critical) text-(--critical)' :
              desc.severity === 'warning'  ? 'border-(--warning) text-(--warning)'   :
                                             'border-(--border) text-(--muted-foreground)'
            }`}
          >
            {desc.label}
          </li>
        );
      })}
    </ul>
  );
}

function PriceBlock({ data }: { data: StableHealthResult }) {
  const { price, pegDeviationBps } = data;
  const bps = pegDeviationBps;
  const bpsAbs = bps !== null ? Math.abs(bps) : null;
  const bpsColor = bps === null ? 'text-(--muted-foreground)' :
                   bpsAbs! < 50 ? 'text-(--healthy)' :
                   bpsAbs! < 200 ? 'text-(--warning)' :
                                   'text-(--critical)';

  return (
    <div className="border border-(--border) rounded-lg p-5">
      <h3 className="text-sm uppercase tracking-wide text-(--muted-foreground)">Price</h3>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-3xl font-bold">{price.value !== null ? formatUsd(price.value, 4) : '-'}</span>
        <span className="text-sm text-(--muted-foreground)">per ADA</span>
      </div>
      <div className={`mt-1 text-sm font-semibold ${bpsColor}`}>
        {formatBps(bps)} from peg
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-y-2 text-sm">
        <dt className="text-(--muted-foreground)">Sources</dt>
        <dd className="text-right">{price.sourcesUsed ?? 0}</dd>
        <dt className="text-(--muted-foreground)">Confidence</dt>
        <dd className="text-right">{price.confidence !== null ? `${(price.confidence * 100).toFixed(1)}%` : '-'}</dd>
        <dt className="text-(--muted-foreground)">Spread</dt>
        <dd className="text-right">{formatPct(price.deviationPct)}</dd>
      </dl>
    </div>
  );
}

function ReservesBlock({ data }: { data: StableHealthResult }) {
  const r = data.reserves;
  const symbol = data.metadata.symbol;
  const pair = reservesPairFor(symbol);

  return (
    <div className="border border-(--border) rounded-lg p-5">
      <h3 className="text-sm uppercase tracking-wide text-(--muted-foreground)">Reserves</h3>
      {r.available ? (
        <>
          <div className="mt-2 flex items-baseline gap-2">
            <span className={`text-3xl font-bold ${bucketColor(r.healthBucket)}`}>
              {r.value !== null ? r.value.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '-'}
            </span>
            <span className="text-sm text-(--muted-foreground)">
              {r.unit === 'ratio_pct' ? '% coverage' :
               r.unit === 'usd' ? 'USD attested' :
               r.unit ?? ''}
            </span>
          </div>
          {r.healthBucket && (
            <div className={`mt-1 text-sm font-semibold ${bucketColor(r.healthBucket)}`}>{r.healthBucket}</div>
          )}
          <dl className="mt-4 grid grid-cols-2 gap-y-2 text-sm">
            <dt className="text-(--muted-foreground)">Source</dt>
            <dd className="text-right">{r.source ?? '-'}</dd>
            <dt className="text-(--muted-foreground)">Pair</dt>
            <dd className="text-right">{pair ?? '-'}</dd>
            {r.txHash && (
              <>
                <dt className="text-(--muted-foreground)">On-chain</dt>
                <dd className="text-right">
                  <a
                    href={`https://cardanoscan.io/transaction/${r.txHash}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-(--accent) hover:underline font-mono text-xs"
                  >
                    {r.txHash.slice(0, 12)}…
                  </a>
                </dd>
              </>
            )}
            {r.ageMs !== null && (
              <>
                <dt className="text-(--muted-foreground)">Age</dt>
                <dd className="text-right">{formatAge(r.ageMs)}</dd>
              </>
            )}
          </dl>
        </>
      ) : (
        <p className="mt-2 text-sm text-(--muted-foreground)">
          No public reserves attestation available for this stable today.
        </p>
      )}
    </div>
  );
}

function RiskBlock({ data }: { data: StableHealthResult }) {
  const r = data.risk;
  const score = r.score;
  const scoreColor =
    score >= 0.85 ? 'text-(--healthy)' :
    score >= 0.6  ? 'text-(--warning)' :
                    'text-(--critical)';

  const components = [
    { name: 'Peg confidence',         c: r.pegConfidence },
    { name: 'Reserve adequacy',       c: r.reserveAdequacy },
    { name: 'Attestation freshness',  c: r.attestationFreshness },
    { name: 'Source confidence',      c: r.sourceConfidence },
  ];

  return (
    <div className="border border-(--border) rounded-lg p-5">
      <h3 className="text-sm uppercase tracking-wide text-(--muted-foreground)">Risk score</h3>
      <div className="mt-2 flex items-baseline gap-2">
        <span className={`text-3xl font-bold ${scoreColor}`}>{score.toFixed(2)}</span>
        <span className="text-sm text-(--muted-foreground)">/ 1.00</span>
      </div>
      <ul className="mt-4 space-y-2 text-sm">
        {components.map(({ name, c }) => (
          <li key={name} className="flex items-baseline justify-between gap-3">
            <span className="text-(--muted-foreground)">{name}</span>
            <span className="font-mono text-xs text-(--muted-foreground)">w {c.weight.toFixed(2)}</span>
            <span className="font-semibold tabular-nums">{c.value.toFixed(2)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SupplyBlock({ data }: { data: StableHealthResult }) {
  const s = data.supply;
  return (
    <div className="border border-(--border) rounded-lg p-5">
      <h3 className="text-sm uppercase tracking-wide text-(--muted-foreground)">Supply</h3>
      {s.available ? (
        <dl className="mt-3 grid grid-cols-2 gap-y-2 text-sm">
          <dt className="text-(--muted-foreground)">Total supply</dt>
          <dd className="text-right font-mono tabular-nums">
            {s.totalSupply !== null ? s.totalSupply.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '-'}
          </dd>
          <dt className="text-(--muted-foreground)">Circulating</dt>
          <dd className="text-right font-mono tabular-nums">
            {s.circulatingSupply !== null ? s.circulatingSupply.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '-'}
          </dd>
        </dl>
      ) : (
        <p className="mt-2 text-sm text-(--muted-foreground)">Supply data unavailable.</p>
      )}
    </div>
  );
}

function LiquidityBlock({ data }: { data: StableHealthResult }) {
  const l = data.liquidity;
  return (
    <div className="border border-(--border) rounded-lg p-5">
      <h3 className="text-sm uppercase tracking-wide text-(--muted-foreground)">Executable depth (1% slip)</h3>
      {l.available && l.depthAda !== null ? (
        <>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-3xl font-bold">{formatAda(l.depthAda)}</span>
            {l.depthAtMaxProbed && (
              <span className="text-xs text-(--healthy)">at-max</span>
            )}
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-y-2 text-sm">
            <dt className="text-(--muted-foreground)">Mid price</dt>
            <dd className="text-right font-mono">{l.midPrice !== null ? l.midPrice.toFixed(6) : '-'}</dd>
            <dt className="text-(--muted-foreground)">Probed levels</dt>
            <dd className="text-right">{l.probedPointsCount ?? '-'}</dd>
          </dl>
        </>
      ) : (
        <p className="mt-2 text-sm text-(--muted-foreground)">Liquidity probe unavailable.</p>
      )}
    </div>
  );
}

function LendingExposure({
  symbol,
  fluid,
  liqwid,
}: {
  symbol: SupportedStable;
  fluid:  FluidAssetRollup    | null;
  liqwid: LiqwidMarketRollup  | null;
}) {
  // No exposure means the stable isn't tracked by either protocol (USDA on
  // Liqwid, future expansions). Show a quiet hint rather than an empty section.
  if (!fluid && !liqwid) {
    return (
      <section className="border border-(--border) rounded-lg p-5">
        <h2 className="font-semibold mb-2">Lending exposure</h2>
        <p className="text-sm text-(--muted-foreground)">
          No active lending markets for {symbol} on FluidTokens or Liqwid right now.
        </p>
      </section>
    );
  }

  return (
    <section>
      <div className="mb-4">
        <h2 className="text-lg font-semibold">Lending exposure</h2>
        <p className="mt-1 text-sm text-(--muted-foreground)">
          {symbol} state on Cardano lending protocols.
        </p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <FluidExposureCard symbol={symbol} rollup={fluid} />
        <LiqwidExposureCard symbol={symbol} market={liqwid} />
      </div>
    </section>
  );
}

function FluidExposureCard({
  symbol,
  rollup,
}: {
  symbol: SupportedStable;
  rollup: FluidAssetRollup | null;
}) {
  return (
    <div className="border border-(--border) rounded-lg p-5">
      <div className="flex items-baseline justify-between">
        <h3 className="font-semibold">
          <a
            href="https://app.fluidtokens.com/lending"
            target="_blank"
            rel="noreferrer"
            className="text-(--accent) hover:underline"
          >
            FluidTokens v3
          </a>
        </h3>
        <span className="text-xs text-(--muted-foreground)">peer-to-peer</span>
      </div>
      {!rollup ? (
        <p className="mt-3 text-sm text-(--muted-foreground)">
          No FluidTokens pools or loans denominated in {symbol}.
        </p>
      ) : (
        <dl className="mt-3 grid grid-cols-2 gap-y-2 text-sm">
          <dt className="text-(--muted-foreground)">Pools</dt>
          <dd className="text-right font-mono tabular-nums">{rollup.poolCount}</dd>
          <dt className="text-(--muted-foreground)">Active loans</dt>
          <dd className="text-right font-mono tabular-nums">{rollup.loanCount}</dd>
          <dt className="text-(--muted-foreground)">Available to borrow</dt>
          <dd className="text-right font-mono tabular-nums">
            {rawToWhole(rollup.poolsAvailableRaw, 6).toLocaleString(undefined, { maximumFractionDigits: 0, useGrouping: false })} {symbol}
          </dd>
          <dt className="text-(--muted-foreground)">Outstanding</dt>
          <dd className="text-right font-mono tabular-nums">
            {rawToWhole(rollup.outstandingPrincipalRaw, 6).toLocaleString(undefined, { maximumFractionDigits: 0, useGrouping: false })} {symbol}
          </dd>
          <dt className="text-(--muted-foreground)">Liquidatable</dt>
          <dd className={`text-right font-mono tabular-nums ${rollup.liquidatable > 0 ? 'text-(--critical)' : 'text-(--healthy)'}`}>
            {rollup.liquidatable}
          </dd>
        </dl>
      )}
    </div>
  );
}

function LiqwidExposureCard({
  symbol,
  market,
}: {
  symbol: SupportedStable;
  market: LiqwidMarketRollup | null;
}) {
  return (
    <div className="border border-(--border) rounded-lg p-5">
      <div className="flex items-baseline justify-between">
        <h3 className="font-semibold">
          <a
            href="https://app.liqwid.finance"
            target="_blank"
            rel="noreferrer"
            className="text-(--accent) hover:underline"
          >
            Liqwid v2
          </a>
        </h3>
        <span className="text-xs text-(--muted-foreground)">pool-based qToken</span>
      </div>
      {!market ? (
        <p className="mt-3 text-sm text-(--muted-foreground)">
          {symbol} is not listed as a Liqwid market.
        </p>
      ) : (
        <dl className="mt-3 grid grid-cols-2 gap-y-2 text-sm">
          <dt className="text-(--muted-foreground)">Total supplied</dt>
          <dd className="text-right font-mono tabular-nums">
            {rawToWhole(market.totalSuppliedRaw, market.decimals).toLocaleString(undefined, { maximumFractionDigits: 0, useGrouping: false })} {symbol}
          </dd>
          <dt className="text-(--muted-foreground)">Total borrowed</dt>
          <dd className="text-right font-mono tabular-nums">
            {rawToWhole(market.principalRaw, market.decimals).toLocaleString(undefined, { maximumFractionDigits: 0, useGrouping: false })} {symbol}
          </dd>
          <dt className="text-(--muted-foreground)">Utilization</dt>
          <dd className={`text-right font-mono tabular-nums ${market.utilization >= 0.9 ? 'text-(--critical)' : ''}`}>
            {(market.utilization * 100).toFixed(1)}%
          </dd>
          <dt className="text-(--muted-foreground)">Supply APY</dt>
          <dd className="text-right font-mono tabular-nums text-(--healthy)">
            {market.supplyAPY !== null ? `${(market.supplyAPY * 100).toFixed(2)}%` : '-'}
          </dd>
          <dt className="text-(--muted-foreground)">Borrow APY</dt>
          <dd className="text-right font-mono tabular-nums">
            {market.borrowAPY !== null ? `${(market.borrowAPY * 100).toFixed(2)}%` : '-'}
          </dd>
        </dl>
      )}
    </div>
  );
}

function MetadataBlock({ data }: { data: StableHealthResult }) {
  const m = data.metadata;
  return (
    <section className="border border-(--border) rounded-lg p-5">
      <h2 className="font-semibold mb-4">On-chain identity</h2>
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-y-2 text-sm">
        <dt className="text-(--muted-foreground)">Backing</dt><dd>{m.backing}</dd>
        <dt className="text-(--muted-foreground)">Issuer</dt><dd>{m.issuerName}</dd>
        {m.issuerJurisdiction && (<><dt className="text-(--muted-foreground)">Jurisdiction</dt><dd>{m.issuerJurisdiction}</dd></>)}
        {m.issuerCustodian && (<><dt className="text-(--muted-foreground)">Custodian</dt><dd>{m.issuerCustodian}</dd></>)}
        <dt className="text-(--muted-foreground)">Live since</dt><dd>{m.liveSince}</dd>
        <dt className="text-(--muted-foreground)">Decimals</dt><dd>{m.decimals}</dd>
        <dt className="text-(--muted-foreground)">Policy ID</dt>
        <dd>
          <a
            href={`https://cardanoscan.io/tokenPolicy/${m.policyId}`}
            target="_blank"
            rel="noreferrer"
            className="text-(--accent) hover:underline font-mono text-xs"
          >
            {m.policyId.slice(0, 14)}…{m.policyId.slice(-6)}
          </a>
        </dd>
        <dt className="text-(--muted-foreground)">Asset name</dt>
        <dd className="font-mono text-xs">{m.assetNameHex}</dd>
      </dl>
    </section>
  );
}

function PaidActions({ symbol }: { symbol: SupportedStable }) {
  return (
    <section className="border border-(--border) rounded-lg p-5">
      <h2 className="font-semibold">Premium actions for {symbol}</h2>
      <p className="mt-2 text-sm text-(--muted-foreground)">
        These calls are gated by x402 USDM micropayments. Free public reads
        cover the dashboard you see above; below are agent-grade endpoints that
        ship verifiable on-chain provenance with each response.
      </p>
      <ul className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
        <li className="border border-(--border) rounded p-3">
          <div className="flex items-baseline justify-between">
            <span className="font-semibold">Audit pack</span>
            <span className="text-xs text-(--accent)">0.05 USDM</span>
          </div>
          <p className="mt-1 text-xs text-(--muted-foreground)">
            Self-contained JSON envelope with per-file sha256 + on-chain tx hashes. Verify offline against any Cardano node.
          </p>
        </li>
        <li className="border border-(--border) rounded p-3">
          <div className="flex items-baseline justify-between">
            <span className="font-semibold">Peg-break webhook</span>
            <span className="text-xs text-(--accent)">from 0.74 USDM/24h</span>
          </div>
          <p className="mt-1 text-xs text-(--muted-foreground)">
            Subscribe a webhook URL; CHAINFEED fires HMAC-signed POSTs at threshold-cross with 15-min cooldown + rearm hysteresis.
          </p>
        </li>
        <li className="border border-(--border) rounded p-3">
          <div className="flex items-baseline justify-between">
            <span className="font-semibold">getBestPrice</span>
            <span className="text-xs text-(--accent)">0.01 USDM</span>
          </div>
          <p className="mt-1 text-xs text-(--muted-foreground)">
            Multi-source aggregated quote with pegDeviationBps + audit tx hashes. Single round-trip per call.
          </p>
        </li>
        <li className="border border-(--border) rounded p-3">
          <div className="flex items-baseline justify-between">
            <span className="font-semibold">getArbitrageOpportunities</span>
            <span className="text-xs text-(--accent)">0.05 USDM</span>
          </div>
          <p className="mt-1 text-xs text-(--muted-foreground)">
            Best-buy / best-sell DEX, spread%, profitable flag for cross-venue arbitrage.
          </p>
        </li>
      </ul>
      <Link
        href="/developers"
        className="mt-4 inline-block text-sm text-(--accent) hover:underline"
      >
        How x402 micropayments work →
      </Link>
    </section>
  );
}

function formatAge(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60)         return `${sec}s ago`;
  if (sec < 3600)       return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400)      return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}
