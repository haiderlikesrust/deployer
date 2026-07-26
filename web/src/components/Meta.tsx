import { useEffect, useState, type ReactNode } from 'react';
import { CopyButton } from './CopyButton';
import { Chip } from './Chip';
import { absTime, cn, formatDuration, shortSha, timeAgo } from './helpers';

/** One shared interval for every relative timestamp on the page. */
const listeners = new Set<() => void>();
let ticker: number | undefined;

function useTick(ms: number) {
  const [, force] = useState(0);
  useEffect(() => {
    if (ms === 30000) {
      const cb = () => force((n) => n + 1);
      listeners.add(cb);
      if (ticker === undefined) {
        ticker = window.setInterval(() => listeners.forEach((l) => l()), 30000);
      }
      return () => {
        listeners.delete(cb);
        if (listeners.size === 0 && ticker !== undefined) {
          window.clearInterval(ticker);
          ticker = undefined;
        }
      };
    }
    const id = window.setInterval(() => force((n) => n + 1), ms);
    return () => window.clearInterval(id);
  }, [ms]);
}

export function RelativeTime({ iso, className }: { iso: string | null | undefined; className?: string }) {
  useTick(30000);
  if (!iso) return null;
  return (
    <time dateTime={iso} title={absTime(iso)} className={className}>
      {timeAgo(iso)}
    </time>
  );
}

/** Ticks every second while still running, so an in-flight deploy shows a live clock. */
export function Duration({
  from,
  to,
  className,
}: {
  from: string | null | undefined;
  to?: string | null;
  className?: string;
}) {
  useTick(to ? 60000 : 1000);
  return <span className={cn('font-mono tnum text-fg-subtle', className)}>{formatDuration(from, to)}</span>;
}

export function CommitRef({
  sha,
  msg,
  trigger,
  className,
}: {
  sha: string | null | undefined;
  msg?: string | null;
  trigger?: string | null;
  className?: string;
}) {
  if (!sha) {
    return trigger ? (
      <Chip size="sm" tone="neutral" className={className}>
        {trigger}
      </Chip>
    ) : null;
  }
  return (
    <span className={cn('flex min-w-0 items-center gap-1.5', className)}>
      <span className="font-mono text-xs text-fg">{shortSha(sha)}</span>
      <CopyButton value={sha} size="sm" title="Copy commit SHA" />
      {msg && <span className="min-w-0 truncate text-xs text-fg-subtle">{msg}</span>}
    </span>
  );
}

export interface KeyValueRow {
  label: string;
  value: ReactNode;
  mono?: boolean;
  copy?: string;
  chip?: ReactNode;
}

export function KeyValue({ rows, className }: { rows: KeyValueRow[]; className?: string }) {
  return (
    <dl className={cn('divide-y divide-border-subtle', className)}>
      {rows.map((r) => (
        <div
          key={r.label}
          className="grid grid-cols-1 gap-x-4 gap-y-0.5 py-2 sm:grid-cols-[minmax(120px,160px)_minmax(0,1fr)]"
        >
          <dt className="text-xs text-fg-subtle">{r.label}</dt>
          <dd className="flex min-w-0 items-center gap-2">
            <span className={cn('min-w-0 text-xs break-all text-fg', r.mono !== false && 'font-mono tnum')}>
              {r.value}
            </span>
            {r.copy && <CopyButton value={r.copy} size="sm" />}
            {r.chip && <span className="ml-auto shrink-0">{r.chip}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('mb-6', className)}>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold tracking-[-0.02em] text-fg">{title}</h1>
        {actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {description && <p className="mt-1.5 text-sm text-fg-subtle">{description}</p>}
    </div>
  );
}

export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('text-2xs font-medium tracking-[0.06em] text-fg-subtle uppercase', className)}>{children}</div>
  );
}

export function Separator({ vertical, className }: { vertical?: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(vertical ? 'inline-block h-4 w-px bg-border' : 'block h-px w-full bg-border', className)}
    />
  );
}
