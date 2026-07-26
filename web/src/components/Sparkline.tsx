/** Dependency-free SVG sparkline with an area fill — for the metrics strip. */
export function Sparkline({
  values,
  width = 160,
  height = 36,
  stroke = 'var(--color-accent-fg)',
  className = '',
}: {
  values: number[];
  width?: number;
  height?: number;
  stroke?: string;
  className?: string;
}) {
  if (values.length < 2) {
    return <div className={`h-9 w-40 rounded bg-surface-2 ${className}`} aria-hidden />;
  }
  const max = Math.max(...values, 1e-6);
  const pad = 2;
  const w = width - pad * 2;
  const h = height - pad * 2;
  const pts = values.map((v, i) => [pad + (i / (values.length - 1)) * w, pad + h - (Math.min(v, max) / max) * h] as const);
  const line = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${(pad + w).toFixed(1)},${(pad + h).toFixed(1)} L${pad},${(pad + h).toFixed(1)} Z`;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} className={className} aria-hidden>
      <path d={area} fill={stroke} opacity={0.12} />
      <path d={line} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
