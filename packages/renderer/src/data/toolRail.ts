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
