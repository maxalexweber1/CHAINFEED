/**
 * Per-stable detail skeleton — instantly rendered on navigation from the
 * home cards. Replaces the otherwise blank ~5-15s wait while the server
 * fetches getStableHealth + 2 getOhlcv calls.
 */

import Link from 'next/link';

export default function SymbolLoading() {
  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <Link href="/" className="text-sm text-(--accent) hover:underline">← All stables</Link>
          <SkeletonLine className="h-8 w-24" />
          <SkeletonLine className="h-4 w-32 hidden sm:block" />
        </div>
        <SkeletonLine className="h-3 w-44" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <BlockSkeleton title="Price" />
        <BlockSkeleton title="Reserves" />
        <BlockSkeleton title="Risk score" />
      </div>

      <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartSkeleton title="ADA price · 24h" />
        <ChartSkeleton title="Peg deviation · 24h" />
      </section>

      <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <BlockSkeleton title="Supply" small />
        <BlockSkeleton title="Executable depth" small />
      </section>
    </div>
  );
}

function BlockSkeleton({ title, small = false }: { title: string; small?: boolean }) {
  return (
    <div className="border border-(--border) rounded-lg p-5 animate-pulse">
      <h3 className="text-sm uppercase tracking-wide text-(--muted-foreground)">{title}</h3>
      <SkeletonLine className={`mt-3 ${small ? 'h-7 w-32' : 'h-9 w-40'}`} />
      <SkeletonLine className="mt-2 h-4 w-24" />
      <div className="mt-4 space-y-2">
        <SkeletonRow />
        <SkeletonRow />
        <SkeletonRow />
      </div>
    </div>
  );
}

function ChartSkeleton({ title }: { title: string }) {
  return (
    <div className="border border-(--border) rounded-lg p-5 animate-pulse">
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="font-semibold">{title}</h2>
        <SkeletonLine className="h-3 w-16" />
      </div>
      <div className="h-64 bg-(--muted) rounded" />
    </div>
  );
}

function SkeletonRow() {
  return (
    <div className="flex items-center justify-between">
      <SkeletonLine className="h-3 w-24" />
      <SkeletonLine className="h-3 w-16" />
    </div>
  );
}

function SkeletonLine({ className }: { className?: string }) {
  return <div className={`bg-(--muted)/60 rounded ${className ?? ''}`} />;
}
