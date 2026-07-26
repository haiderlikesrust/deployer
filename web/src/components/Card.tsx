import type { ElementType, ReactNode } from 'react';
import { cn } from './helpers';

export type CardTone = 'default' | 'danger' | 'warn' | 'info';
export type CardPadding = 'none' | 'sm' | 'md' | 'lg';

const PADDING: Record<CardPadding, string> = {
  none: '',
  sm: 'p-3',
  md: 'p-4',
  lg: 'p-5',
};

const TONE: Record<CardTone, string> = {
  default: 'border-border bg-surface',
  danger: 'border-danger-br bg-danger-bg',
  warn: 'border-warn-br bg-warn-bg',
  info: 'border-info-br bg-info-bg',
};

export interface CardProps {
  children?: ReactNode;
  interactive?: boolean;
  padding?: CardPadding;
  tone?: CardTone;
  as?: ElementType;
  className?: string;
  /** forwarded when `as` is a Link */
  to?: string;
  href?: string;
  onClick?: () => void;
  [key: string]: unknown;
}

/** Depth comes from the surface ladder plus a hairline border — never from a big blur. */
export function Card({
  children,
  interactive,
  padding = 'none',
  tone = 'default',
  as,
  className,
  ...rest
}: CardProps) {
  const Tag = (as ?? 'div') as ElementType;
  return (
    <Tag
      className={cn(
        'block rounded-lg border shadow-xs',
        TONE[tone],
        PADDING[padding],
        interactive &&
          'group transition-ui hover:border-border-strong hover:bg-surface-2 hover:shadow-sm hover:-translate-y-px focus-visible:shadow-focus',
        className
      )}
      {...rest}
    >
      {children}
    </Tag>
  );
}

export function CardHeader({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-start justify-between gap-3 border-b border-border-subtle px-4 py-3', className)}>
      {children}
    </div>
  );
}

export function CardTitle({ children, className }: { children: ReactNode; className?: string }) {
  return <h2 className={cn('text-sm font-medium text-fg', className)}>{children}</h2>;
}

export function CardDescription({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn('mt-0.5 text-xs text-fg-subtle', className)}>{children}</p>;
}

export function CardBody({
  children,
  padding = 'md',
  className,
}: {
  children: ReactNode;
  padding?: CardPadding;
  className?: string;
}) {
  return <div className={cn(PADDING[padding], className)}>{children}</div>;
}

export function CardFooter({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'flex items-center justify-end gap-2 rounded-b-lg border-t border-border-subtle bg-bg-subtle px-4 py-3',
        className
      )}
    >
      {children}
    </div>
  );
}

export function StatCard({
  label,
  value,
  icon,
  hint,
  tone = 'default',
  children,
  className,
}: {
  label: string;
  value: ReactNode;
  icon?: ReactNode;
  hint?: ReactNode;
  tone?: 'default' | 'danger' | 'success' | 'warn';
  children?: ReactNode;
  className?: string;
}) {
  const valueTone =
    tone === 'danger' ? 'text-danger-fg' : tone === 'success' ? 'text-success-fg' : tone === 'warn' ? 'text-warn-fg' : 'text-fg';
  return (
    <div className={cn('rounded-lg border border-border bg-surface p-4 shadow-xs', className)}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-2xs font-medium tracking-[0.06em] text-fg-subtle uppercase">{label}</div>
          <div className={cn('mt-1.5 font-mono tnum text-lg font-medium break-all', valueTone)}>{value}</div>
        </div>
        {icon && <span className="mt-0.5 shrink-0 text-fg-faint">{icon}</span>}
      </div>
      {children}
      {hint && <div className="mt-1.5 text-xs text-fg-subtle">{hint}</div>}
    </div>
  );
}
