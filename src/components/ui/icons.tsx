/* FluxPad line-icon set — compact inline SVGs, no external deps. */
import type { CSSProperties } from "react";

const PATHS: Record<string, string[]> = {
  home: ["M3 10.5 12 3l9 7.5", "M5 10v10h14V10"],
  compass: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z", "m15.5 8.5-2 5-5 2 2-5 5-2Z"],
  activity: ["M3 12h4l3-8 4 16 3-8h4"],
  trending: ["M3 17l6-6 4 4 8-8", "M15 7h6v6"],
  trophy: ["M8 21h8", "M12 17v4", "M7 4h10v4a5 5 0 0 1-10 0V4Z", "M7 6H4v1a3 3 0 0 0 3 3", "M17 6h3v1a3 3 0 0 1-3 3"],
  star: ["M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.7l5.9-.9L12 3.5Z"],
  wallet: ["M3 7a2 2 0 0 1 2-2h13a1 1 0 0 1 1 1v3", "M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2H5a2 2 0 0 1-2-2Z", "M16 13h.01"],
  plus: ["M12 5v14", "M5 12h14"],
  rocket: ["M5 15c-1 2-1 5-1 5s3 0 5-1", "M9 15l-4-4c2-6 7-9 12-9 0 5-3 10-9 12Z", "M14 4h6v6", "M9.5 10.5a2 2 0 1 0 4 0 2 2 0 0 0-4 0Z"],
  wand: ["M15 4V2", "M15 10V8", "M11.5 6h-2", "M20.5 6h-2", "M17.8 3.2 16.4 4.6", "M17.8 8.8 16.4 7.4", "M13 9 3 19l2 2L15 11", "M13 9l2 2"],
  book: ["M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2V5Z", "M4 19a2 2 0 0 1 2-2h13"],
  signal: ["M4 18a12 12 0 0 1 16 0", "M8 14a6 6 0 0 1 8 0", "M12 19h.01"],
  gear: ["M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z", "M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3.9a7 7 0 0 0-2-1.2L14 3h-4l-.6 2.6a7 7 0 0 0-2 1.2l-2.3-.9-2 3.4 2 1.5A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.4 2.3-.9a7 7 0 0 0 2 1.2L10 21h4l.6-2.6a7 7 0 0 0 2-1.2l2.3.9 2-3.4-2-1.5c.1-.4.1-.8.1-1.2Z"],
  help: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z", "M9.5 9a2.5 2.5 0 1 1 3.4 2.3c-.8.3-1.4 1-1.4 1.9v.3", "M12 17h.01"],
  search: ["M21 21l-4.3-4.3", "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z"],
  menu: ["M4 6h16", "M4 12h16", "M4 18h16"],
  x: ["M6 6l12 12", "M18 6 6 18"],
  chevronLeft: ["m14 6-6 6 6 6"],
  chevronRight: ["m10 6 6 6-6 6"],
  chevronsLeft: ["m11 6-5 6 5 6", "m18 6-5 6 5 6"],
  chevronDown: ["m6 9 6 6 6-6"],
  copy: ["M9 9h10v12H9z", "M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"],
  external: ["M14 4h6v6", "M20 4 10 14", "M20 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5"],
  refresh: ["M21 12a9 9 0 1 1-2.6-6.4", "M21 3v6h-6"],
  check: ["m4 12 5 5L20 7"],
  clock: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z", "M12 7v5l3 3"],
  filter: ["M4 5h16", "M7 12h10", "M10 19h4"],
  user: ["M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z", "M4 21a8 8 0 0 1 16 0"],
  layers: ["m12 3 9 5-9 5-9-5 9-5Z", "m21 13-9 5-9-5", "m21 17-9 5-9-5"],
  zap: ["M13 3 4 14h6l-1 7 9-11h-6l1-7Z"],
  info: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z", "M12 11v5", "M12 8h.01"],
  alert: ["M12 3 2 20h20L12 3Z", "M12 10v4", "M12 17h.01"],
  sun: [
    "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z",
    "M12 2v2",
    "M12 20v2",
    "M4.9 4.9l1.4 1.4",
    "M17.7 17.7l1.4 1.4",
    "M2 12h2",
    "M20 12h2",
    "M6.3 17.7l-1.4 1.4",
    "M19.1 4.9l-1.4 1.4",
  ],
  moon: ["M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"],
  monitor: ["M3 5a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5Z", "M8 21h8", "M12 17v4"],
};

/**
 * Official brand glyphs (solid fill, not part of the stroke-icon set).
 * Faithful 24×24 adaptations of the official X and GitHub marks.
 */
const BRAND_PATHS: Record<string, string> = {
  x: "M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 4.35-5.981ZM16.463 18.666h1.833L7.084 4.126H5.117l11.346 14.54Z",
  github:
    "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12",
};

export type BrandIconName = keyof typeof BRAND_PATHS;

/** Solid-fill brand icon (X, GitHub) — mirrors the Icon API surface. */
export function BrandIcon({
  name,
  className = "",
  size = 16,
  style,
}: {
  name: string;
  className?: string;
  size?: number;
  style?: CSSProperties;
}) {
  const d = BRAND_PATHS[name] ?? "";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={className}
      style={style}
    >
      <path d={d} />
    </svg>
  );
}

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  className = "",
  size = 16,
  style,
}: {
  name: string;
  className?: string;
  size?: number;
  style?: CSSProperties;
}) {
  const paths = PATHS[name] ?? PATHS.info;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      style={style}
    >
      {paths.map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}
