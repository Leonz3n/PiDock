/**
 * Tool rail tab bookkeeping ([UI 对齐 04] #28).
 *
 * The prototype renders `.work-tabs` — one tab per open tool and a single
 * `.work-content` — so the rail always shows exactly one panel. These pure
 * helpers keep the two questions the rail asks out of the store and the page:
 * which tab is active after an open/close, and which panel the strip shows
 * when the stored tab is no longer open (a restored task, or a tab closed by a
 * host refresh).
 */

import type { ToolPanel } from "../stores/ui";

/**
 * The tab shown after `closed` leaves the strip: a still-open current tab wins,
 * otherwise the most recently opened survivor (the strip keeps the open order).
 */
export function nextActivePanel(
  panels: readonly ToolPanel[],
  closed: ToolPanel,
  current: ToolPanel | undefined,
): ToolPanel | undefined {
  if (current !== undefined && current !== closed && panels.includes(current)) return current;
  return panels.length > 0 ? panels[panels.length - 1] : undefined;
}

/**
 * The tab the rail must render for the stored state. A tab that is not open
 * (stale store value) falls back to the last opened panel, so the strip and the
 * active panel cannot disagree.
 */
export function resolveActivePanel(
  panels: readonly ToolPanel[],
  stored: ToolPanel | undefined,
): ToolPanel | undefined {
  if (panels.length === 0) return undefined;
  if (stored !== undefined && panels.includes(stored)) return stored;
  return panels[panels.length - 1];
}

/** A page problem the user marked for the Agent (prototype 「验证记录」). */
export type BrowserIssueMark = { id: string; label: string; needsRelocation: boolean };

type BrowserEvidence = { consoleErrors: string[]; failedRequests: { url: string; errorText: string }[] };

/**
 * Panel state that must survive a tab swap (#28 review P2-3).
 *
 * The rail mounts only the active panel (the prototype's single `.work-
 * content`), so a panel's `useState` resets whenever the user switches tabs.
 * The prototype keeps these values in its global `state` instead, so switching
 * `.work-tabs` never loses the selected browser page, the markers, the terminal
 * scrollback or the selected service. They live here, keyed per task.
 */
export type ToolPanelState = {
  browserPageId?: string;
  browserMarks?: BrowserIssueMark[];
  browserAnnotation?: string;
  browserEvidence?: BrowserEvidence;
  browserNotice?: string;
  terminalLines?: string[];
  terminalValue?: string;
  runtimeServiceId?: string;
};

/**
 * Apply one panel's patch to the task's stored panel state without dropping the
 * fields the other panels own (they all share one record per task).
 */
export function mergeToolPanelState(
  current: ToolPanelState | undefined,
  patch: ToolPanelState,
): ToolPanelState {
  return { ...current, ...patch };
}
