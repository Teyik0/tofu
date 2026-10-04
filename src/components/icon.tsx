const shapes = {
  activity: "M2 12h5l3-8 4 16 3-8h5",
  alert: "m12 3 10 18H2L12 3Zm0 6v5m0 3v.01",
  arrowUp: "M12 19V5m-6 6 6-6 6 6",
  check: "m5 12 4 4L19 6",
  chevron: "m8 4 8 8-8 8",
  chevronDown: "m5 9 7 7 7-7",
  clock: "M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
  copy: "M9 9h12v12H9zM5 15H3V3h12v2",
  download: "M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4",
  edit: "m15 3 6 6M4 20l5-1L21 7a2 2 0 0 0-4-4L5 15l-1 5Z",
  file: "M5 3h9l5 5v13H5V3Zm9 0v6h5M8 13h8M8 17h6",
  folder: "M3 7V5h6l2 2h10v13H3V7Z",
  globe: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z",
  grid: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
  info: "M12 11v6M12 7v.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
  link: "m10 13 4-4M8 15l-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m4 2 2-2a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0",
  pause: "M8 5v14M16 5v14",
  peers:
    "M16 21v-3a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v3M22 21v-3a4 4 0 0 0-3-4M9 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8m7-8a4 4 0 0 1 0 8",
  play: "m8 4 12 8-12 8V4Z",
  plus: "M12 5v14M5 12h14",
  refresh: "M21 3v6h-6M3 21v-6h6M20 9a8 8 0 0 0-13-5L3 9m1 6a8 8 0 0 0 13 5l4-5",
  search: "M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  settings:
    "M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8M10 2h4l1 3 3 1 3-1 2 4-2 2v3l2 2-2 4-3-1-3 1-1 3h-4l-1-3-3-1-3 1-2-4 2-2v-3L1 9l2-4 3 1 3-1 1-3Z",
  shield: "m12 2 9 4v6c0 6-9 10-9 10S3 18 3 12V6l9-4Zm-4 10 3 3 5-6",
  trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7",
  upload: "M12 16V4m-5 5 5-5 5 5M4 16v4h16v-4",
  x: "m6 6 12 12M6 18 18 6",
} as const;

export type IconName = keyof typeof shapes;
export function Icon({
  name,
  size,
  className,
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      height={size ?? 18}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.7"
      viewBox="0 0 24 24"
      width={size ?? 18}
    >
      <path d={shapes[name]} />
    </svg>
  );
}

export function Logo() {
  return (
    <svg aria-hidden="true" fill="none" height="32" viewBox="0 0 32 32" width="32">
      <rect fill="#466548" height="13" rx="4" width="13" x="2" y="2" />
      <rect fill="#b9c9a7" height="13" rx="4" width="12" x="18" y="2" />
      <rect fill="#b9c9a7" height="12" rx="4" width="13" x="2" y="18" />
      <rect fill="#d7dfc9" height="12" rx="4" width="12" x="18" y="18" />
    </svg>
  );
}
