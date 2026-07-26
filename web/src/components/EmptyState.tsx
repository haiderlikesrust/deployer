import type { ReactNode } from 'react';
import { Button, ButtonLink } from './Button';
import { cn } from './helpers';

export interface EmptyStateAction {
  label: string;
  to?: string;
  onClick?: () => void;
  loading?: boolean;
}

/** Solid hairline, never `border-dashed` — dashed reads as an unstyled placeholder. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  secondaryAction,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: EmptyStateAction;
  secondaryAction?: EmptyStateAction;
  className?: string;
}) {
  return (
    <div className={cn('rounded-lg border border-border bg-surface px-6 py-12 text-center', className)}>
      {icon && (
        <div className="mx-auto grid h-10 w-10 place-items-center rounded-lg border border-border bg-surface-2 text-fg-subtle">
          {icon}
        </div>
      )}
      <h3 className="mt-4 text-sm font-medium text-fg">{title}</h3>
      {description && <p className="mx-auto mt-1.5 max-w-[38ch] text-xs text-fg-subtle">{description}</p>}
      {(action || secondaryAction) && (
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          {action &&
            (action.to ? (
              <ButtonLink variant="primary" to={action.to}>
                {action.label}
              </ButtonLink>
            ) : (
              <Button variant="primary" loading={action.loading} onClick={action.onClick}>
                {action.label}
              </Button>
            ))}
          {secondaryAction &&
            (secondaryAction.to ? (
              <ButtonLink variant="ghost" to={secondaryAction.to}>
                {secondaryAction.label}
              </ButtonLink>
            ) : (
              <Button variant="ghost" loading={secondaryAction.loading} onClick={secondaryAction.onClick}>
                {secondaryAction.label}
              </Button>
            ))}
        </div>
      )}
    </div>
  );
}
