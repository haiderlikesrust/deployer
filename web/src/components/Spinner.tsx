import { cn } from './helpers';

/**
 * Only two legitimate homes remain: inside a button and the full-screen auth
 * boot check. Everything else that used to spin now uses a Skeleton.
 */
export function Spinner({ className }: { className?: string } = {}) {
  return (
    <div
      role="status"
      aria-label="Loading"
      className={cn('h-4 w-4 animate-spin rounded-full border-2 border-border-strong border-t-fg-muted', className)}
    />
  );
}
