import { create } from "zustand";
import type { ConfigRowDraft } from "../data/configRows";

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
