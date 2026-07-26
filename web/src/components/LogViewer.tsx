import { useCallback, useEffect, useMemo, useRef, useState, type UIEvent } from 'react';
import { classifyLine, stripAnsi } from './ansi';
import { CopyButton } from './CopyButton';
import { IconButton } from './Button';
import { StatusDot } from './StatusBadge';
import { ArrowDown, Download, Search, Trash, Wrap, X } from './Icons';
import { cn, formatCount } from './helpers';

/** Rendering more than this many rows buys nothing and costs scroll smoothness. */
const MAX_RENDERED = 2000;
const STICK_PX = 48;

export interface LogViewerProps {
  lines: string[];
  className?: string;
  live?: boolean;
  emptyLabel?: string;
  filename?: string;
  onClear?: () => void;
  initialWrap?: boolean;
  toolbar?: boolean;
  lineNumbers?: boolean;
  ariaLabel?: string;
}

export function LogViewer({
  lines,
  className = '',
  live = false,
  emptyLabel,
  filename = 'deploy.log',
  onClear,
  initialWrap = true,
  toolbar = true,
  lineNumbers = true,
  ariaLabel = 'Log output',
}: LogViewerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);
  const [wrap, setWrap] = useState(initialWrap);
  const [query, setQuery] = useState('');
  const [newSince, setNewSince] = useState(0);
  const detachedAt = useRef<number>(0);

  const filtered = useMemo(() => {
    if (!query.trim()) return lines;
    const q = query.toLowerCase();
    return lines.filter((l) => stripAnsi(l).toLowerCase().includes(q));
  }, [lines, query]);

  const truncated = Math.max(0, filtered.length - MAX_RENDERED);
  const visible = truncated ? filtered.slice(-MAX_RENDERED) : filtered;

  const scrollToEnd = useCallback((smooth = false) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  // Auto-follow. Never re-snap while the user has text selected inside the pane.
  useEffect(() => {
    if (!stick) {
      setNewSince(lines.length - detachedAt.current);
      return;
    }
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && scrollRef.current?.contains(sel.anchorNode)) return;
    scrollToEnd();
  }, [lines, stick, scrollToEnd]);

  function onScroll(e: UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
    if (atBottom !== stick) {
      if (!atBottom) detachedAt.current = lines.length;
      else setNewSince(0);
      setStick(atBottom);
    }
  }

  function download() {
    const blob = new Blob([lines.map(stripAnsi).join('\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // revoke on the next tick so Firefox has time to start the download
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  const empty = visible.length === 0;
  const gutterWidth = lineNumbers ? 'w-10' : 'w-0';
  const firstNumber = filtered.length - visible.length + 1;

  return (
    <div className={cn('flex flex-col overflow-hidden rounded-md border border-border bg-[#0a0a0c]', className)}>
      {toolbar && (
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border-subtle bg-bg-subtle px-2">
          <StatusDot status={live ? 'building' : 'neutral'} className="ml-1" />
          <span className="hidden text-2xs text-fg-subtle sm:inline">
            {formatCount(lines.length)} {lines.length === 1 ? 'line' : 'lines'}
          </span>
          <div className="relative ml-auto flex min-w-0 items-center">
            <Search className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-fg-faint" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter"
              aria-label="Filter log lines"
              spellCheck={false}
              className="h-7 w-28 rounded-sm border border-border bg-surface-2 pr-6 pl-7 text-xs text-fg outline-none transition-ui placeholder:text-fg-faint hover:border-border-strong focus:border-accent sm:w-[200px]"
            />
            {query && (
              <button
                type="button"
                aria-label="Clear filter"
                title="Clear filter"
                onClick={() => setQuery('')}
                className="absolute right-1.5 text-fg-faint transition-ui hover:text-fg"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
          <IconButton
            size="sm"
            title={wrap ? 'Disable wrapping' : 'Wrap long lines'}
            onClick={() => setWrap((w) => !w)}
            className={cn('max-sm:h-10', wrap && 'text-fg')}
          >
            <Wrap className="h-3.5 w-3.5" />
          </IconButton>
          <CopyButton value={lines.map(stripAnsi).join('\n')} title="Copy all output" className="max-sm:h-10" />
          <IconButton size="sm" title="Download log" onClick={download} className="max-sm:h-10">
            <Download className="h-3.5 w-3.5" />
          </IconButton>
          {onClear && (
            <IconButton size="sm" title="Clear" onClick={onClear} className="max-sm:h-10">
              <Trash className="h-3.5 w-3.5" />
            </IconButton>
          )}
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          role="log"
          aria-live="off"
          aria-label={ariaLabel}
          className="h-full overflow-auto p-3 font-mono text-xs leading-[1.55] text-[#d4d4d8] scroll-thin selection:bg-accent/35 [contain:content] [overflow-anchor:none]"
        >
          {truncated > 0 && (
            <div className="sticky top-0 z-10 -mx-3 -mt-3 mb-2 flex items-center gap-2 border-b border-border-subtle bg-bg-subtle/95 px-3 py-1.5 text-2xs text-fg-subtle backdrop-blur">
              Showing last {formatCount(MAX_RENDERED)} of {formatCount(filtered.length)} lines
              <button type="button" onClick={download} className="text-accent-fg underline-offset-2 hover:underline">
                Download full log
              </button>
            </div>
          )}

          {empty ? (
            <div className="grid h-full place-items-center text-xs text-fg-faint">
              {emptyLabel ?? (live ? <EllipsisLabel label="Waiting for output" /> : 'Waiting for output…')}
            </div>
          ) : (
            visible.map((line, i) => (
              <div key={firstNumber + i} className="flex min-w-0 gap-3">
                {lineNumbers && (
                  <span className={cn('hidden shrink-0 text-right tnum text-fg-faint select-none sm:block', gutterWidth)}>
                    {firstNumber + i}
                  </span>
                )}
                <span className={cn('min-w-0', wrap ? 'break-all whitespace-pre-wrap' : 'whitespace-pre')}>
                  {classifyLine(line).map((seg, j) => (
                    <span key={j} className={seg.cls || undefined}>
                      {seg.text}
                    </span>
                  ))}
                  {line === '' && ' '}
                </span>
              </div>
            ))
          )}
        </div>

        {!stick && (
          <button
            type="button"
            onClick={() => {
              setStick(true);
              setNewSince(0);
              scrollToEnd(true);
            }}
            className="absolute bottom-3 left-1/2 inline-flex h-7 -translate-x-1/2 items-center gap-1.5 rounded-full border border-border-strong bg-surface-3/90 px-3 text-xs text-fg shadow-md backdrop-blur transition-ui animate-pop hover:bg-surface-3"
          >
            <ArrowDown className="h-3.5 w-3.5" />
            Jump to latest
            {newSince > 0 && <span className="tnum text-fg-subtle">+{formatCount(newSince)}</span>}
          </button>
        )}
      </div>
    </div>
  );
}

function EllipsisLabel({ label }: { label: string }) {
  return (
    <span className="inline-flex items-baseline gap-0.5">
      {label}
      <span className="inline-flex">
        <Dot delay="0ms" />
        <Dot delay="160ms" />
        <Dot delay="320ms" />
      </span>
    </span>
  );
}

function Dot({ delay }: { delay: string }) {
  return (
    <span className="animate-pulse" style={{ animationDelay: delay }}>
      .
    </span>
  );
}
