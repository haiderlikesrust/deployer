import type { ReactNode } from 'react';
import { cn } from './helpers';

/**
 * CSS-only tooltip: zero JS, zero deps. Must not be placed inside an
 * `overflow-hidden` container or the bubble gets clipped.
 */
export function Tooltip({
  content,
  side = 'top',
  children,
  className,
}: {
  content: string;
  side?: 'top' | 'bottom';
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={cn('group relative inline-flex', className)}>
      {children}
      <span
        role="tooltip"
        className={cn(
          'pointer-events-none absolute left-1/2 z-50 -translate-x-1/2 rounded-sm border border-border-strong bg-surface-3 px-2 py-1 text-2xs whitespace-nowrap text-fg opacity-0 shadow-md transition-opacity delay-300 duration-fast group-hover:opacity-100 group-focus-within:opacity-100',
          side === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5'
        )}
      >
        {content}
      </span>
    </span>
  );
}
