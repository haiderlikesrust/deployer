import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Loader } from './Icons';
import { cn } from './helpers';

export type ButtonVariant = 'primary' | 'secondary' | 'default' | 'ghost' | 'danger' | 'danger-solid';
export type ButtonSize = 'sm' | 'md' | 'lg';

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 gap-1.5 text-xs',
  md: 'h-8 px-3 gap-2 text-sm',
  lg: 'h-10 px-4 gap-2 text-sm',
};

const VARIANTS: Record<ButtonVariant, string> = {
  // white-on-black CTA; exactly one per screen
  primary: 'bg-fg text-bg shadow-raise hover:bg-white',
  secondary: 'bg-surface-2 text-fg border border-border hover:border-border-strong hover:bg-[#1b1b20]',
  default: 'bg-surface-2 text-fg border border-border hover:border-border-strong hover:bg-[#1b1b20]',
  ghost: 'text-fg-subtle hover:text-fg hover:bg-white/[0.05]',
  danger: 'text-danger-fg bg-danger-bg border border-danger-br hover:bg-danger/20',
  'danger-solid': 'bg-danger text-white hover:bg-[#f05a5f]',
};

// no opacity fade — a faded button reads as unfinished, not as disabled
const DISABLED = 'bg-surface-2 text-fg-faint border border-border cursor-not-allowed hover:bg-surface-2 hover:border-border';

const BASE =
  'rounded-md font-medium inline-flex items-center justify-center whitespace-nowrap select-none transition-ui active:translate-y-px';

export function buttonCls(opts: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  inert?: boolean;
  className?: string;
}): string {
  const { variant = 'secondary', size = 'md', fullWidth, inert, className } = opts;
  return cn(BASE, SIZES[size], inert ? DISABLED : VARIANTS[variant], fullWidth && 'w-full', className);
}

export interface ButtonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
  iconRight?: ReactNode;
  fullWidth?: boolean;
  disabled?: boolean;
  type?: 'button' | 'submit';
  title?: string;
  'aria-label'?: string;
  onClick?: () => void;
  children?: ReactNode;
  className?: string;
}

/** The loading spinner takes over the icon slot so the label and the width never change. */
export function Button({
  children,
  onClick,
  variant = 'secondary',
  size = 'md',
  loading = false,
  icon,
  iconRight,
  fullWidth,
  disabled,
  type = 'button',
  title,
  className,
  ...rest
}: ButtonProps) {
  const inert = !!disabled || loading;
  const leading = loading ? <Loader className="h-4 w-4 shrink-0" /> : icon;
  return (
    <button
      type={type}
      title={title}
      aria-label={rest['aria-label']}
      onClick={onClick}
      disabled={inert}
      aria-disabled={inert || undefined}
      aria-busy={loading || undefined}
      className={buttonCls({ variant, size, fullWidth, inert, className })}
    >
      {leading != null && <span className="grid w-4 shrink-0 place-items-center">{leading}</span>}
      {children}
      {iconRight != null && !loading && <span className="grid w-4 shrink-0 place-items-center">{iconRight}</span>}
    </button>
  );
}

export interface ButtonLinkProps extends Omit<ButtonProps, 'onClick' | 'type' | 'loading'> {
  to?: string;
  href?: string;
  target?: string;
  rel?: string;
  onClick?: () => void;
}

/** Same styling on a real link, so "New App" and "Visit" stay keyboard- and middle-click-friendly. */
export function ButtonLink({
  to,
  href,
  target,
  rel,
  children,
  variant = 'secondary',
  size = 'md',
  icon,
  iconRight,
  fullWidth,
  disabled,
  title,
  className,
  onClick,
  ...rest
}: ButtonLinkProps) {
  const cls = buttonCls({ variant, size, fullWidth, inert: !!disabled, className });
  const inner = (
    <>
      {icon != null && <span className="grid w-4 shrink-0 place-items-center">{icon}</span>}
      {children}
      {iconRight != null && <span className="grid w-4 shrink-0 place-items-center">{iconRight}</span>}
    </>
  );
  if (to && !disabled) {
    return (
      <Link to={to} title={title} aria-label={rest['aria-label']} onClick={onClick} className={cls}>
        {inner}
      </Link>
    );
  }
  return (
    <a
      href={disabled ? undefined : (href ?? '#')}
      target={target}
      rel={rel ?? (target === '_blank' ? 'noreferrer' : undefined)}
      title={title}
      aria-label={rest['aria-label']}
      aria-disabled={disabled || undefined}
      onClick={onClick}
      className={cls}
    >
      {inner}
    </a>
  );
}

export interface IconButtonProps {
  children: ReactNode;
  title: string;
  'aria-label'?: string;
  onClick?: () => void;
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  disabled?: boolean;
  loading?: boolean;
  type?: 'button' | 'submit';
  className?: string;
}

export function IconButton({
  children,
  title,
  onClick,
  variant = 'ghost',
  size = 'md',
  disabled,
  loading,
  type = 'button',
  className,
  ...rest
}: IconButtonProps) {
  const inert = !!disabled || !!loading;
  return (
    <button
      type={type}
      title={title}
      aria-label={rest['aria-label'] ?? title}
      onClick={onClick}
      disabled={inert}
      aria-disabled={inert || undefined}
      aria-busy={loading || undefined}
      className={cn(
        BASE,
        size === 'sm' ? 'h-7 w-7' : 'h-8 w-8',
        'shrink-0 p-0',
        inert ? DISABLED : VARIANTS[variant],
        className
      )}
    >
      {loading ? <Loader className="h-4 w-4" /> : children}
    </button>
  );
}
