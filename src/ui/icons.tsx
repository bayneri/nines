/** A small outline icon set (after Tabler Icons, MIT), drawn at 24×24. */
const PATHS = {
  web: ['M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'M3 9h18', 'M6.5 6.5h.01', 'M9 6.5h.01'],
  service: ['M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'M3 16a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'M7 7h.01', 'M7 17h.01'],
  database: ['M4 6c0 1.66 3.58 3 8 3s8-1.34 8-3-3.58-3-8-3-8 1.34-8 3', 'M4 6v6c0 1.66 3.58 3 8 3s8-1.34 8-3V6', 'M4 12v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6'],
  queue: ['M4 6h16', 'M4 12h16', 'M4 18h10', 'M17 16l2 2-2 2'],
  infra: ['M12 4 4 8l8 4 8-4-8-4', 'M4 12l8 4 8-4', 'M4 16l8 4 8-4'],
  group: ['M7 18V10a3 3 0 0 1 3-3h4', 'M17 18v-4a3 3 0 0 0-3-3', 'M12 3l2 4-2 0', 'M5 16l2 2 2-2', 'M15 16l2 2 2-2'],
  undo: ['M9 14 4 9l5-5', 'M4 9h10.5a5.5 5.5 0 0 1 0 11H11'],
  redo: ['M15 14l5-5-5-5', 'M20 9H9.5a5.5 5.5 0 0 0 0 11H13'],
  code: ['M7 8l-4 4 4 4', 'M17 8l4 4-4 4', 'M14 4l-4 16'],
  plus: ['M12 5v14', 'M5 12h14'],
  link: ['M5 12h14', 'M13 18l6-6', 'M13 6l6 6'],
  close: ['M18 6 6 18', 'M6 6l12 12'],
  back: ['M5 12h14', 'M5 12l6 6', 'M5 12l6-6'],
  chevron: ['M9 6l6 6-6 6'],
  check: ['M5 12l5 5L20 7'],
  cross: ['M18 6 6 18', 'M6 6l12 12'],
  info: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18', 'M12 8h.01', 'M11 12h1v4h1'],
  question: ['M8 8a3.5 3 0 0 1 3.5-3h1A3.5 3 0 0 1 16 8a3 3 0 0 1-2 3 3 4 0 0 0-2 4', 'M12 19v.01'],
  trash: ['M4 7h16', 'M10 11v6', 'M14 11v6', 'M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12', 'M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3'],
  book: ['M3 19a9 9 0 0 1 9 0 9 9 0 0 1 9 0', 'M3 6a9 9 0 0 1 9 0 9 9 0 0 1 9 0', 'M3 6v13', 'M12 6v13', 'M21 6v13'],
  grid: ['M4 4h6v6H4z', 'M14 4h6v6h-6z', 'M4 14h6v6H4z', 'M14 14h6v6h-6z'],
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, label }: { name: IconName; size?: number; label?: string }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
