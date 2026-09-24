/**
 * Line icons for the application shell ([UI 对齐 01] #25, [UI 对齐 03] #27).
 *
 * The paths are copied from `prototypes/pidock-ui/app.js` so the shell and the
 * A baseline draw the same glyphs at the same weight (17px, stroke 1.7). Only
 * the glyphs the shell uses are kept here; pages add their own when they are
 * aligned. `link` is the protocol glyph: the prototype has no protocol tool,
 * and the 协议 panel is about generated artifacts and their local bindings.
 * `play`/`stop` are the prototype's `toggle-run` glyphs, used by the header's
 * local-service run toggle ([UI 对齐 03] #27) and the service rows' run button
 * ([UI 对齐 04] #28). `close` is the tab-close / 收起工具区 glyph.
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
  branch: "M6 6v12 M6 12c9 0 12-1 12-6 M4 4a2 2 0 1 0 4 0a2 2 0 1 0-4 0 M4 20a2 2 0 1 0 4 0a2 2 0 1 0-4 0 M16 4a2 2 0 1 0 4 0a2 2 0 1 0-4 0",
  server: "M3 3h18v7H3z M3 14h18v7H3z M6 6h1 M6 17h1 M11 6h7 M11 17h7",
  terminal: "M4 6l6 6-6 6 M13 18h7",
  file: "M5 2h9l5 5v15H5Z M14 2v6h5 M8 12h8 M8 16h8",
  link: "M10 14l4-4 M8 16l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0 M16 8l2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0",
  more: "M5 12h.01 M12 12h.01 M19 12h.01",
  play: "M8 4l12 8-12 8Z",
  stop: "M5 5h14v14H5z",
  close: "M6 6l12 12 M18 6L6 18",
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
