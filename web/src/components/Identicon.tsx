/**
 * Deterministic gradient avatar per app name — gives every project a stable
 * visual identity the way Vercel's project icons do, with zero assets.
 */
const PALETTES: [string, string][] = [
  ['#818cf8', '#38bdf8'],
  ['#f472b6', '#a78bfa'],
  ['#34d399', '#38bdf8'],
  ['#fbbf24', '#f472b6'],
  ['#60a5fa', '#34d399'],
  ['#a78bfa', '#f472b6'],
  ['#2dd4bf', '#818cf8'],
  ['#fb923c', '#f43f5e'],
];

function hash(name: string): number {
  let h = 5381;
  for (let i = 0; i < name.length; i++) h = ((h << 5) + h + name.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function Identicon({ name, size = 'md', className = '' }: { name: string; size?: 'sm' | 'md' | 'lg'; className?: string }) {
  const h = hash(name);
  const [from, to] = PALETTES[h % PALETTES.length];
  const angle = (h >> 3) % 360;
  const px = size === 'sm' ? 'h-5 w-5 text-[9px]' : size === 'lg' ? 'h-9 w-9 text-sm' : 'h-7 w-7 text-[11px]';
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-black/70 select-none ${px} ${className}`}
      style={{ backgroundImage: `linear-gradient(${angle}deg, ${from}, ${to})` }}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}
