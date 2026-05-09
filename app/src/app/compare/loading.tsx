/**
 * Convergence-matrix skeleton. The compare page's `getStableConvergence`
 * fans out across every USD-pegged stable, so cold load can take 5-10 s.
 * This file gives users an immediate visual frame while that resolves.
 */

import { SUPPORTED_STABLES } from '@/lib/chainfeed-client';

export default function CompareLoading() {
  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-3xl font-bold tracking-tight">Stable convergence</h1>
        <SkeletonLine className="mt-3 h-5 w-full max-w-2xl" />
        <SkeletonLine className="mt-2 h-5 w-3/4 max-w-xl" />
      </header>

      <section className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <KpiSkeleton title="Convergence score" />
        <KpiSkeleton title="Max deviation" />
        <KpiSkeleton title="Outliers" />
      </section>

      <section>
        <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
          <h2 className="font-semibold">Cross-rate matrix</h2>
        </div>
        <div className="border border-(--border) rounded-lg p-3">
          <div className="grid gap-1" style={{ gridTemplateColumns: `auto repeat(${SUPPORTED_STABLES.length}, 1fr)` }}>
            <div /> {/* corner */}
            {SUPPORTED_STABLES.map(s => (
              <div key={`h-${s}`} className="text-center text-xs uppercase tracking-wide text-(--muted-foreground) py-2">{s}</div>
            ))}
            {SUPPORTED_STABLES.map(from => (
              <FragmentRow key={from} from={from} />
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

function FragmentRow({ from }: { from: string }) {
  return (
    <>
      <div className="px-2 py-3 font-semibold text-sm">{from}</div>
      {SUPPORTED_STABLES.map(to => (
        <div key={`${from}-${to}`} className="px-1 py-1">
          <div className="h-16 min-w-24 bg-(--muted) rounded animate-pulse" />
        </div>
      ))}
    </>
  );
}

function KpiSkeleton({ title }: { title: string }) {
  return (
    <div className="border border-(--border) rounded-lg p-5 animate-pulse">
      <div className="text-sm uppercase tracking-wide text-(--muted-foreground)">{title}</div>
      <SkeletonLine className="mt-3 h-10 w-32" />
      <SkeletonLine className="mt-3 h-3 w-44" />
    </div>
  );
}

function SkeletonLine({ className }: { className?: string }) {
  return <div className={`bg-(--muted)/60 rounded ${className ?? ''}`} />;
}
