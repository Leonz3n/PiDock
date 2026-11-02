---
version: alpha
name: PiDock Quiet Ledger
description: A calm, factual desktop workbench for running coding agents across projects, tasks and sessions. Warm paper surfaces, ink-blue interaction, text-first status.
colors:
  canvas: "#F7F7F4"
  surface: "#FFFFFF"
  surface-sunken: "#EFEFEA"
  sidebar: "#F1F1EC"
  code-surface: "#F3F3EF"
  ink: "#17191C"
  ink-secondary: "#3E4750"
  muted: "#66707A"
  line: "#E3E2DC"
  line-strong: "#CFCFC7"
  primary: "#2B4ACB"
  primary-hover: "#1F3AA8"
  primary-soft: "#E9EEFC"
  on-primary: "#FFFFFF"
  attention: "#8A5300"
  attention-soft: "#FBF0DC"
  danger: "#A93630"
  danger-soft: "#FBEAE8"
  settled: "#2F4858"
  settled-soft: "#E8EDF0"
  overlay: "#17191CBD"
  focus: "#4E6BE0"
typography:
  display:
    fontFamily: "Inter, Noto Sans SC, PingFang SC, system-ui, sans-serif"
    fontSize: 30px
    fontWeight: 600
    lineHeight: 38px
    letterSpacing: -0.02em
  title-lg:
    fontFamily: "Inter, Noto Sans SC, PingFang SC, system-ui, sans-serif"
    fontSize: 24px
    fontWeight: 600
    lineHeight: 32px
    letterSpacing: -0.01em
  title-md:
    fontFamily: "Inter, Noto Sans SC, PingFang SC, system-ui, sans-serif"
    fontSize: 20px
    fontWeight: 600
    lineHeight: 28px
    letterSpacing: -0.01em
  title-sm:
    fontFamily: "Inter, Noto Sans SC, PingFang SC, system-ui, sans-serif"
    fontSize: 16px
    fontWeight: 600
    lineHeight: 24px
    letterSpacing: 0em
  body:
    fontFamily: "Inter, Noto Sans SC, PingFang SC, system-ui, sans-serif"
    fontSize: 14px
    fontWeight: 400
    lineHeight: 22px
    letterSpacing: 0em
  body-strong:
    fontFamily: "Inter, Noto Sans SC, PingFang SC, system-ui, sans-serif"
    fontSize: 14px
    fontWeight: 500
    lineHeight: 22px
    letterSpacing: 0em
  meta:
    fontFamily: "Inter, Noto Sans SC, PingFang SC, system-ui, sans-serif"
    fontSize: 12px
    fontWeight: 400
    lineHeight: 18px
    letterSpacing: 0em
  label:
    fontFamily: "Inter, Noto Sans SC, PingFang SC, system-ui, sans-serif"
    fontSize: 12px
    fontWeight: 500
    lineHeight: 16px
    letterSpacing: 0.01em
  eyebrow:
    fontFamily: "Inter, Noto Sans SC, PingFang SC, system-ui, sans-serif"
    fontSize: 11px
    fontWeight: 600
    lineHeight: 16px
    letterSpacing: 0.08em
  button:
    fontFamily: "Inter, Noto Sans SC, PingFang SC, system-ui, sans-serif"
    fontSize: 13px
    fontWeight: 500
    lineHeight: 20px
    letterSpacing: 0em
  mono:
    fontFamily: "JetBrains Mono, SFMono-Regular, Menlo, monospace"
    fontSize: 12px
    fontWeight: 400
    lineHeight: 18px
    letterSpacing: 0em
  mono-strong:
    fontFamily: "JetBrains Mono, SFMono-Regular, Menlo, monospace"
    fontSize: 12px
    fontWeight: 500
    lineHeight: 18px
    letterSpacing: 0em
rounded:
  xs: 4px
  sm: 6px
  md: 8px
  lg: 10px
  xl: 14px
  full: 9999px
spacing:
  xxs: 4px
  xs: 8px
  sm: 12px
  md: 16px
  lg: 24px
  xl: 32px
  2xl: 40px
  3xl: 56px
  4xl: 72px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: "{spacing.sm}"
    height: 32px
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
    textColor: "{colors.on-primary}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: "{spacing.sm}"
    height: 32px
  button-secondary-hover:
    backgroundColor: "{colors.surface-sunken}"
  button-ghost:
    backgroundColor: transparent
    textColor: "{colors.ink-secondary}"
    typography: "{typography.button}"
    rounded: "{rounded.sm}"
    padding: "{spacing.xs}"
    height: 28px
  button-danger:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.on-primary}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: "{spacing.sm}"
    height: 32px
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "{spacing.sm}"
    height: 34px
  input-focus:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
  sidebar:
    backgroundColor: "{colors.sidebar}"
    textColor: "{colors.ink-secondary}"
    typography: "{typography.body}"
    width: 264px
  topbar:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    height: 56px
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "{spacing.lg}"
  card-sunken:
    backgroundColor: "{colors.surface-sunken}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "{spacing.md}"
  list-row:
    backgroundColor: transparent
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "{spacing.sm}"
    height: 44px
  list-row-hover:
    backgroundColor: "{colors.surface-sunken}"
  list-row-selected:
    backgroundColor: "{colors.primary-soft}"
    textColor: "{colors.ink}"
  status-pill-attention:
    backgroundColor: "{colors.attention-soft}"
    textColor: "{colors.attention}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    padding: "{spacing.xs}"
  status-pill-danger:
    backgroundColor: "{colors.danger-soft}"
    textColor: "{colors.danger}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    padding: "{spacing.xs}"
  status-pill-running:
    backgroundColor: "{colors.primary-soft}"
    textColor: "{colors.primary}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    padding: "{spacing.xs}"
  status-pill-settled:
    backgroundColor: "{colors.settled-soft}"
    textColor: "{colors.settled}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    padding: "{spacing.xs}"
  tab-active:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body-strong}"
    rounded: "{rounded.md}"
    height: 32px
  composer:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.xl}"
    padding: "{spacing.md}"
  drawer:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.xl}"
    padding: "{spacing.lg}"
    width: 360px
  code-inline:
    backgroundColor: "{colors.code-surface}"
    textColor: "{colors.ink-secondary}"
    typography: "{typography.mono}"
    rounded: "{rounded.xs}"
    padding: "{spacing.xxs}"
  text-meta:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.muted}"
    typography: "{typography.meta}"
  hairline:
    backgroundColor: "{colors.line}"
    height: 1px
  hairline-strong:
    backgroundColor: "{colors.line-strong}"
    height: 1px
  focus-ring:
    backgroundColor: "{colors.focus}"
    height: 2px
  overlay-scrim:
    backgroundColor: "{colors.overlay}"
---

# PiDock · Quiet Ledger

## Overview

PiDock is a local desktop workbench where one developer runs several coding
agents in parallel. Work is organised as **项目（Project）→ 任务（Task）→
会话（Session）**. Each task owns a workspace made of Git repositories and plain
directories; each session is one conversation with an agent. The interface must
make that hierarchy obvious, keep the facts of the workspace visible, and then
get out of the way.

The visual direction is **Quiet Ledger**: a calm, paper-like operations desk.
It borrows the discipline of an accounting ledger — ruled lines, aligned
figures, terse labels — and the restraint of a native desktop tool. It is not a
marketing dashboard, not a chat toy, and not a terminal costume. Surfaces are
warm off-white, structure comes from hairline rules rather than cards and
shadows, and a single ink-blue carries every interactive affordance. Status is
written in words first and colour second.

**Audience.** Developers who already use a terminal and an editor, work on
multiple branches at once, and care whether a path is a shared original
directory or an isolated worktree.

**Emotional target.** Settled, legible, trustworthy. The user should be able to
answer three questions within two seconds of looking at any screen: *Where am
I? What is the agent doing? What is the next action?*

### Design principles

1. **Facts before decoration.** Paths, branches, commits, workspace mode and
   run state are rendered as inspectable text, never inferred from a friendly
   label. If PiDock cannot verify a fact, it says so.
2. **One conversation at a time.** The task workspace is a reading column, not
   a mosaic of panels. Context is revealed on demand in a drawer; it never
   permanently steals width from the conversation.
3. **State is a sentence.** “等待你确认 · 3 分钟” beats a coloured dot.
   Colour only reinforces a state that is already named.
4. **Calm density.** Desktop information density without visual noise: 44px
   rows, 14px body text, one accent, hairline dividers, generous outer margins.
5. **Honest affordances.** Disabled, unavailable, loading, stale and “not wired
   yet” are distinct, labelled states. No spinner pretends to be progress and
   no sample data is presented as real.

### Reference points

Editorial data tables (ledger alignment, tabular numerals), native macOS/Windows
utility windows (restrained chrome, keyboard-first), and documentation readers
(long-form measure, quiet margins). Stitch should synthesise these qualities,
not copy any product's layout.

## Colors

The palette is warm neutral paper plus one ink-blue. There is **no green
anywhere** in the product — not in accents, statuses, charts or illustrations.
Completion and success are expressed with ink-blue and the word “已完成”; the
absence of green is a deliberate brand and product constraint.

### Surfaces

- **Canvas (#F7F7F4):** warm paper used for the application background and the
  top bar. It separates the window from the pure-white working surfaces.
- **Surface (#FFFFFF):** conversation column, cards, dialogs, drawers.
- **Surface sunken (#EFEFEA):** hovered rows, inset fields, segmented-control
  tracks, read-only facts.
- **Sidebar (#F1F1EC):** the navigation column, one step warmer than canvas.
- **Code surface (#F3F3EF):** inline code, paths, commit hashes.

### Text

- **Ink (#17191C):** titles, message text, primary labels. Near-black, not pure
  black.
- **Ink secondary (#3E4750):** supporting prose, table values, icon strokes.
- **Muted (#66707A):** timestamps, counts, placeholder text, de-emphasised meta.
- **Line (#E3E2DC):** default hairline divider and input border.
- **Line strong (#CFCFC7):** selected/active borders, table rules that need
  emphasis.

### Interaction

- **Primary (#2B4ACB):** ink-blue for primary buttons, links, focus emphasis,
  selected navigation, running state and the brand π. This is a deeper, less
  saturated blue than a typical SaaS CTA so it sits calmly on warm paper.
- **Primary hover (#1F3AA8):** pressed and hover fill.
- **Primary soft (#E9EEFC):** selected row, running-status pill, subtle
  highlights. Text on this surface must be `ink`, not `primary`, except for the
  status label.
- **Focus (#4E6BE0):** 2px focus ring, 2px offset. Never remove focus outlines.

### Status

Status colours are used only inside text pills, 6px dots or 1px rules — never as
full-bleed backgrounds.

- **Attention (#8A5300 on #FBF0DC):** waiting for confirmation, schedule
  skipped, action required. Amber, not orange-red.
- **Danger (#A93630 on #FBEAE8):** execution failed, invalid path, provider
  error, destructive confirmation.
- **Settled (#2F4858 on #E8EDF0):** completed, archived, stopped, read-only. A
  cool slate reads as “done” without borrowing green's “success” cliché.
- **Running (#2B4ACB on #E9EEFC):** executing, connecting, preparing a worktree.

Forbidden: any green hue (`#00A86B`, `#22C55E`, emerald, mint, lime), purple AI
gradients, red/green diff styling outside a true diff, and colour as the only
carrier of meaning.

## Typography

**Inter** for Latin and UI text, **Noto Sans SC** for Simplified Chinese, with
**PingFang SC** as the macOS fallback. **JetBrains Mono** is reserved for
machine facts: paths, branch names, commit SHAs, model IDs, ports, keyboard
shortcuts and inline code. Never set prose in mono.

- **Display (30/38, 600):** app-level page titles only (工作台, 设置). At most
  one per screen.
- **Title LG (24/32, 600):** task title in the workspace header, project title.
- **Title MD (20/28, 600):** dialog titles, section headers, empty-state
  headline.
- **Title SM (16/24, 600):** card titles, drawer section titles.
- **Body (14/22, 400):** conversation text, descriptions, form help. The
  reading measure is 68–76 Latin characters; in Chinese, 32–38 characters.
- **Body strong (14/22, 500):** selected navigation, row titles, emphasised
  inline text. Do not use semibold for whole paragraphs.
- **Meta (12/18, 400):** timestamps, helper text, secondary row values.
- **Label (12/16, 500):** pills, field labels, table column headers.
- **Eyebrow (11/16, 600, 0.08em, uppercase):** rare section kickers such as
  `TASK WORKSPACE`; never used for Chinese copy.
- **Button (13/20, 500):** button and tab labels.
- **Mono (12/18):** paths and technical identifiers; `mono-strong` for the
  active branch or commit.

Use tabular numerals for counts, durations, token totals and timestamps. Chinese
copy uses full-width punctuation (，。：、) while paths, commands and IDs keep
half-width characters. Do not letter-space Chinese text. Avoid bold weights
above 600; hierarchy comes from size, colour and spacing.

## Layout

### Window and shell

The product is a desktop application, not a responsive website. Design at
**1440 × 900** and verify at **1180 × 800**, **960 × 720** and the minimum
**720 × 560**. Never design a mobile layout.

- **Navigation sidebar:** 264px fixed, full height, `sidebar` surface, 1px
  right rule. It contains brand + host status, primary destinations, the project
  list, and a bottom utility block. It can be collapsed to a 64px icon rail by
  the user; at ≤960px it becomes an overlay drawer.
- **Top bar:** 56px, canvas surface, hairline bottom rule. Breadcrumb on the
  left; search, page-level actions and window controls zone on the right.
- **Main column:** fills remaining width. Content max-width 1040px, left-aligned
  with 32px padding; never centre-align an entire page.
- **Conversation column:** max-width 760px, centred within the main column, with
  at least 48px of side breathing room at 1440px. The composer shares this
  measure.
- **Context drawer:** 360px right-side drawer, white, hairline left rule, opened
  by “任务详情”; overlays the conversation at ≤1180px with a scrim. Closed by
  default. It contains facts (sources, branch, commit, schedule, usage), not the
  primary workflow.
- **Task workspace:** top bar 56px + task header 88px + session tab row 44px +
  conversation (flex) + composer 132px. The composer is sticky at the bottom;
  the conversation is the only scrolling region.

### Breakpoints

| Width | Behaviour |
| --- | --- |
| ≥1181px | Sidebar + main + optional drawer. Conversation 760px. |
| ≤1180px | Drawer becomes an overlay with scrim; conversation grows. |
| ≤960px | Sidebar collapses into an icon rail; labels appear on hover. Project list becomes a popover. |
| ≤850px | Session tabs collapse into “会话 (3) ▾”; meta columns in tables hide. |
| ≤720px | Rail becomes a top “菜单” button; top bar actions collapse into a `···` menu. No horizontal scrolling; content padding 16px. |

### Spacing and rhythm

8px base grid. Use 4px only for icon-to-label gaps. Section separation: 32px
inside a page, 24px inside a card, 16px between form fields, 8px between a label
and its control. Table rows 44px tall; compact lists 36px. Never mix 6px and 8px
radii in one component.

### Keyboard and focus

`⌘K` search/jump, `⌘N` new task, `⌘Enter` send, `Esc` close overlay, `↑/↓`
navigate lists, `Shift+F10` context menu. Every interactive element is reachable
by Tab and shows the 2px focus ring. Do not use hover as the only reveal for
essential actions.

## Elevation & Depth

Structure is built from **hairline rules and tonal surfaces**, not drop shadows.
The default card has a 1px `line` border and no shadow. Nested surfaces step
down in tone (`surface` → `surface-sunken` → `code-surface`), not up in shadow.

Shadows exist only for elements that float above the page: popovers, menus,
drawers, dialogs and toasts. Use `0 12px 32px rgba(23, 25, 28, 0.12)` plus a 1px
line border. The modal scrim is `overlay` at full opacity. No glassmorphism, no
blurred translucent panels, no neumorphism.

Z-order: content < sticky composer < drawer < popover/menu < dialog < toast.
Never stack two dialogs. A destructive confirmation may sit above a dialog as a
single sheet, not a nested modal.

## Shapes

- **Radii:** inputs and buttons 8px, list rows 6px, cards 10px, composer and
  dialogs 14px, pills fully rounded. The sidebar and top bar have square edges.
- **Borders:** 1px hairline. Use `line` by default, `line-strong` for active
  selection and table headers. Buttons carry a border even when filled, to keep
  edges crisp on warm paper.
- **Pills:** 24px tall, 10px horizontal padding, 6px dot, 12px/500 label. Text
  is always present; a dot alone is not a status.
- **Iconography:** 16px and 20px line icons, 1.6px stroke, round caps, current
  colour. Use a restrained set (folder, git-branch, terminal, clock, plus,
  search, chevron, check, alert, stop, archive, settings, plug, sparkle).
  Never mix filled and outline icons in the same row. No emoji as UI icons.
- **Brand:** the π mark is a geometric, single-stroke π in a 28px rounded-square
  ink-blue container, optically centred. Use it at the sidebar top, in the
  empty state and in the About panel. Do not rotate, outline or add a glow.
- **Illustrations:** none. Empty states use one 20px icon, one sentence and one
  action. No 3D blobs, no AI sparkle illustrations.

## Components

### Buttons

Three levels: primary (ink-blue fill, white label) for the single forward
action; secondary (white fill, hairline border, ink label) for neutral actions;
ghost (transparent, secondary text) for row and toolbar actions. Destructive
actions use danger fill only inside a confirmation, otherwise a danger-text
ghost button. Height 32px, 8px radius, 12px horizontal padding, 13px/500 label.
Icon-only buttons are 28×28px with a tooltip. Disabled buttons keep their shape,
drop to 40% opacity and must explain why on hover or inline.

### Inputs and forms

Labels sit above the control, 12px/500, with optional 12px helper text below.
Inputs are 34px tall, 8px radius, white fill, 1px `line`; focus adds a 2px
`focus` ring and keeps the border. Use a 1px rule group rather than a heavy box
for short settings forms. Validation appears inline in `danger`, next to the
field, and never as a toast alone. Selects show the current value and a chevron;
never hide the selected model or permission level behind an unlabelled icon.

### Navigation

Destinations: 工作台, 需要处理 (with count), 定时任务, 项目 (list with add
button), then a separated utility block: 能力与设置, host status, app version.
Active item: `primary-soft` background, `ink` label, 2px ink-blue left rule;
inactive: transparent, `ink-secondary`. Project rows include a 6px status dot
only when a task needs attention. Hover uses `surface-sunken`, not blue.

### Lists and tables

Rows are the primary information unit. A row has: leading icon or status dot
(16px), a title (body-strong), a secondary fact line (meta, muted, mono for
paths), trailing state pill and one overflow action. Rows are separated by
hairline rules, not cards. Selected row: `primary-soft`, ink text, no shadow.
Numbers right-align with tabular figures. Empty lists show a 20px icon, a
reason (“这个项目还没有任务”), and a single action.

### Task workspace

- **Task header:** breadcrumb above, `title-lg` task name, and a mono fact strip
  directly beneath: workspace mode (`独立 worktree` or `共享目录`), branch, short
  commit, and source count. Actions: 新建会话 (primary), 任务详情 (ghost),
  `···` (rename, archive, clean up).
- **Session tabs:** 32px tall, one row, up to four visible plus a `+`; overflow
  opens “全部会话”. Active tab is white with a hairline border; inactive tabs
  are transparent. Each tab shows a 6px status dot and truncated title. A
  read-only or archived session shows a `只读` / `已归档` prefix, never a lock
  emoji.
- **Run bar:** sits between the tab row and the conversation only while a run is
  active or failed. 36px tall, `surface-sunken`, hairline top/bottom. Content:
  status dot + “执行中 00:42 · 正在读取 src/host.ts” + 停止 (ghost danger). On
  failure: “上次执行失败 · 读取文件被拒绝” + 查看原因 + 重试. On completion the
  bar disappears; the result stays in the conversation.
- **Conversation:** agent and user messages are distinguished by alignment and
  a narrow 2px left rule, not by chat bubbles. Use full-width blocks: role label
  (label) + timestamp (meta) + content (body) + optional tool card. User
  messages get a `surface-sunken` block with 10px radius; agent messages sit on
  canvas with no container. Code blocks use `code-surface`, mono 12/18, a
  filename header and a 1px rule; no syntax-rainbow themes beyond ink, muted,
  blue and amber.
- **Tool result card:** 1px border, 10px radius, 12px padding, white. Header row:
  icon + tool name (body-strong) + status pill + duration (meta). Body: one-line
  summary and an expandable “查看详情”. Never show raw JSON by default.
- **Approval card:** amber left rule 3px, `attention-soft` header strip, title
  “需要你确认”, the operation, target, exact content to send and impact. Actions:
  拒绝 (secondary), 批准本次 (primary). A countdown shows expiry in meta. This
  card is inline in the conversation, never a modal.
- **Composer:** white, 14px radius, 1px `line`, 16px padding. Top area:
  auto-growing textarea, placeholder “描述你要完成的工作，@ 引用文件，$ 选择技能，/ 打开命令”.
  Reference chips sit above the textarea. Bottom row: `+` attach, `@` reference,
  `$` skill, `/` command, permission selector (“自动执行” / “每次询问”), model selector, token/context
  counter (meta), send button (primary, 32px square with arrow). While running,
  the send button becomes a square stop button; drafts stay editable. Focus ring
  wraps the entire composer, not the inner textarea.

### Status and feedback

Every status is a pill with text and an optional 6px dot:
`执行中` blue, `等待确认` amber, `已完成` slate, `已停止` slate outline,
`失败` danger, `已归档` slate outline, `已过期` slate outline.
Use “未接线”, “未验证”, “不可用” as explicit labels when a real capability is
missing; never colour them as success. Toasts appear bottom-right, 320px wide,
12px radius, auto-dismiss after 5s, with one action. Errors that block work are
inline banners at the top of the affected region, with a concrete next step.

### Dialogs, drawers, sheets

Dialogs: 480–720px wide, 14px radius, white, 24px padding, title 20/28, actions
right-aligned, primary on the far right. The scrim is `overlay`; clicking it
closes non-destructive dialogs. Destructive confirmations use a 3px danger left
rule and list exactly what will be removed. Drawers slide from the right, 360px,
with a sticky header and a close button. Long flows (new task, cleanup) use a
full-height sheet with a left step rail, not a carousel.

### Empty, loading and error states

Empty state: one 20px icon, a title (title-md), one explanatory sentence, one
primary action, and an optional secondary link. Loading uses skeleton rules
(no shimmer gradients) for lists, and a determinate progress line for multi-step
operations such as fetching and creating a worktree. Errors always state what
happened, what was preserved, and the next action; they never offer a vague
“重试” without context.

## Do's and Don'ts

**Do**

- Show the actual path and whether it is an isolated worktree or the shared
  original directory, using mono text.
- Write status as a Chinese sentence plus a pill; include elapsed time and the
  current step while running.
- Keep exactly one primary (ink-blue) action per view.
- Use hairline rules, warm paper and whitespace to create structure.
- Preserve the conversation measure and let the drawer overlay rather than
  squeeze it.
- Use real Chinese copy from the product surface, never lorem ipsum.
- Design the 720×560 minimum window: no clipped labels, no overlapping controls,
  no horizontal scroll.

**Don't**

- Do not use green, mint, emerald or lime for success, charts or accents.
- Do not use gradients, glass blur, neon glows, purple AI gradients or 3D blobs.
- Do not build a KPI dashboard with sparklines, donut charts or “insights” tiles.
- Do not show service, browser, terminal, environment or remote-access panels;
  those are out of scope for the first release.
- Do not turn every message into a rounded bubble or every section into a card.
- Do not use emoji as icons, status indicators or bullets.
- Do not hide essential facts (branch, path, model, permission) behind a hover
  or an unlabelled icon.
- Do not invent data, counts, completion percentages or success states. If a
  value is unknown, write “未知” or “未接线”.
- Do not use more than two font families on one screen (sans + mono).

## Application Notes

The first release contains these surfaces. They share the shell and tokens
above; detailed per-screen prompts live in `STITCH-BRIEF.md`.

1. **工作台** — attention strip, active tasks, project list, unassigned tasks
   (历史未归属任务，不自动猜测项目), today's schedules.
2. **需要处理** — grouped inbox for waiting approvals, failures, unread
   completions and skipped scheduled runs.
3. **项目** — sources (Git repos + plain directories), active/archived tasks,
   project schedules and project settings.
4. **新建任务** — task basics and source selection; per-repository choice between
   an existing working directory and an isolated worktree; fetch and preparation
   progress; partial-failure recovery.
5. **任务工作区** — task header, session tabs, conversation, run bar, composer,
   on-demand details drawer.
6. **全部会话** — searchable session list, active/archived groups, run state,
   unread markers.
7. **定时任务** — schedule list and editor with natural-language recurrence,
   timezone, next runs, permission, enable switch and run history.
8. **能力与设置** — Providers, MCP and Skills tabs; local credentials; connection
   and source state; changes take effect at session boundaries.
9. **归档与清理** — task archive action; cleanup inventory for archived tasks
   with preserve/export choices and receipts.
10. **恢复状态** — moved path, identity mismatch, partial worktree creation and
    missing provider, each with explicit recovery actions.

Global copy rules: use 简体中文 for all product copy; keep technical identifiers
in their original form; use “任务” never “工作空间” for the middle layer; use
“会话” for a conversation; use “独立 worktree” and “共享目录” as the two
workspace modes. Never call a session a task or a project a workspace.
