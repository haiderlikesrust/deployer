import type { SVGProps } from 'react';

/**
 * 16x16 currentColor stroke icons. No icon package — every glyph in the dashboard
 * lives here so the bundle stays dependency-free and the stroke weight stays uniform.
 */
type IconProps = SVGProps<SVGSVGElement> & { className?: string };

function base(props: IconProps) {
  return {
    viewBox: '0 0 16 16',
    width: 16,
    height: 16,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    focusable: false,
    ...props,
  };
}

export function Logo({ className = 'h-5 w-5', ...rest }: IconProps) {
  return (
    <svg
      viewBox="0 0 20 20"
      width={20}
      height={20}
      fill="none"
      aria-hidden
      focusable={false}
      className={className}
      {...rest}
    >
      <rect x="0.75" y="0.75" width="18.5" height="18.5" rx="5.25" stroke="currentColor" strokeWidth="1.5" opacity="0.55" />
      <path
        d="M7 6.5 10.5 10 7 13.5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M11.75 13.5h1.75" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
}

export const Plus = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M8 3.5v9M3.5 8h9" />
  </svg>
);

export const ExternalLink = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M9.5 3h3.5v3.5" />
    <path d="M13 3 8 8" />
    <path d="M12 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h2.5" />
  </svg>
);

export const Copy = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
    <path d="M10.5 5.5v-1a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h1" />
  </svg>
);

export const Check = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="m3.5 8.5 3 3 6-7" />
  </svg>
);

export const ChevronDown = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="m4 6 4 4 4-4" />
  </svg>
);

export const ChevronRight = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="m6 4 4 4-4 4" />
  </svg>
);

export const Search = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="7.25" cy="7.25" r="3.75" />
    <path d="m10.25 10.25 2.5 2.5" />
  </svg>
);

export const Trash = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M3 4.5h10M6.5 4.5V3.5a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1" />
    <path d="M4.5 4.5 5 12.5a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1l.5-8" />
  </svg>
);

export const Play = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M5.5 3.75 12 8l-6.5 4.25z" />
  </svg>
);

export const Stop = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="4" y="4" width="8" height="8" rx="1.5" />
  </svg>
);

export const Restart = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M13 8a5 5 0 1 1-1.6-3.65" />
    <path d="M13 2.5V5h-2.5" />
  </svg>
);

export const AlertTriangle = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M7.15 3.1 2.3 11.4a1 1 0 0 0 .86 1.5h9.68a1 1 0 0 0 .86-1.5L8.85 3.1a1 1 0 0 0-1.7 0Z" />
    <path d="M8 6.5v3" />
    <path d="M8 11.4h.01" />
  </svg>
);

export const AlertCircle = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="8" cy="8" r="5.75" />
    <path d="M8 5v3.5" />
    <path d="M8 10.75h.01" />
  </svg>
);

export const Info = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="8" cy="8" r="5.75" />
    <path d="M8 7.25v3.75" />
    <path d="M8 5.1h.01" />
  </svg>
);

export const X = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="m4 4 8 8M12 4l-8 8" />
  </svg>
);

export const Terminal = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="2" y="3" width="12" height="10" rx="1.5" />
    <path d="m5 6.75 2 1.75-2 1.75" />
    <path d="M8.75 10.5h2.5" />
  </svg>
);

export const GitBranch = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="4.75" cy="3.75" r="1.75" />
    <circle cx="4.75" cy="12.25" r="1.75" />
    <circle cx="11.25" cy="5.5" r="1.75" />
    <path d="M4.75 5.5v5" />
    <path d="M11.25 7.25c0 2.25-2 3-4 3.25" />
  </svg>
);

export const Clock = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="8" cy="8" r="5.75" />
    <path d="M8 4.75V8l2.25 1.5" />
  </svg>
);

export const Download = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M8 2.75v7" />
    <path d="m5 7 3 3 3-3" />
    <path d="M3 11.5v1a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-1" />
  </svg>
);

export const ArrowDown = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M8 3v10" />
    <path d="m4.25 9.25 3.75 3.75 3.75-3.75" />
  </svg>
);

export const Server = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="2" y="2.5" width="12" height="4.5" rx="1.25" />
    <rect x="2" y="9" width="12" height="4.5" rx="1.25" />
    <path d="M4.5 4.75h.01M4.5 11.25h.01" />
  </svg>
);

export const HardDrive = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M2 9h12" />
    <path d="M3.75 3h8.5l1.75 6v3a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1V9z" />
    <path d="M4.75 11.25h.01M7 11.25h.01" />
  </svg>
);

export const Box = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M8 2.25 13.5 5v6L8 13.75 2.5 11V5z" />
    <path d="m2.5 5 5.5 2.75L13.5 5" />
    <path d="M8 7.75v6" />
  </svg>
);

export const Eye = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M1.75 8S4 3.75 8 3.75 14.25 8 14.25 8 12 12.25 8 12.25 1.75 8 1.75 8Z" />
    <circle cx="8" cy="8" r="1.75" />
  </svg>
);

export const EyeOff = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M6.4 4.15A5.7 5.7 0 0 1 8 3.75C12 3.75 14.25 8 14.25 8a10.6 10.6 0 0 1-2.15 2.7" />
    <path d="M4.2 5.5A10.7 10.7 0 0 0 1.75 8S4 12.25 8 12.25c.79 0 1.5-.17 2.14-.44" />
    <path d="m2.5 2.5 11 11" />
  </svg>
);

export const Wrap = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M2.5 4h11" />
    <path d="M2.5 8h8.25a2.25 2.25 0 1 1 0 4.5H8.5" />
    <path d="m9.75 11 -1.5 1.5 1.5 1.5" />
    <path d="M2.5 12.5h3" />
  </svg>
);

export const Loader = ({ className = '', ...rest }: IconProps) => (
  <svg
    viewBox="0 0 16 16"
    width={16}
    height={16}
    fill="none"
    aria-hidden
    focusable={false}
    className={`animate-spin ${className}`}
    {...rest}
  >
    <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.25" />
    <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);
