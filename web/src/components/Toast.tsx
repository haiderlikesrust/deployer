import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, Check, Info, X } from './Icons';
import { IconButton } from './Button';
import { cn } from './helpers';

export type ToastVariant = 'success' | 'error' | 'info';

export interface ToastOptions {
  title: string;
  description?: string;
  variant?: ToastVariant;
  /** ms; 0 keeps it until dismissed */
  duration?: number;
  action?: { label: string; onClick: () => void };
}

interface ToastRecord extends ToastOptions {
  id: number;
  leaving?: boolean;
}

type ToastFn = (opts: ToastOptions) => number;

const ToastCtx = createContext<{ toast: ToastFn; dismiss: (id: number) => void } | null>(null);

const MAX_STACK = 3;
const EXIT_MS = 120;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastRecord[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
    window.setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), EXIT_MS);
  }, []);

  const toast = useCallback<ToastFn>((opts) => {
    const id = ++seq.current;
    setItems((prev) => [...prev, { ...opts, id }].slice(-MAX_STACK));
    return id;
  }, []);

  const value = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastCtx.Provider value={value}>
      {children}
      <ToastViewport items={items} onDismiss={dismiss} />
    </ToastCtx.Provider>
  );
}

/** Returns a `toast({...})` function. Safe to call outside a provider (becomes a no-op). */
export function useToast(): ToastFn {
  const ctx = useContext(ToastCtx);
  return ctx?.toast ?? (() => 0);
}

export function useDismissToast(): (id: number) => void {
  const ctx = useContext(ToastCtx);
  return ctx?.dismiss ?? (() => {});
}

export function ToastViewport({ items, onDismiss }: { items: ToastRecord[]; onDismiss: (id: number) => void }) {
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      className="pointer-events-none fixed inset-x-4 bottom-4 z-[60] flex flex-col gap-2 sm:inset-x-auto sm:right-4 sm:w-[min(360px,calc(100vw-2rem))]"
      aria-live="polite"
    >
      {items.map((t) => (
        <ToastItem key={t.id} item={t} onDismiss={onDismiss} />
      ))}
    </div>,
    document.body
  );
}

const ICON: Record<ToastVariant, ReactNode> = {
  success: <Check className="h-3.5 w-3.5" />,
  error: <AlertCircle className="h-3.5 w-3.5" />,
  info: <Info className="h-3.5 w-3.5" />,
};

const ICON_TONE: Record<ToastVariant, string> = {
  success: 'text-success-fg',
  error: 'text-danger-fg',
  info: 'text-info-fg',
};

function ToastItem({ item, onDismiss }: { item: ToastRecord; onDismiss: (id: number) => void }) {
  const variant = item.variant ?? 'info';
  const duration = item.duration ?? 4500;
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (!duration || paused) return;
    const id = window.setTimeout(() => onDismiss(item.id), duration);
    return () => window.clearTimeout(id);
  }, [duration, paused, item.id, onDismiss]);

  return (
    <div
      role="status"
      aria-live={variant === 'error' ? 'assertive' : 'polite'}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      className={cn(
        'group pointer-events-auto flex items-start gap-2.5 rounded-lg border border-border-strong bg-surface-3 px-3.5 py-3 shadow-lg transition-ui',
        item.leaving ? 'translate-y-1 opacity-0' : 'animate-pop'
      )}
    >
      <span className={cn('mt-0.5 shrink-0', ICON_TONE[variant])}>{ICON[variant]}</span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-fg">{item.title}</div>
        {item.description && <div className="mt-0.5 text-xs break-words text-fg-subtle">{item.description}</div>}
        {item.action && (
          <button
            type="button"
            onClick={() => {
              item.action?.onClick();
              onDismiss(item.id);
            }}
            className="mt-2 inline-flex h-7 items-center rounded-md px-2 text-xs font-medium text-accent-fg transition-ui hover:bg-white/[0.05]"
          >
            {item.action.label}
          </button>
        )}
      </div>
      <IconButton
        title="Dismiss"
        size="sm"
        onClick={() => onDismiss(item.id)}
        className="opacity-0 transition-ui group-hover:opacity-100 group-focus-within:opacity-100 max-sm:opacity-100"
      >
        <X className="h-3.5 w-3.5" />
      </IconButton>
    </div>
  );
}
