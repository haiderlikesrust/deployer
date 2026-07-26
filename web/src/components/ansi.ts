/**
 * Minimal SGR parser for build/runtime logs. Handles 0,1,2,3,4,22,23,24,39,
 * 30-37, 90-97 and 38;5;n. Every other escape sequence is stripped rather than
 * printed, because a raw CSI on screen looks broken.
 *
 * The regexes are built with `new RegExp` so the ESC byte stays a readable
 * ESC byte stays a readable escape in the source, not an invisible control character.
 */

export interface AnsiSegment {
  text: string;
  cls: string;
}

const ESC = '\u001b';
const BEL = '\u0007';

/** SGR first so it wins the alternation, then OSC strings, then any other CSI/Fe sequence. */
const ANSI_SOURCE =
  `${ESC}\\[([0-9;]*)m` +
  `|${ESC}\\][\\s\\S]*?(?:${BEL}|${ESC}\\\\)` +
  `|${ESC}\\[[0-9;?]*[A-Za-z]` +
  `|${ESC}[@-Z\\\\\\]^_]`;

const ANSI_RE = new RegExp(ANSI_SOURCE, 'g');
const HAS_ANSI_RE = new RegExp(ESC);

const FG: Record<number, string> = {
  30: 'text-ansi-black',
  31: 'text-ansi-red',
  32: 'text-ansi-green',
  33: 'text-ansi-yellow',
  34: 'text-ansi-blue',
  35: 'text-ansi-magenta',
  36: 'text-ansi-cyan',
  37: 'text-ansi-white',
  90: 'text-ansi-dim',
  91: 'text-ansi-red',
  92: 'text-ansi-green',
  93: 'text-ansi-yellow',
  94: 'text-ansi-blue',
  95: 'text-ansi-magenta',
  96: 'text-ansi-cyan',
  97: 'text-ansi-white',
};

/** 256-colour cube collapsed onto the 8-colour palette — close enough for logs. */
function xterm256(n: number): string {
  if (n < 8) return FG[30 + n] ?? '';
  if (n < 16) return FG[90 + (n - 8)] ?? '';
  if (n >= 232) return n < 244 ? 'text-ansi-dim' : 'text-ansi-white';
  const c = n - 16;
  const r = Math.floor(c / 36);
  const g = Math.floor((c % 36) / 6);
  const b = c % 6;
  const max = Math.max(r, g, b);
  if (max === 0) return 'text-ansi-black';
  if (r === g && g === b) return max > 3 ? 'text-ansi-white' : 'text-ansi-dim';
  if (r === max && g === max) return 'text-ansi-yellow';
  if (r === max && b === max) return 'text-ansi-magenta';
  if (g === max && b === max) return 'text-ansi-cyan';
  if (r === max) return 'text-ansi-red';
  if (g === max) return 'text-ansi-green';
  return 'text-ansi-blue';
}

export function hasAnsi(line: string): boolean {
  return HAS_ANSI_RE.test(line);
}

export function stripAnsi(line: string): string {
  return line.replace(ANSI_RE, '');
}

/** Docker/npm progress bars rewrite a line with \r; only the last state is meaningful. */
export function normalizeLine(line: string): string {
  if (!line.includes('\r')) return line;
  const parts = line.split('\r').filter((p) => p !== '');
  return parts.length ? parts[parts.length - 1]! : '';
}

interface SgrState {
  fg: string;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
}

function stateCls(s: SgrState): string {
  const out: string[] = [];
  if (s.fg) out.push(s.fg);
  if (s.bold) out.push('font-semibold');
  if (s.dim) out.push('opacity-60');
  if (s.italic) out.push('italic');
  if (s.underline) out.push('underline');
  return out.join(' ');
}

function applySgr(state: SgrState, params: string) {
  const codes = (params === '' ? '0' : params).split(';').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i]!;
    if (c === 0) {
      state.fg = '';
      state.bold = false;
      state.dim = false;
      state.italic = false;
      state.underline = false;
    } else if (c === 1) state.bold = true;
    else if (c === 2) state.dim = true;
    else if (c === 3) state.italic = true;
    else if (c === 4) state.underline = true;
    else if (c === 22) {
      state.bold = false;
      state.dim = false;
    } else if (c === 23) state.italic = false;
    else if (c === 24) state.underline = false;
    else if (c === 39) state.fg = '';
    else if (c === 38 && codes[i + 1] === 5) {
      state.fg = xterm256(codes[i + 2] ?? 0);
      i += 2;
    } else if (c === 38 && codes[i + 1] === 2) {
      i += 4; // truecolour: skip the payload, keep the current class
    } else if (c === 48 && codes[i + 1] === 5) i += 2;
    else if (c === 48 && codes[i + 1] === 2) i += 4;
    else if (FG[c]) state.fg = FG[c]!;
  }
}

/** Splits one log line into styled segments. Never returns raw escape bytes. */
export function parseAnsi(line: string): AnsiSegment[] {
  if (!hasAnsi(line)) return line ? [{ text: line, cls: '' }] : [];

  const state: SgrState = { fg: '', bold: false, dim: false, italic: false, underline: false };
  const out: AnsiSegment[] = [];
  let last = 0;
  ANSI_RE.lastIndex = 0;

  let m: RegExpExecArray | null;
  while ((m = ANSI_RE.exec(line)) !== null) {
    if (m.index > last) out.push({ text: line.slice(last, m.index), cls: stateCls(state) });
    if (m[1] !== undefined) applySgr(state, m[1]);
    last = m.index + m[0].length;
    if (ANSI_RE.lastIndex === m.index) ANSI_RE.lastIndex++;
  }
  if (last < line.length) out.push({ text: line.slice(last), cls: stateCls(state) });
  return out.filter((s) => s.text !== '');
}

const ERROR_RE = /^\s*(error|err!|fatal|✖|failed)/i;
const WARN_RE = /^\s*(warn|warning)/i;
const TS_RE = /^(\d{4}-\d{2}-\d{2}T\S+)(\s*)([\s\S]*)$/;

/**
 * Heuristic colouring for plain lines. Only applied when the line carries no
 * ANSI codes of its own, so we never fight the producer's colours.
 */
export function classifyLine(raw: string): AnsiSegment[] {
  const line = normalizeLine(raw);
  if (hasAnsi(line)) return parseAnsi(line);
  if (!line) return [];

  const ts = TS_RE.exec(line);
  if (ts) {
    const rest = ts[3] ?? '';
    return [
      { text: ts[1]!, cls: 'text-ansi-dim' },
      { text: ts[2] ?? '', cls: '' },
      ...(rest ? classifyLine(rest) : []),
    ].filter((s) => s.text !== '');
  }
  if (ERROR_RE.test(line)) return [{ text: line, cls: 'text-danger-fg' }];
  if (WARN_RE.test(line)) return [{ text: line, cls: 'text-warn-fg' }];
  return [{ text: line, cls: '' }];
}
