import { cn } from './helpers';

export type StatusKind = 'live' | 'progress' | 'failed' | 'neutral' | 'new' | 'needs_env';

export interface StatusMeta {
  kind: StatusKind;
  label: string;
}

const MAP: Record<string, StatusMeta> = {
  live: { kind: 'live', label: 'Live' },
  queued: { kind: 'progress', label: 'Queued' },
  cloning: { kind: 'progress', label: 'Cloning' },
  resolving: { kind: 'progress', label: 'Resolving' },
  building: { kind: 'progress', label: 'Building' },
  releasing: { kind: 'progress', label: 'Releasing' },
  starting: { kind: 'progress', label: 'Starting' },
  checking: { kind: 'progress', label: 'Health check' },
  deploying: { kind: 'progress', label: 'Deploying' },
  failed: { kind: 'failed', label: 'Failed' },
  stopped: { kind: 'neutral', label: 'Stopped' },
  canceled: { kind: 'neutral', label: 'Canceled' },
  superseded: { kind: 'neutral', label: 'Superseded' },
  needs_env: { kind: 'needs_env', label: 'Needs setup' },
  new: { kind: 'new', label: 'Not deployed' },
};

export function statusMeta(status: string): StatusMeta {
  return MAP[status] ?? { kind: 'neutral', label: status };
}

/** needs_env is informational (sky), never red — the user's model must be "waiting for me". */
const PILL: Record<StatusKind, string> = {
  live: 'bg-success-bg border-success-br text-success-fg',
  progress: 'bg-warn-bg border-warn-br text-warn-fg',
  failed: 'bg-danger-bg border-danger-br text-danger-fg',
  neutral: 'bg-neutral-bg border-neutral-br text-neutral-fg',
  new: 'bg-info-bg border-info-br text-info-fg',
  needs_env: 'bg-info-bg border-info-br text-info-fg',
};

const DOT_TEXT: Record<StatusKind, string> = {
  live: 'text-success',
  progress: 'text-warn',
  failed: 'text-danger',
  neutral: 'text-fg-subtle',
  new: 'text-info',
  needs_env: 'text-info',
};

export function StatusDot({ status, className }: { status: string; className?: string }) {
  const { kind } = statusMeta(status);
  return (
    <span
      className={cn(
        'relative inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-current',
        DOT_TEXT[kind],
        // the halo ring moves instead of the dot, so an adjacent label stays legible
        kind === 'progress' && 'before:absolute before:inset-0 before:rounded-full before:animate-halo',
        className
      )}
    />
  );
}

export function StatusBadge({
  status,
  size = 'md',
  className,
}: {
  status: string;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const meta = statusMeta(status);
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full border pr-2 pl-1.5 font-medium',
        size === 'sm' ? 'h-5 text-2xs' : 'h-[22px] text-2xs',
        PILL[meta.kind],
        className
      )}
    >
      <StatusDot status={status} className={DOT_TEXT[meta.kind]} />
      {meta.label}
    </span>
  );
}
