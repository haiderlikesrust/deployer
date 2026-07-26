import { cn } from './helpers';

/** Geometry must match the loaded state exactly, so a fast response reads as an instant paint. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('skeleton', className)} />;
}

export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn('space-y-2', className)}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={cn('h-3', i === lines - 1 ? 'w-2/3' : 'w-full')} />
      ))}
    </div>
  );
}

export function AppCardSkeleton() {
  return (
    <div className="rounded-lg border border-border bg-surface p-4 shadow-xs">
      <div className="flex items-center gap-3">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="ml-auto h-[22px] w-16 rounded-full" />
      </div>
      <div className="mt-2 flex h-5 items-center">
        <Skeleton className="h-3 w-44" />
      </div>
      <div className="-mx-4 mt-3 border-t border-border-subtle" />
      <div className="flex items-center gap-2 px-4 pt-3">
        <Skeleton className="h-3 w-40" />
        <Skeleton className="ml-auto h-3 w-16" />
      </div>
    </div>
  );
}

export function DeploymentRowSkeleton() {
  return (
    <div className="px-3 py-2.5">
      <div className="flex items-center gap-2">
        <Skeleton className="h-5 w-14 rounded-full" />
        <Skeleton className="h-3 w-8" />
        <Skeleton className="ml-auto h-3 w-10" />
      </div>
      <Skeleton className="mt-1.5 h-3 w-48" />
      <Skeleton className="mt-1 h-3 w-24" />
    </div>
  );
}

export function StatCardSkeleton() {
  return (
    <div className="rounded-lg border border-border bg-surface p-4 shadow-xs">
      <Skeleton className="h-2.5 w-16" />
      <Skeleton className="mt-2 h-5 w-24" />
    </div>
  );
}

export function EnvRowSkeleton() {
  return (
    <div className="grid grid-cols-[minmax(120px,200px)_minmax(0,1fr)] gap-2">
      <Skeleton className="h-8" />
      <Skeleton className="h-8" />
    </div>
  );
}
