import {
  forwardRef,
  useId,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { ChevronDown, Eye, EyeOff } from './Icons';
import { IconButton } from './Button';
import { Chip } from './Chip';
import { cn } from './helpers';

/** Focus ring is a box-shadow, so gaining focus never reflows the form. */
const BOX =
  'h-8 w-full rounded-sm border border-border bg-surface-2 px-2.5 text-sm text-fg placeholder:text-fg-faint transition-ui outline-none hover:border-border-strong focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-bg)]';

const BOX_INVALID = 'border-danger-br focus:border-danger focus:shadow-[0_0_0_3px_var(--color-danger-bg)]';

/** Kept for compat: pages still do `className={inputCls}` on bare <input>/<select>. */
export const inputCls = BOX;

export function Field({
  label,
  hint,
  error,
  required,
  htmlFor,
  children,
  className,
}: {
  label?: string;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  const inner = (
    <>
      {label && (
        <div className="mb-1.5 text-2xs font-medium tracking-[0.06em] text-fg-subtle uppercase">
          {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : label}
          {required && <span className="ml-0.5 text-fg-faint">*</span>}
        </div>
      )}
      {children}
      {/* one reserved slot: an error replaces the hint without moving anything */}
      {(hint || error) && (
        <div className={cn('mt-1.5 min-h-[1.125rem] text-xs', error ? 'text-danger-fg' : 'text-fg-subtle')}>
          {error ?? hint}
        </div>
      )}
    </>
  );
  if (htmlFor) return <div className={cn('block', className)}>{inner}</div>;
  return <label className={cn('block', className)}>{inner}</label>;
}

/** `prefix` is a real HTML attribute (string), so it has to be replaced rather than added. */
export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'prefix'> {
  invalid?: boolean;
  mono?: boolean;
  prefix?: ReactNode;
  suffix?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { invalid, mono, prefix, suffix, className, ...rest },
  ref
) {
  const wrapped = prefix != null || suffix != null;
  const field = (
    <input
      ref={ref}
      {...rest}
      aria-invalid={invalid || undefined}
      className={cn(
        BOX,
        invalid && BOX_INVALID,
        mono && 'font-mono tnum text-xs',
        wrapped && 'rounded-none border-0 bg-transparent px-2.5 focus:shadow-none',
        className
      )}
    />
  );

  if (!wrapped) return field;

  return (
    <div
      className={cn(
        'flex h-8 w-full items-stretch overflow-hidden rounded-sm border border-border bg-surface-2 transition-ui hover:border-border-strong focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--color-accent-bg)]',
        invalid && BOX_INVALID
      )}
    >
      {prefix && (
        <span className="flex items-center border-r border-border px-2 font-mono text-xs text-fg-faint">{prefix}</span>
      )}
      {field}
      {suffix && (
        <span className="flex items-center border-l border-border px-2 font-mono text-xs text-fg-faint">{suffix}</span>
      )}
    </div>
  );
});

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { invalid, className, children, ...rest },
  ref
) {
  return (
    <div className="relative">
      <select
        ref={ref}
        {...rest}
        aria-invalid={invalid || undefined}
        className={cn(BOX, invalid && BOX_INVALID, 'appearance-none pr-8', className)}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute top-1/2 right-2.5 h-3.5 w-3.5 -translate-y-1/2 text-fg-faint" />
    </div>
  );
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  mono?: boolean;
  invalid?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { mono, invalid, className, ...rest },
  ref
) {
  return (
    <textarea
      ref={ref}
      {...rest}
      aria-invalid={invalid || undefined}
      className={cn(
        BOX,
        'h-auto py-2 leading-[1.5]',
        invalid && BOX_INVALID,
        mono && 'font-mono text-xs',
        'scroll-thin',
        className
      )}
    />
  );
});

export function SecretInput({
  value,
  onChange,
  placeholder,
  isSet,
  mono,
  invalid,
  autoFocus,
  name,
  id,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  isSet?: boolean;
  mono?: boolean;
  invalid?: boolean;
  autoFocus?: boolean;
  name?: string;
  id?: string;
  className?: string;
}) {
  const [shown, setShown] = useState(false);
  const [focused, setFocused] = useState(false);
  const reactId = useId();
  const inputId = id ?? reactId;
  // reveal-on-focus is kept from the old behaviour; the eye is the explicit override
  const reveal = shown || focused;

  return (
    <div
      className={cn(
        'flex h-8 w-full items-stretch overflow-hidden rounded-sm border border-border bg-surface-2 transition-ui hover:border-border-strong focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--color-accent-bg)]',
        invalid && BOX_INVALID,
        className
      )}
    >
      <input
        id={inputId}
        name={name}
        autoFocus={autoFocus}
        type={reveal ? 'text' : 'password'}
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        className={cn(
          'min-w-0 flex-1 bg-transparent px-2.5 text-sm text-fg outline-none placeholder:text-fg-faint focus:shadow-none',
          mono && 'font-mono tnum text-xs'
        )}
      />
      {isSet && !value && (
        <span className="flex items-center pr-1">
          <Chip tone="neutral" size="sm">
            Set
          </Chip>
        </span>
      )}
      <span className="flex items-center pr-0.5">
        <IconButton title={shown ? 'Hide value' : 'Show value'} size="sm" onClick={() => setShown((s) => !s)}>
          {shown ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </IconButton>
      </span>
    </div>
  );
}
