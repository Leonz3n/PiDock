import { create } from "zustand";
import { nextConfigRowId, toConfigRows, type ConfigRowDraft } from "../data/configRows";
import type { ConfigEntry } from "../data/types";

export type ConfigDraft = {
  rows: ConfigRowDraft[];
  original: ConfigEntry[];
  dirty: boolean;
  error: string | null;
};

type EnvDraftState = {
  drafts: Record<string, ConfigDraft>;
  ensure: (key: string, original: ConfigEntry[]) => void;
  setField: (key: string, rowId: string, field: "key" | "value", value: string) => void;
  addRow: (key: string) => void;
  removeRow: (key: string, rowId: string) => void;
  setError: (key: string, error: string | null) => void;
  /** Record a successful save so the draft's baseline becomes the saved rows. */
  commit: (key: string, entries: ConfigEntry[]) => void;
};

const emptyDraft = (original: ConfigEntry[]): ConfigDraft => ({
  rows: toConfigRows(original),
  original: original.map((entry) => ({ ...entry })),
  dirty: false,
  error: null,
});

export function emptyConfigDraft(): ConfigDraft {
  return emptyDraft([]);
}

/**
 * Per-scope editing drafts, keyed by 项目 / 环境 / 作用域 / 任务 (see
 * `configDraftKey`). Drafts are UI state and never persist; they are reset when
 * a scope is saved or the page is reloaded.
 */
export const useEnvDraftStore = create<EnvDraftState>((set, get) => ({
  drafts: {},
  ensure: (key, original) => {
    if (get().drafts[key]) return;
    set({ drafts: { ...get().drafts, [key]: emptyDraft(original) } });
  },
  setField: (key, rowId, field, value) => {
    const draft = get().drafts[key];
    if (!draft) return;
    set({
      drafts: {
        ...get().drafts,
        [key]: {
          ...draft,
          rows: draft.rows.map((row) => (row.id === rowId ? { ...row, [field]: value } : row)),
          dirty: true,
          error: null,
        },
      },
    });
  },
  addRow: (key) => {
    const draft = get().drafts[key];
    if (!draft) return;
    set({
      drafts: {
        ...get().drafts,
        [key]: { ...draft, rows: [...draft.rows, { id: nextConfigRowId(), key: "", value: "" }], dirty: true, error: null },
      },
    });
  },
  removeRow: (key, rowId) => {
    const draft = get().drafts[key];
    if (!draft) return;
    set({
      drafts: {
        ...get().drafts,
        [key]: { ...draft, rows: draft.rows.filter((row) => row.id !== rowId), dirty: true, error: null },
      },
    });
  },
  setError: (key, error) => {
    const draft = get().drafts[key];
    if (!draft) return;
    set({ drafts: { ...get().drafts, [key]: { ...draft, error } } });
  },
  commit: (key, entries) => {
    const draft = get().drafts[key];
    if (!draft) return;
    set({ drafts: { ...get().drafts, [key]: emptyDraft(entries) } });
  },
}));
