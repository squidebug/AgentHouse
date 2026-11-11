import type { SVGProps } from 'react';

// Thin stroke icons matching the approved design (no icon font, no emoji).
type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 18, children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const PlusIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5 V19 M5 12 H19" />
  </Svg>
);

export const CloseIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6.5 6.5 L17.5 17.5 M17.5 6.5 L6.5 17.5" />
  </Svg>
);

export const ChevronIcon = ({ open, ...p }: IconProps & { open?: boolean }) => (
  <Svg {...p} style={{ transform: `rotate(${open ? 180 : 0}deg)`, transition: 'transform .15s' }}>
    <path d="M6 9 L12 15 L18 9" />
  </Svg>
);

export const SunIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5 V4.5 M12 19.5 V21.5 M2.5 12 H4.5 M19.5 12 H21.5 M5.3 5.3 L6.7 6.7 M17.3 17.3 L18.7 18.7 M5.3 18.7 L6.7 17.3 M17.3 6.7 L18.7 5.3" />
  </Svg>
);

export const MoonIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 14.5 A8 8 0 1 1 9.5 4 A6.5 6.5 0 0 0 20 14.5 Z" />
  </Svg>
);

export const SendIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 19 V5 M6 11 L12 5 L18 11" />
  </Svg>
);

export const PulseIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 12 H7 L10 5 L14 19 L17 12 H21" />
  </Svg>
);

export const CopyIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="8" y="8" width="12" height="12" rx="2.5" />
    <path d="M16 8 V6 A2 2 0 0 0 14 4 H6 A2 2 0 0 0 4 6 V14 A2 2 0 0 0 6 16 H8" />
  </Svg>
);

export const TerminalIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
    <path d="M7.5 9.5 L10.5 12 L7.5 14.5 M12.5 15 H16.5" />
  </Svg>
);

export const ChatIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 5.5 H19 A1.5 1.5 0 0 1 20.5 7 V15 A1.5 1.5 0 0 1 19 16.5 H10 L6 19.5 V16.5 H5 A1.5 1.5 0 0 1 3.5 15 V7 A1.5 1.5 0 0 1 5 5.5 Z" />
    <path d="M7.5 9.5 H16.5 M7.5 12.5 H13.5" />
  </Svg>
);

export const BranchIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="6.5" cy="6" r="2" />
    <circle cx="6.5" cy="18" r="2" />
    <circle cx="17.5" cy="12" r="2" />
    <path d="M6.5 8 V16 M6.5 12 C6.5 12 9 12 15.5 12" />
  </Svg>
);

export function Grip({ className }: { className?: string }) {
  return (
    <svg className={className} width="8" height="14" viewBox="0 0 8 14" aria-hidden="true" style={{ flex: 'none', fill: 'currentColor' }}>
      {[3, 7, 11].map((y) => (
        <g key={y}>
          <circle cx="2" cy={y} r="1.2" />
          <circle cx="6" cy={y} r="1.2" />
        </g>
      ))}
    </svg>
  );
}
