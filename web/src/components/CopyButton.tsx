import { useEffect, useRef, useState } from 'react';
import { IconButton } from './Button';
import { Check, Copy } from './Icons';

/** The dashboard can be reached over plain HTTP (sslMode=off), where clipboard API is missing. */
export async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function CopyButton({
  value,
  label,
  size = 'sm',
  title = 'Copy',
  className,
}: {
  value: string;
  label?: string;
  size?: 'sm' | 'md';
  title?: string;
  className?: string;
}) {
  const [done, setDone] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function run() {
    const ok = await copyText(value);
    if (!ok) return;
    setDone(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setDone(false), 1200);
  }

  // the icon swap IS the feedback — no toast, no layout shift
  return (
    <IconButton
      title={done ? 'Copied' : (label ?? title)}
      size={size}
      onClick={run}
      className={className}
    >
      {done ? <Check className="h-3.5 w-3.5 text-success-fg" /> : <Copy className="h-3.5 w-3.5" />}
    </IconButton>
  );
}
