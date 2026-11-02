---
version: alpha
name: PiDock Apple Flat
description: A quiet Chinese-first desktop agent workbench. Cool neutral surfaces, one blue accent, a project-task-session hierarchy, and conversation-first layouts.
colors:
  canvas: "#FFFFFF"
  surface: "#FFFFFF"
  sidebar: "#F6F6F8"
  surface-subtle: "#FBFBFD"
  surface-inset: "#F3F4F7"
  ink: "#24262B"
  secondary: "#555B66"
  muted: "#6F7682"
  decorative: "#A0A6B1"
  line: "#E9E9ED"
  border-control: "#D3D8E1"
  primary: "#2768DF"
  primary-hover: "#205BC9"
  primary-soft: "#EAF0FC"
  on-primary: "#FFFFFF"
  attention: "#875C20"
  attention-soft: "#FFF4E4"
  danger: "#B23C3C"
  danger-soft: "#FFF3F2"
  neutral-status: "#596271"
  neutral-status-soft: "#F1F2F5"
  focus: "#2768DF"
  overlay: "#252B3966"
typography:
  page-title:
    fontFamily: "Inter, Noto Sans SC, PingFang SC, Microsoft YaHei, system-ui, sans-serif"
    fontSize: 26px
    fontWeight: 600
    lineHeight: 36px
    letterSpacing: -0.02em
  task-title:
    fontFamily: "Inter, Noto Sans SC, PingFang SC, Microsoft YaHei, system-ui, sans-serif"
    fontSize: 24px
    fontWeight: 600
    lineHeight: 34px
    letterSpacing: -0.01em
  section:
    fontFamily: "Inter, Noto Sans SC, PingFang SC, Microsoft YaHei, system-ui, sans-serif"
    fontSize: 16px
    fontWeight: 600
    lineHeight: 24px
    letterSpacing: 0em
  body:
    fontFamily: "Inter, Noto Sans SC, PingFang SC, Microsoft YaHei, system-ui, sans-serif"
    fontSize: 14px
    fontWeight: 400
    lineHeight: 24px
    letterSpacing: 0em
  label:
    fontFamily: "Inter, Noto Sans SC, PingFang SC, Microsoft YaHei, system-ui, sans-serif"
    fontSize: 13px
    fontWeight: 500
    lineHeight: 20px
    letterSpacing: 0em
  meta:
    fontFamily: "Inter, Noto Sans SC, PingFang SC, Microsoft YaHei, system-ui, sans-serif"
    fontSize: 12px
    fontWeight: 400
    lineHeight: 18px
    letterSpacing: 0em
  mono:
    fontFamily: "JetBrains Mono, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: 12px
    fontWeight: 400
    lineHeight: 20px
    letterSpacing: 0em
rounded:
  xs: 4px
  sm: 6px
  md: 8px
  lg: 10px
  xl: 12px
  dialog: 16px
  full: 9999px
spacing:
  xxs: 4px
  xs: 8px
  sm: 12px
  md: 16px
  lg: 24px
  xl: 32px
  2xl: 40px
  3xl: 48px
components:
  page-canvas:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
  text-meta:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.muted}"
    typography: "{typography.meta}"
  decorative-stroke:
    backgroundColor: "{colors.decorative}"
    height: 1px
  hairline:
    backgroundColor: "{colors.line}"
    height: 1px
  control-border:
    backgroundColor: "{colors.border-control}"
    height: 1px
  focus-ring:
    backgroundColor: "{colors.focus}"
    height: 2px
  overlay:
    backgroundColor: "{colors.overlay}"
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "{spacing.sm}"
    height: 34px
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
    textColor: "{colors.on-primary}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.secondary}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    height: 34px
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "{spacing.sm}"
    height: 36px
  sidebar:
    backgroundColor: "{colors.sidebar}"
    textColor: "{colors.secondary}"
    typography: "{typography.label}"
    width: 238px
  selected-navigation:
    backgroundColor: "{colors.primary-soft}"
    textColor: "{colors.primary-hover}"
    rounded: "{rounded.sm}"
  topbar:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.secondary}"
    height: 58px
  composer:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.xl}"
    padding: "{spacing.md}"
  user-message:
    backgroundColor: "{colors.surface-inset}"
    textColor: "{colors.ink}"
    rounded: "{rounded.xl}"
    padding: "{spacing.md}"
  agent-message:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.secondary}"
    typography: "{typography.body}"
  tool-record:
    backgroundColor: "{colors.surface-subtle}"
    textColor: "{colors.secondary}"
    rounded: "{rounded.md}"
    padding: "{spacing.sm}"
  inspector:
    backgroundColor: "{colors.surface-subtle}"
    textColor: "{colors.secondary}"
    width: 300px
  dialog:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.dialog}"
    padding: "{spacing.lg}"
  status-running:
    backgroundColor: "{colors.primary-soft}"
    textColor: "{colors.primary-hover}"
    typography: "{typography.meta}"
    rounded: "{rounded.sm}"
  status-attention:
    backgroundColor: "{colors.attention-soft}"
    textColor: "{colors.attention}"
    typography: "{typography.meta}"
    rounded: "{rounded.sm}"
  status-failed:
    backgroundColor: "{colors.danger-soft}"
    textColor: "{colors.danger}"
    typography: "{typography.meta}"
    rounded: "{rounded.sm}"
  status-neutral:
    backgroundColor: "{colors.neutral-status-soft}"
    textColor: "{colors.neutral-status}"
    typography: "{typography.meta}"
    rounded: "{rounded.sm}"
---

# PiDock · Apple Flat

## Overview

PiDock is a local macOS / Windows desktop application for organising and running Agent conversations. All product-facing copy is Simplified Chinese; keep paths, branch names, Provider names, model IDs, MCP and Skills in their original technical form.

The fixed domain hierarchy is **项目 Project → 任务 Task → 会话 Session**. A project holds reusable Git repository and plain-directory sources. A task selects sources and owns its working context. A session is one conversation within a task. “任务工作区” describes files and runtime context; it is not a fourth navigation level or a top-level “Workspace”.

Visual direction: restrained Apple-like desktop utility, flat cool grey-white surfaces, crisp typography, fine dividers and one blue accent. The conversation is the primary working surface. Reveal configuration and facts on demand. Design for sustained reading and repeated use.

**Authority and flexibility.** This is a design candidate based on the 2026-11-02 A prototype, not a design approval or production implementation. Product boundaries come from GitHub #135 and the current user request. Tokens and dimensions below are proposed design values for further refinement. Improve readability, alignment and interaction without changing product semantics. The prototype is a reference, not a pixel-perfect target. The B screenshot is optional layout comparison; do not combine both navigation systems in one default screen.

**Priority.** Current product constraints → semantic flows in FLOWS.md → this design system → SCREENS.md → screenshot details. Do not copy the prototype review toolbar, fake data, tiny labels or implementation-only notices into the product.

## Colors

Use cool neutrals. White conversation canvas (#FFFFFF), soft grey navigation (#F6F6F8), slightly recessed support surfaces (#FBFBFD / #F3F4F7). The single interaction blue is **#2768DF**, with #205BC9 hover and #EAF0FC tint. Avoid a warm cream/paper cast.

Primary text is #24262B, supporting text #555B66 and meaningful metadata #6F7682. #A0A6B1 is reserved for nonessential decorative text and must not carry instructions, paths, errors or states. #E9E9ED is a subtle structural divider; use #D3D8E1 plus clearly defined control shapes where a stronger boundary is needed. A divider is not the sole means of identifying a control.

State uses text first: running/connecting in blue, awaiting confirmation/skipped in amber (#875C20 on #FFF4E4), errors/destructive confirmation in red (#B23C3C on #FFF3F2), complete/stopped/archived in slate (#596271 on #F1F2F5). A success state may use a neutral checkmark. **Do not use green anywhere in the PiDock interface.**

Every status must have a Chinese label and sufficient contrast; a coloured dot is supplementary. No purple AI gradients, neon accents, decorative colour coding by project or large saturated status cards.

## Typography

For Stitch, use Inter + Noto Sans SC with native system fallbacks. In implementation, native macOS/Windows system fonts are acceptable; do not require proprietary Apple fonts on Windows. Use one sans family stack plus a mono stack for paths, branches, command/output details and short IDs.

Page titles 26/36, task titles 24/34, sections 16/24, body 14/24, labels and buttons 13/20, meaningful metadata 12/18. Default weight 400, labels 500, headings 600. Do not space Chinese characters. Negative tracking applies to Latin titles only. Long Chinese messages should remain easy to read.

These sizes deliberately improve on the initial prototype's very small timestamps and controls. Preserve its calm hierarchy, not its smallest font sizes. Normal text targets WCAG AA 4.5:1; large text 3:1; meaningful control/focus boundaries target 3:1. Show ellipsised paths with an explicit reveal/copy action; full paths cannot be hover-only. Use tabular numerals for timestamps and counters.

## Layout

### Primary shell: A

Reference viewport **1440×900**. Validate minimum desktop window **720×560**. Intermediate windows should interpolate naturally; do not turn narrow desktop windows into a mobile product.

- Sidebar 238px, continuous pale grey, one right divider. Brand π + PiDock, project/task search, 项目总览, 定时任务, project tree, then bottom 已归档 and 设置. No separate global attention centre is required for this release.
- Top bar 58px with a restrained project/task breadcrumb. Avoid large page subtitles, extra utility bars or duplicated task controls.
- Task title region around 96–124px, session strip 44px, conversation flexes in remaining height. Aim for top bar + task title + tabs within 220px at a 900px-high window; compress at 560px height.
- Conversation and composer align to the same reading column, about 720–790px max width, centred in the available main region. Messages scroll independently; composer stays visible.
- Task information is closed by default. When opened at wide widths it is a 300px side panel. At ≤1200px it overlays the main content. Include an explicit close button and Escape; never reduce the conversation to an unusable sliver.
- At ≤800px, navigation becomes a menu button and overlay drawer. It must retain project/task switching AND 项目总览 / 定时任务 / 已归档 / 设置. Do not hide all global destinations when collapsing a rail.
- At 720×560, compress the title region, hide decorative labels and reduce outer padding before removing useful information. No page horizontal overflow; no overlap between composer and dialog actions.

### Optional comparison: B

A 64px global icon rail + roughly 220–242px project/task column, slightly tighter title region and flatter rectangular controls. This is a layout exploration, not a second product mode requirement. If Stitch explores B, render it as a separate labelled candidate.

### Rhythm and focus

Use a 4px base scale with 8/12/16/24/32px working intervals. Settings/project pages use about 32–40px outer padding; dialogs 24px; narrow windows 16–22px. Lists use one clean divider between rows. Allow variable row height for long paths rather than clipping.

All actions are keyboard reachable and visibly focused. Enter sends, Shift+Enter adds a line; IME composition must not send. Cmd/Ctrl+K opens search. Escape closes the current overlay. Session labels behave as a tablist; arrow keys change focused sessions. Do not copy prototype-only left/right style-switch shortcuts into production. Modal focus stays inside the dialog and returns to its trigger on close.

## Elevation & Depth

Flat is the default: solid white and grey surfaces, 1px dividers, no shadow on ordinary rows or content cards. Reserve a very subtle shadow for floating menus, dialogs and overlay drawers. Optional composer shadow is barely perceptible and not needed to define the boundary.

Use an unobtrusive scrim for blocking dialogs. No glass panels, large blur, gradients, glossy controls, floating tool docks or false macOS traffic lights. Apple-like means proportion, clarity and restraint; the app still works naturally on Windows.

## Shapes

Inputs/buttons 8px radius; selected rows and small status tags 6px; support cards 8–10px; composer/user messages 12px; dialogs 16px. Square shell boundaries. Avoid making everything a large pill.

Outline icons at 16/18/20px, 1.5–1.75px strokes. Optical alignment matters more than decorative detail. Centre the geometric π mark both horizontally and vertically in its blue rounded square. Use the same geometry in navigation, Agent identity and empty state. No emoji icons or decorative AI sparkles.

## Components

### Navigation and project overview

Keep projects distinct from task rows. Expanding one project reveals its tasks; selecting a task reveals its sessions in the main area. Historical unassigned tasks stay explicitly 未归属 until the user chooses a project; do not infer assignment from names or paths. Support an honest loading/empty/unavailable state rather than a populated fake sidebar.

Project overview uses a task list with name, type, source summary, session count and state, followed by reusable sources. Modest counts are optional; omit decorative KPI charts. New/edit project and source actions are explicit. A rename preserves identity; removing a source reference never deletes original files or silently rebinds existing tasks.

### Task header and information panel

Show task name, source count, ordinary/scheduled type and current execution state. A mixed task must not be labelled entirely isolated just because one source uses worktree. Use “包含独立 worktree” or display “1 个独立副本 · 1 个共享来源”. Individual source rows distinguish **Git · 已有目录**, **Git · 独立 worktree**, **普通目录 · 共享原文件**. Branch, baseline and actual path are inspectable in the information panel. Unknown/unavailable values are explicit; never fabricate a successful fetch or commit.

The task menu contains rename, archive/restore and the separate cleanup flow. There is no permanent file tree, browser or command console.

### Sessions

Up to four visible tabs, new-session + and 全部会话. Keep the current session visible when more than four exist. All-sessions view supports search and active/archived groups, plus rename/archive/restore/delete. Every session retains its own draft, permission, model and conversation.

Archived sessions retain history and may be explicitly restored to continue. Keep “归档会话”, “删除会话” and “清理任务” separate. To start fresh, create a new session; do not silently empty history under the same identity. Deletion confirmation states affected history/draft, retained task/files and the effect on scheduled-run records.

### Conversation and composer

User messages use restrained right-aligned pale grey blocks; Agent prose sits directly on white with π identity and timestamp. Body remains readable. Expandable tool records show file/command/MCP tool, status and concise result; details can show working directory, exit code and output. These are read-only Agent records, not a terminal or independent file/diff workspace.

Composer has textarea, optional context/Skill chip row, attachment/context entry and permissions at lower left, explicitly selected Provider/model at lower right and send/stop. Preserve keyboard behaviour and draft while running. A Skill chip includes a revealable local source. `$` opens skill selection; do not introduce a complex slash-command marketplace. Essential model identity must distinguish two profiles offering the same model.

Model changes apply at safe turn boundaries. Historical messages show the model actually used, not today's selection. Context percentage is separate from cumulative token usage; show unknown when unknown. Do not invent cost or add a full usage-reporting product.

### Execution, permissions and error states

States: 就绪, 执行中, 等待确认, 停止中, 已停止, 失败, 已完成, 已归档; expired/rejected approvals are explicit. While the same task has unfinished execution or approval, another session may edit its draft but cannot start a conflicting write/execution. Do not add a global lock across independent tasks.

Show stop while running. Stopping does not imply rollback. Archiving/deleting in-flight sessions first stops execution and reclaims resources; retain a pending state until completion. Recovery does not replay completed operations automatically.

An approval presents the concrete operation, target, path, exact command/content and impact. “批准一次” and “拒绝本次” apply to the reviewed request only. Choose inline expanded card or a review dialog; do not replace inspectable content with an unexplained shield icon. Read-only mode must clearly block write actions. Missing credentials, invalid paths, failed fetches and identity mismatches must show cause, preserved data and a targeted recovery action. A network failure is not proof that an external operation never happened.

### Creation and source preparation

Task basics → source selection → per-repository directory mode/baseline → path preview → preparation/result. Allow multi-repository + ordinary-directory mixes and ordinary-directory-only tasks. Existing Git directories share original files. Worktree is a first-release capability, not an “upcoming” option. Each worktree has its own branch/path from the selected repository and successful fresh fetch baseline. Other selected directories remain shared.

Show per-source progress, preserving completed sources on partial failure. Failed fetch cannot quietly fall back to cached success. Resume preparation or repair path/identity explicitly; never adopt another directory silently. Do not use a fabricated overall percentage if progress cannot be measured.

### Scheduled tasks

List, rule editor and execution history share the same task identity. Rule fields: prompt, explicit Provider/model, permission, once/repeating time, timezone, enabled/paused state. New-rule-default-paused is a design proposal from the prototype. Saving a draft rule is distinct from enabling it.

Each trigger creates a new independent session in the SAME task workspace; results can be opened and continued. Busy task including pending approval → skip with reason. App running/closed window background → can schedule; explicit quit or sleep → no execution/no catch-up/no automatic wake. Invalid Provider/model/credentials/path → named failure, no silent substitution. Show next run only when calculated from the actual rule and timezone; reference images may use labelled illustrative times.

### Settings

Use exactly the lean groups 模型服务 / MCP 连接 / Skills / 通用. Provider: named profile, endpoint, local private credential status, editable model list, errors and selection in conversation. Support add/edit/remove without showing secrets in prose, logs or screenshots.

MCP: named configuration, transport/target, enabled state, connecting/connected/disconnected/failed states, error explanation and recover/connect action. A conversation can show the used tool and source. Never imply that saving a configuration guarantees connectivity or Host permission. Skills: local path, name/description, load state, enabled state, load error and use in conversation. Changes apply at safe boundaries. Do not add Packages/Extensions store, codemode or remote device setup.

### Archive and cleanup

Task archive preserves history/files and pauses schedule. Restore does not run or re-enable automatically. Cleanup is a separate explicit inventory for archived tasks: sessions/drafts/records, managed worktrees, any retained code/copy and shared original sources. Detect uncommitted or undelivered worktree changes; preserve before removal. Shared repositories, existing working directories and plain directories are never deleted by cleanup. Show per-item results and recovery for partial failure. Export choices may be explored only if supported; do not make a complex export centre a new release dependency.

## Do's and Don'ts

**Keep:** project → task → session; existing directories AND independent worktrees; explicit shared-file facts; minimal navigation; conversation-first canvas; Provider/MCP/Skills; scheduled independent conversations; session and task lifecycle distinctions; state and error honesty; macOS + Windows; wide and minimum desktop frames.

**Improve freely:** optical spacing, typography, contrast, metadata density, control grouping, dialog vs sheet for long forms, readable permission/model selectors, the inspector width and details arrangement. Explain material departures from the prototype.

**Exclude:** internal terminal/terminal input; browser/page marking; service/process orchestration panels; environment templates; port allocation; protocol binding; independent file explorer/diff workbench; complex cross-project usage reports; remote/mobile/device pairing; generic Packages/Extensions marketplace. Read-only tool output inside the conversation is allowed.

**Never copy from references:** bottom A/B review switcher, DESIGN REVIEW footer, debug IDs, mock error toggles, fake “success” as verified data, tiny low-contrast essential text, source-level script architecture, or the other Quiet Ledger package's warm palette/navigation. Do not add account login, team billing, collaboration roles or cloud deployment requirements without a product decision.

Generate polished screen designs and key states for review. Any HTML/code export remains a design reference; it does not authorise production implementation or mark GitHub acceptance complete.
