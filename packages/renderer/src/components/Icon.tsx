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
  panel: "M3 3h18v18H3Z M9 3v18 M13 8l4 4-4 4",
  anchor: "M12 22V8 M5 12H2a10 10 0 0 0 20 0h-3 M8 12h8 M15 5a3 3 0 1 0-6 0a3 3 0 1 0 6 0",
  blocks: "M10 22V7a1 1 0 0 0-1-1H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5a1 1 0 0 0-1-1H2 M15 2h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1",
  "settings-2": "M14 17H5 M19 7h-9 M20 17a3 3 0 1 0-6 0a3 3 0 1 0 6 0 M10 7a3 3 0 1 0-6 0a3 3 0 1 0 6 0",
  search: "M21 21l-5-5 M18 10a8 8 0 1 0-16 0a8 8 0 1 0 16 0",
  message: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z",
  "sun-moon": "M12 8a5 5 0 0 0 4 8a6 6 0 1 1-4-8 M19 3v4 M17 5h4 M20 12h2 M16 19l1 2 M8 21l-1 1 M3 16l-1 1 M2 8H0 M6 3L5 1",
  keyboard: "M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2 M6 9h.01 M10 9h.01 M14 9h.01 M18 9h.01 M6 12h.01 M10 12h.01 M14 12h.01 M18 12h.01 M7 16h10",
  languages: "M4 5h12 M10 3v2 M13 5c-1 6-4 8-9 10 M6 8c1 3 3 5 6 7 M14 21l4-10 4 10 M16 17h4",
  grid: "M3 3h6v6H3z M15 3h6v6h-6z M3 15h6v6H3z M15 15h6v6h-6z",
  settings: "M4 7h16 M4 17h16 M8 4v6 M16 14v6",
  chart: "M4 20V4 M4 20h17 M9 16V9 M14 16V5 M19 16v-5",
  plus: "M12 5v14 M5 12h14",
  "chevron-right": "M9 6l6 6-6 6",
  down: "M6 9l6 6 6-6",
  archive: "M3 3h18v5H3z M5 8v13h14V8 M9 12h6",
  clock: "M21 12a9 9 0 1 0-18 0a9 9 0 1 0 18 0 M12 7v5l3 2",
  book: "M3 3h7l2 3 2-3h7v17h-7l-2 2-2-2H3Z M12 6v16",
  globe: "M21 12a9 9 0 1 0-18 0a9 9 0 1 0 18 0 M3 12h18 M12 3c-5 5-5 13 0 18c5-5 5-13 0-18",
  "folder-open": "M3 10V5h6l2 3h10v3 M3 10h20l-3 10H2Z",
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
  // The composer's send button ([UI 对齐 06] #30): prototype `.send` is an
  // accent square with this arrow, not a labelled button.
  arrow: "M12 19V5 M5 12l7-7 7 7",
  // Prototype `paths.check`: the tool rows' completed-step glyph.
  check: "M5 12l4 4L19 6",
  // The two glyphs the prototype's remaining management pages use and the
  // shell did not carry yet ([UI 对齐 09] #33): `refresh` for the provider card's
  // 同步模型列表 and `shield` for the remote page's 自建 PiDock Gateway mode
  // (also `remoteAccessPage`'s mode picker). Same path data as `app.js:2`.
  refresh: "M20 7a9 9 0 1 0 1 9 M20 2v6h-6",
  shield: "M12 2l9 4v6c0 6-9 10-9 10S3 18 3 12V6Z M8 12l3 3 5-6",
  // 「未归属任务」 (#136): the S07 tree's inbox glyph for tasks no workspace owns.
  inbox: "M22 12h-6l-2 3h-4l-2-3H2 M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z",
  // Prototype `paths.code`: the capability row's Extension glyph
  // (`capabilityRow()` picks book/server/archive/code by kind).
  code: "M8 6l-6 6 6 6 M16 6l6 6-6 6 M14 3l-4 18",
  // [Pencil T14] #149 the two bottom-left destinations of design S06: `grid`
  // (blocks) is 能力管理 and `sliders` (settings-2) is 设置. Same 24px stroke
  // vocabulary as the rest of the set so the compact rail stays one weight.
  sliders: "M4 6h9 M17 6h3 M4 12h3 M11 12h9 M4 18h11 M19 18h1 M13 4v4 M7 10v4 M15 16v4",
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
