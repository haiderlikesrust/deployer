import type { ReactNode } from 'react';
import { cn } from './helpers';

export type ChipTone = 'neutral' | 'accent' | 'warn' | 'success' | 'danger' | 'info';

const TONES: Record<ChipTone, string> = {
  neutral: 'bg-neutral-bg border-neutral-br text-fg-muted',
  accent: 'bg-accent-bg border-accent/30 text-accent-fg',
  warn: 'bg-warn-bg border-warn-br text-warn-fg',
  success: 'bg-success-bg border-success-br text-success-fg',
  danger: 'bg-danger-bg border-danger-br text-danger-fg',
  info: 'bg-info-bg border-info-br text-info-fg',
};

export function Chip({
  children,
  tone = 'neutral',
  size = 'md',
  mono,
  title,
  className,
}: {
  children: ReactNode;
  tone?: ChipTone;
  size?: 'sm' | 'md';
  mono?: boolean;
  title?: string;
  className?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex shrink-0 items-center rounded-sm border px-1.5 text-2xs font-medium',
        size === 'sm' ? 'h-[18px]' : 'h-5',
        mono && 'font-mono tnum',
        TONES[tone],
        className
      )}
    >
      {children}
    </span>
  );
}

const SOURCE_META: Record<string, { tone: ChipTone; label: string }> = {
  ui: { tone: 'accent', label: 'dashboard' },
  yml: { tone: 'warn', label: 'deploy.yml' },
  auto: { tone: 'neutral', label: 'auto' },
};

export function SourceChip({ source, className }: { source: 'ui' | 'yml' | 'auto' | string; className?: string }) {
  const meta = SOURCE_META[source] ?? { tone: 'neutral' as ChipTone, label: source };
  return (
    <Chip tone={meta.tone} size="sm" className={className}>
      {meta.label}
    </Chip>
  );
}
