import { useRef, type KeyboardEvent } from 'react';
import { Chip } from './Chip';
import { cn } from './helpers';

export interface TabItem {
  value: string;
  label: string;
  count?: number;
}

/**
 * Underlined tab row with roving focus. The active bar is white (--color-fg):
 * the accent stays reserved for links and focus rings.
 */
export function Tabs({
  items,
  value,
  onChange,
  className,
  ariaLabel,
}: {
  items: TabItem[];
  value: string;
  onChange: (v: string) => void;
  className?: string;
  ariaLabel?: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    const i = items.findIndex((t) => t.value === value);
    let next = i;
    if (e.key === 'ArrowLeft') next = (i - 1 + items.length) % items.length;
    if (e.key === 'ArrowRight') next = (i + 1) % items.length;
    if (e.key === 'Home') next = 0;
    if (e.key === 'End') next = items.length - 1;
    const target = items[next];
    if (!target) return;
    onChange(target.value);
    const btn = listRef.current?.querySelector<HTMLButtonElement>(`[data-tab="${CSS.escape(target.value)}"]`);
    btn?.focus();
  }

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className={cn('-mb-px flex gap-1 overflow-x-auto border-b border-border scroll-thin', className)}
    >
      {items.map((t) => {
        const active = t.value === value;
        return (
          <button
            key={t.value}
            type="button"
            role="tab"
            data-tab={t.value}
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(t.value)}
            className={cn(
              'relative inline-flex h-9 shrink-0 items-center gap-2 px-3 text-sm font-medium transition-ui',
              active
                ? 'text-fg after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:bg-fg'
                : 'text-fg-subtle hover:text-fg'
            )}
          >
            {t.label}
            {t.count !== undefined && (
              <Chip size="sm" tone="neutral">
                {t.count}
              </Chip>
            )}
          </button>
        );
      })}
    </div>
  );
}
