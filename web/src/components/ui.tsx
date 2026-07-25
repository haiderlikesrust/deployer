import { useEffect, useRef, useState, type ReactNode } from 'react';

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { dot: string; text: string; label?: string }> = {
    live: { dot: 'bg-emerald-400', text: 'text-emerald-300' },
    deploying: { dot: 'bg-amber-400 animate-pulse', text: 'text-amber-300' },
    queued: { dot: 'bg-amber-400 animate-pulse', text: 'text-amber-300' },
    cloning: { dot: 'bg-amber-400 animate-pulse', text: 'text-amber-300' },
    resolving: { dot: 'bg-amber-400 animate-pulse', text: 'text-amber-300' },
    building: { dot: 'bg-amber-400 animate-pulse', text: 'text-amber-300' },
    starting: { dot: 'bg-amber-400 animate-pulse', text: 'text-amber-300' },
    checking: { dot: 'bg-amber-400 animate-pulse', text: 'text-amber-300' },
    stopped: { dot: 'bg-zinc-500', text: 'text-zinc-400' },
    failed: { dot: 'bg-red-500', text: 'text-red-400' },
    canceled: { dot: 'bg-zinc-500', text: 'text-zinc-400' },
    superseded: { dot: 'bg-zinc-600', text: 'text-zinc-500' },
    new: { dot: 'bg-sky-400', text: 'text-sky-300' },
  };
  const s = map[status] ?? { dot: 'bg-zinc-500', text: 'text-zinc-400' };
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${s.text}`}>
      <span className={`h-2 w-2 rounded-full ${s.dot}`} />
      {s.label ?? status}
    </span>
  );
}

export function Button({
  children,
  onClick,
  variant = 'default',
  disabled,
  type = 'button',
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  disabled?: boolean;
  type?: 'button' | 'submit';
  title?: string;
}) {
  const styles = {
    default: 'bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700',
    primary: 'bg-indigo-600 hover:bg-indigo-500 text-white border border-transparent',
    danger: 'bg-red-900/40 hover:bg-red-900/70 text-red-300 border border-red-900',
    ghost: 'bg-transparent hover:bg-zinc-800 text-zinc-400 border border-transparent',
  };
  return (
    <button
      type={type}
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${styles[variant]}`}
    >
      {children}
    </button>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</div>
      {children}
      {hint && <div className="mt-1 text-xs text-zinc-500">{hint}</div>}
    </label>
  );
}

export const inputCls =
  'w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 outline-none focus:border-indigo-500';

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = 'Confirm',
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onCancel}>
      <div className="w-full max-w-md rounded-lg border border-zinc-700 bg-zinc-900 p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-2 text-base font-semibold text-zinc-100">{title}</h3>
        <p className="mb-4 text-sm text-zinc-400">{body}</p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Auto-scrolling log pane. Append-only text; sticks to bottom unless the user scrolls up. */
export function LogViewer({ lines, className = '' }: { lines: string[]; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);

  useEffect(() => {
    if (stick && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines, stick]);

  return (
    <div className={`relative ${className}`}>
      <div
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget;
          setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
        }}
        className="log-scroll h-full overflow-auto rounded-md border border-zinc-800 bg-black/60 p-3 font-mono text-xs leading-5 text-zinc-300"
      >
        <pre className="whitespace-pre-wrap break-words">{lines.join('\n')}</pre>
      </div>
      {!stick && (
        <button
          onClick={() => {
            setStick(true);
            if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
          }}
          className="absolute bottom-3 right-4 rounded-full border border-zinc-600 bg-zinc-800/90 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-700"
        >
          ↓ follow
        </button>
      )}
    </div>
  );
}

export function Spinner() {
  return <div className="h-4 w-4 animate-spin rounded-full border-2 border-zinc-600 border-t-indigo-400" />;
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
