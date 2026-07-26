/** Shared formatting helpers. Kept dependency-free on purpose (no clsx, no date-fns). */

export function cn(...parts: Array<string | false | null | undefined>): string {
  let out = '';
  for (const p of parts) {
    if (!p) continue;
    out = out ? `${out} ${p}` : p;
  }
  return out;
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function absTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString();
}

/** `12s`, `1m 42s`, `2h 05m`. Returns '—' when there is nothing to measure. */
export function formatDuration(fromIso: string | null | undefined, toIso?: string | null): string {
  if (!fromIso) return '—';
  const from = new Date(fromIso).getTime();
  if (Number.isNaN(from)) return '—';
  const to = toIso ? new Date(toIso).getTime() : Date.now();
  if (Number.isNaN(to)) return '—';
  return formatSeconds(Math.max(0, Math.round((to - from) / 1000)));
}

export function formatSeconds(total: number): string {
  if (!Number.isFinite(total) || total < 0) return '—';
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm ? `${h}h ${String(rm).padStart(2, '0')}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

/** `up 4h 12m` style uptime, from a container startedAt. */
export function formatUptime(startedAtIso: string | null | undefined): string | null {
  if (!startedAtIso) return null;
  const t = new Date(startedAtIso).getTime();
  if (Number.isNaN(t)) return null;
  return `up ${formatSeconds(Math.max(0, Math.round((Date.now() - t) / 1000)))}`;
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

export function formatBytes(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (n < 1000) return `${n} B`;
  let v = n;
  let i = 0;
  while (v >= 1000 && i < BYTE_UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : digits)} ${BYTE_UNITS[i]}`;
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

/** `https://github.com/owner/repo.git` -> `github.com/owner/repo` */
export function shortRepo(url: string | null | undefined): string {
  if (!url) return '';
  let s = url.trim();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  s = s.replace(/^git@/, '').replace(/^([^/]+):(?!\/)/, '$1/');
  s = s.replace(/^[^@/]+@/, '');
  s = s.replace(/\.git$/i, '');
  s = s.replace(/\/+$/, '');
  return s;
}

export function shortSha(sha: string | null | undefined, len = 7): string {
  if (!sha) return '';
  return sha.slice(0, len);
}
