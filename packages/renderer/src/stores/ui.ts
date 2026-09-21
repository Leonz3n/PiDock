import { create } from "zustand";

export const TOOL_PANELS = ["runtime", "browser", "files", "terminal"] as const;

export type ToolPanel = (typeof TOOL_PANELS)[number];

export type ModalState =
  | { type: "sessions"; taskId: string; filter: "active" | "archived" }
  | { type: "rename-task"; taskId: string; value: string }
  | { type: "rename-session"; taskId: string; sessionId: string; value: string }
  | { type: "archive-task"; taskId: string }
  | { type: "cleanup"; taskId: string }
  | { type: "new-task"; projectId: string }
  | { type: "pair-device" }
  | { type: "new-provider" }
  | null;

type Toast = { id: string; text: string };

type UiState = {
  panels: Record<string, ToolPanel[]>;
  modal: ModalState;
  toasts: Toast[];
  attentionFilter: "all" | "approval" | "failed" | "expired" | "completed-unread";
  togglePanel: (taskId: string, panel: ToolPanel) => void;
  openModal: (modal: ModalState) => void;
  closeModal: () => void;
  pushToast: (text: string) => void;
  dismissToast: (id: string) => void;
  setAttentionFilter: (filter: UiState["attentionFilter"]) => void;
};

export const useUiStore = create<UiState>((set, get) => ({
  panels: {},
  modal: null,
  toasts: [],
  attentionFilter: "all",
  togglePanel: (taskId, panel) => {
    const panels = get().panels[taskId] ?? [];
    const next = panels.includes(panel) ? panels.filter((item) => item !== panel) : [...panels, panel];
    set({ panels: { ...get().panels, [taskId]: next } });
  },
  openModal: (modal) => set({ modal }),
  closeModal: () => set({ modal: null }),
  pushToast: (text) => {
    const id = `toast-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
    set({ toasts: [...get().toasts, { id, text }] });
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((item) => item.id !== id) }),
  setAttentionFilter: (attentionFilter) => set({ attentionFilter }),
}));
