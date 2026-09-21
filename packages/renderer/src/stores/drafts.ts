import { create } from "zustand";
import type { Reference } from "../data/types";

export type Draft = { text: string; references: Reference[] };

const emptyDraft: Draft = { text: "", references: [] };

type DraftState = {
  drafts: Record<string, Draft>;
  getDraft: (taskId: string, sessionId: string) => Draft;
  setText: (taskId: string, sessionId: string, text: string) => void;
  addReference: (taskId: string, sessionId: string, reference: Reference) => void;
  removeReference: (taskId: string, sessionId: string, referenceId: string) => void;
  restore: (taskId: string, sessionId: string, draft: Draft) => void;
  clear: (taskId: string, sessionId: string) => void;
};

const keyOf = (taskId: string, sessionId: string) => `${taskId}:${sessionId}`;

export const seedDrafts: Record<string, Draft> = {
  "release:failed": {
    text: "",
    references: [{ id: "ref-build-log", kind: "file", label: "build.log:48", detail: "front-monorepo 构建日志" }],
  },
};

export const useDraftStore = create<DraftState>((set, get) => ({
  drafts: { ...seedDrafts },
  getDraft: (taskId, sessionId) => get().drafts[keyOf(taskId, sessionId)] ?? emptyDraft,
  setText: (taskId, sessionId, text) => {
    const key = keyOf(taskId, sessionId);
    const draft = get().drafts[key] ?? emptyDraft;
    set({ drafts: { ...get().drafts, [key]: { ...draft, text } } });
  },
  addReference: (taskId, sessionId, reference) => {
    const key = keyOf(taskId, sessionId);
    const draft = get().drafts[key] ?? emptyDraft;
    if (draft.references.some((item) => item.id === reference.id)) return;
    set({ drafts: { ...get().drafts, [key]: { ...draft, references: [...draft.references, reference] } } });
  },
  removeReference: (taskId, sessionId, referenceId) => {
    const key = keyOf(taskId, sessionId);
    const draft = get().drafts[key] ?? emptyDraft;
    set({
      drafts: {
        ...get().drafts,
        [key]: { ...draft, references: draft.references.filter((item) => item.id !== referenceId) },
      },
    });
  },
  restore: (taskId, sessionId, draft) => {
    set({ drafts: { ...get().drafts, [keyOf(taskId, sessionId)]: draft } });
  },
  clear: (taskId, sessionId) => {
    set({ drafts: { ...get().drafts, [keyOf(taskId, sessionId)]: emptyDraft } });
  },
}));
