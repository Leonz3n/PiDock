import { create } from "zustand";

export type ToolPanel = "runtime" | "browser" | "files" | "terminal";

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
  activeTab: Record<string, ToolPanel | undefined>;
  modal: ModalState;
  toasts: Toast[];
  attentionFilter: "all" | "approval" | "failed" | "expired" | "completed-unread";
  sessionSearch: string;
  togglePanel: (taskId: string, panel: ToolPanel) => void;
  closePanel: (taskId: string, panel: ToolPanel) => void;
  openModal: (modal: ModalState) => void;
  closeModal: () => void;
  pushToast: (text: string) => void;
  dismissToast: (id: string) => void;
  setAttentionFilter: (filter: UiState["attentionFilter"]) => void;
  setSessionSearch: (value: string) => void;
};

export const useUiStore = create<UiState>((set, get) => ({
  panels: {},
  activeTab: {},
  modal: null,
  toasts: [],
  attentionFilter: "all",
  sessionSearch: "",
  togglePanel: (taskId, panel) => {
    const panels = get().panels[taskId] ?? [];
    const next = panels.includes(panel) ? panels.filter((item) => item !== panel) : [...panels, panel];
    set({
      panels: { ...get().panels, [taskId]: next },
      activeTab: { ...get().activeTab, [taskId]: next[next.length - 1] },
    });
  },
  closePanel: (taskId, panel) => {
    const panels = (get().panels[taskId] ?? []).filter((item) => item !== panel);
    set({
      panels: { ...get().panels, [taskId]: panels },
      activeTab: { ...get().activeTab, [taskId]: panels[panels.length - 1] },
    });
  },
  openModal: (modal) => set({ modal }),
  closeModal: () => set({ modal: null }),
  pushToast: (text) => {
    const id = `toast-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
    set({ toasts: [...get().toasts, { id, text }] });
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((item) => item.id !== id) }),
  setAttentionFilter: (attentionFilter) => set({ attentionFilter }),
  setSessionSearch: (sessionSearch) => set({ sessionSearch }),
}));
