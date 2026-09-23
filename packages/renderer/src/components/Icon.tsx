/**
 * Line icons for the application shell ([UI 对齐 01] #25).
 *
 * The paths are copied from `prototypes/pidock-ui/app.js` so the shell and the
 * A baseline draw the same glyphs at the same weight (17px, stroke 1.7). Only
 * the glyphs the shell uses are kept here; pages add their own when they are
 * aligned.
 */

export const ICON_PATHS = {
  grid: "M3 3h6v6H3z M15 3h6v6h-6z M3 15h6v6H3z M15 15h6v6h-6z",
  settings: "M4 7h16 M4 17h16 M8 4v6 M16 14v6",
  chart: "M4 20V4 M4 20h17 M9 16V9 M14 16V5 M19 16v-5",
  plus: "M12 5v14 M5 12h14",
  down: "M6 9l6 6 6-6",
  archive: "M3 3h18v5H3z M5 8v13h14V8 M9 12h6",
  clock: "M21 12a9 9 0 1 0-18 0a9 9 0 1 0 18 0 M12 7v5l3 2",
  book: "M3 3h7l2 3 2-3h7v17h-7l-2 2-2-2H3Z M12 6v16",
  globe: "M21 12a9 9 0 1 0-18 0a9 9 0 1 0 18 0 M3 12h18 M12 3c-5 5-5 13 0 18c5-5 5-13 0-18",
  folder: "M3 5h6l2 3h10v12H3Z",
  key: "M14 7a5 5 0 1 0 3 5L22 7l-3-3-3 3Z M4 9h.01",
} as const;

export type IconName = keyof typeof ICON_PATHS;

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      data-icon={name}
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`h-[17px] w-[17px] shrink-0 ${className ?? ""}`}
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}
