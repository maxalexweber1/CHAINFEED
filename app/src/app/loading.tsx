/**
 * Cold-load skeleton for the home page.
 *
 * Next.js shows this immediately on first navigation while the server-side
 * `page.tsx` waits for all 5 `getStableHealth` calls. Without this file
 * the browser would sit on the previous page (or blank) for ~5-15s on
 * cold dashboard load.
 */

import { SUPPORTED_STABLES } from '@/lib/chainfeed-client';

export default function HomeLoading() {
  return (
    <div className="space-y-10">
      <section className="border border-(--border) rounded-lg overflow-hidden hero-mesh">
        <div className="px-5 sm:px-8 lg:px-10 pt-8 sm:pt-10 pb-6 sm:pb-8">
          <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-(--muted-foreground)">
            <span className="inline-block w-2 h-2 rounded-full bg-(--accent) pulse-dot" />
            Loading…
          </div>
          <h1 className="mt-4 text-[2rem] sm:text-4xl lg:text-5xl font-bold tracking-tight max-w-3xl leading-[1.1]">
            The Cardano stablecoin
            <br />
            <span className="bg-gradient-to-r from-(--accent) to-(--accent-soft) bg-clip-text text-transparent">
              transparency layer.
            </span>
          </h1>
          <SkeletonLine className="mt-5 h-5 w-full max-w-xl" />
          <SkeletonLine className="mt-2 h-5 w-2/3 max-w-md" />
          <div className="mt-6 flex gap-3">
            <SkeletonLine className="h-5 w-32" />
            <SkeletonLine className="h-5 w-24" />
          </div>
        </div>
        <div className="border-t border-(--border) h-12" />
      </section>

      <section>
        <div className="flex items-baseline justify-between mb-4">
          <h2 className="text-lg font-semibold">Cardano-native stables</h2>
          <span className="text-sm text-(--muted-foreground)">Loading live data…</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {SUPPORTED_STABLES.map((symbol) => (
            <CardSkeleton key={symbol} symbol={symbol} />
          ))}
        </div>
      </section>
    </div>
  );
}

function CardSkeleton({ symbol }: { symbol: string }) {
  return (
    <div className="border border-(--border) rounded-lg p-5 animate-pulse">
      <div className="flex items-baseline justify-between">
        <span className="font-bold text-lg">{symbol}</span>
        <SkeletonLine className="h-3 w-16" />
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3">
        <SkeletonStat />
        <SkeletonStat />
        <SkeletonStat />
        <SkeletonStat />
      </div>
      <div className="mt-4 pt-3 border-t border-(--border)">
        <SkeletonLine className="h-3 w-1/2" />
      </div>
    </div>
  );
}

function SkeletonStat() {
  return (
    <div>
      <SkeletonLine className="h-2 w-12" />
      <SkeletonLine className="mt-1.5 h-4 w-20" />
    </div>
  );
}

function SkeletonLine({ className }: { className?: string }) {
  return <div className={`bg-(--muted)/60 rounded ${className ?? ''}`} />;
}
