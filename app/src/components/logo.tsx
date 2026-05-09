/**
 * CHAINFEED brand mark — "signal" graphic.
 *
 * Source dot with three radiating arcs, mirroring the official
 * docs/images/chainfeed_signal.svg artwork. The dot + first arc render
 * in the deep brand navy; the middle arc shifts to royal blue; the
 * outermost arc is the same royal but at low opacity so it reads as a
 * fading echo. Single-mark, scales cleanly from 16-px favicon to large
 * hero placement.
 *
 * Sizing model: the source SVG draws on a -13/-8/173/166 viewBox, with
 * the dot horizontally pinned at x=0 and the wave field reaching out
 * positive-x. We keep that viewBox so the proportions match the asset
 * exactly — `size` controls the rendered width; height auto-derives.
 */

interface LogoProps {
  size?: number;
  className?: string;
  showWordmark?: boolean;
}

const NAVY  = '#0A2472';
const ROYAL = '#1E5BC6';

export function Logo({ size = 28, className = '', showWordmark = false }: LogoProps) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <LogoMark size={size} />
      {showWordmark && (
        <span className="font-bold tracking-tight" style={{ fontSize: size * 0.85 }}>
          CHAINFEED
        </span>
      )}
    </span>
  );
}

export function LogoMark({ size = 28, className = '' }: { size?: number; className?: string }) {
  // Derive height from the SVG aspect ratio (173 wide / 166 tall ≈ 1.042).
  // Clamping height to size keeps existing call-sites that allotted a
  // square box visually-balanced — the dot still hugs the left edge.
  return (
    <svg
      width={size}
      height={size}
      viewBox="-13 -8 173 166"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label="CHAINFEED"
    >
      {/* Source dot */}
      <circle cx="0" cy="75" r="11" fill={NAVY} />
      {/* Inner wave — same navy as the dot */}
      <path
        d="M 26 45 A 32 32 0 0 1 26 105"
        fill="none"
        stroke={NAVY}
        strokeWidth="5"
        strokeLinecap="round"
      />
      {/* Middle wave — royal blue */}
      <path
        d="M 56 23 A 56 56 0 0 1 56 127"
        fill="none"
        stroke={ROYAL}
        strokeWidth="5"
        strokeLinecap="round"
      />
      {/* Outer wave — royal at 0.45 opacity, the "echo" stroke */}
      <path
        d="M 86 -1 A 82 82 0 0 1 86 151"
        fill="none"
        stroke={ROYAL}
        strokeWidth="5"
        strokeLinecap="round"
        opacity="0.45"
      />
    </svg>
  );
}
