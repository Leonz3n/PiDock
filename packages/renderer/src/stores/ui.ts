import { create } from "zustand";
import type { ConfigRowDraft } from "../data/configRows";
import { nextActivePanel } from "../data/toolRail";

export const TOOL_PANELS = ["runtime", "protocol", "browser", "files", "terminal", "logs"] as const;

export type ToolPanel = (typeof TOOL_PANELS)[number];

export type ModalState =
  | { type: "sessions"; taskId: string; filter: "active" | "archived" }
  | { type: "rename-task"; taskId: string; value: string }
  | { type: "rename-session"; taskId: string; sessionId: string; value: string }
  | { type: "archive-task"; taskId: string }
  | { type: "cleanup"; taskId: string }
  | { type: "new-task"; projectId: string }
  | { type: "config-diff"; environmentId: string; draftKey: string; rows: ConfigRowDraft[]; taskId?: string }
  | { type: "project-directories"; projectId: string }
  | { type: "task-sources"; taskId: string }
  | { type: "service-recipe"; environmentId: string; recipeId?: string }
  | { type: "pair-device" }
  | { type: "provider-edit"; providerId?: string }
  | { type: "project-list" }
  | { type: "project-edit"; projectId?: string }
  | { type: "project-delete"; projectId: string }
  | { type: "environment-list"; projectId: string }
  | { type: "environment-edit"; projectId: string; environmentId?: string }
  | { type: "environment-delete"; environmentId: string }
  | { type: "add-capability"; kind: "skill" | "extension" | "package" | "mcp" }
  | { type: "schedule-edit"; scheduleId: string }
  | { type: "permission"; taskId: string; sessionId: string }
  | { type: "model-picker"; taskId: string; sessionId: string }
  | { type: "thinking-picker"; taskId: string; sessionId: string }
  | { type: "context"; taskId: string; sessionId: string }
  | { type: "capability-detail"; capabilityId: string }
  | { type: "retry"; taskId: string; sessionId: string }
  | { type: "remote-preview" }
  | { type: "repo-binding" }
  | { type: "delivery"; taskId: string }
  | { type: "composer-info"; taskId: string; topic: "skills" | "session" | "help" }
  | null;

type Toast = { id: string; text: string };

type UiState = {
  panels: Record<string, ToolPanel[]>;
  /**
   * Per task, the tool tab the rail shows ([UI 对齐 04] #28). The prototype
   * renders `.work-tabs` with a single `.work-content`, so opening several
   * tools no longer stacks every panel: the tab strip keeps the open order and
   * this holds the active one (absent = derive the last opened).
   */
  activePanel: Record<string, ToolPanel | undefined>;
  /**
   * Per task, whether the user holds the task browser ([UI 对齐 01] #25). The
   * browser panel writes it from the Host's takeover result so the shell
   * summary bar can render the same controller the panel shows.
   */
  browserTakeover: Record<string, boolean>;
  modal: ModalState;
  toasts: Toast[];
  attentionFilter: "all" | "approval" | "failed" | "expired" | "completed-unread";
  togglePanel: (taskId: string, panel: ToolPanel) => void;
  /** Tab click: show this open tool without closing the others. */
  setActivePanel: (taskId: string, panel: ToolPanel) => void;
  /**
   * Tab close and the rail's 「收起工具区」. Closing a tab only drops the panel
   * from the rail: it never touches services, browser pages or terminals — the
   * Host keeps owning those ([UI 对齐 04] #28 hard constraint).
   */
  closePanel: (taskId: string, panel: ToolPanel) => void;
  closeAllPanels: (taskId: string) => void;
  setBrowserTakeover: (taskId: string, paused: boolean) => void;
  openModal: (modal: ModalState) => void;
  closeModal: () => void;
  pushToast: (text: string) => void;
  dismissToast: (id: string) => void;
  setAttentionFilter: (filter: UiState["attentionFilter"]) => void;
};

export const useUiStore = create<UiState>((set, get) => ({
  panels: {},
  activePanel: {},
  browserTakeover: {},
  modal: null,
  toasts: [],
  attentionFilter: "all",
  togglePanel: (taskId, panel) => {
    const panels = get().panels[taskId] ?? [];
    const opening = !panels.includes(panel);
    const next = opening ? [...panels, panel] : panels.filter((item) => item !== panel);
    set({
      panels: { ...get().panels, [taskId]: next },
      activePanel: {
        ...get().activePanel,
        // Opening a tool activates it; closing the active tab falls back to the
        // neighbour that is still open (the strip keeps the open order).
        [taskId]: opening ? panel : nextActivePanel(next, panel, get().activePanel[taskId]),
      },
    });
  },
  setActivePanel: (taskId, panel) => set({ activePanel: { ...get().activePanel, [taskId]: panel } }),
  closePanel: (taskId, panel) => {
    const next = (get().panels[taskId] ?? []).filter((item) => item !== panel);
    set({
      panels: { ...get().panels, [taskId]: next },
      activePanel: { ...get().activePanel, [taskId]: nextActivePanel(next, panel, get().activePanel[taskId]) },
    });
  },
  closeAllPanels: (taskId) =>
    set({ panels: { ...get().panels, [taskId]: [] }, activePanel: { ...get().activePanel, [taskId]: undefined } }),
  setBrowserTakeover: (taskId, paused) => set({ browserTakeover: { ...get().browserTakeover, [taskId]: paused } }),
  openModal: (modal) => set({ modal }),
  closeModal: () => set({ modal: null }),
  pushToast: (text) => {
    const id = `toast-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
    set({ toasts: [...get().toasts, { id, text }] });
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((item) => item.id !== id) }),
  setAttentionFilter: (attentionFilter) => set({ attentionFilter }),
}));
