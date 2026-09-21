import { create } from "zustand";
import type { HostEvent, Message, RunRecord } from "../data/types";
import { sessionKeyOf } from "../data/sessionKey";
import { useHostStore } from "./host";
import { useUiStore } from "./ui";

type EventsState = {
  liveMessages: Record<string, Message[]>;
  runs: Record<string, RunRecord>;
  attach: () => () => void;
};

const terminalStates = new Set(["completed", "failed", "stopped", "rejected", "expired"]);

export const useEventsStore = create<EventsState>((set, get) => ({
  liveMessages: {},
  runs: {},
  attach: () => {
    const unsubscribe = useHostStore.getState().adapter.subscribe((event: HostEvent) => {
      if (event.type === "message-delta") {
        const key = sessionKeyOf(event.taskId, event.sessionId);
        const current = get().liveMessages[key] ?? [];
        const existing = current.find((item) => item.id === event.messageId);
        const next = existing
          ? current.map((item) =>
              item.id === event.messageId ? { ...item, text: item.text + event.delta } : item,
            )
          : [...current, { id: event.messageId, role: "agent" as const, text: event.delta, streaming: true }];
        set({ liveMessages: { ...get().liveMessages, [key]: next } });
      }
      if (event.type === "message-done") {
        const key = sessionKeyOf(event.taskId, event.sessionId);
        const current = get().liveMessages[key] ?? [];
        set({
          liveMessages: {
            ...get().liveMessages,
            [key]: current.map((item) => (item.id === event.messageId ? { ...item, streaming: false } : item)),
          },
        });
      }
      if (event.type === "run-state") {
        const key = sessionKeyOf(event.taskId, event.sessionId);
        const record = event.record ?? get().runs[key];
        set({ runs: { ...get().runs, [key]: { ...(record as RunRecord), state: event.state } } });
        if (terminalStates.has(event.state)) {
          void useHostStore.getState().refresh().then(() => {
            set({ liveMessages: { ...get().liveMessages, [key]: [] } });
          });
        }
      }
      if (event.type === "approval") {
        const key = sessionKeyOf(event.taskId, event.sessionId);
        const record = get().runs[key];
        set({ runs: { ...get().runs, [key]: { ...(record ?? emptyRecord(event.taskId, event.sessionId)), state: event.approval.status === "pending" ? "approval" : event.approval.status === "approved" ? "running" : event.approval.status === "rejected" ? "rejected" : "expired" } } });
        void useHostStore.getState().refresh();
      }
      if (event.type === "toast") {
        useUiStore.getState().pushToast(event.text);
      }
    });
    return unsubscribe;
  },
}));

function emptyRecord(taskId: string, sessionId: string): RunRecord {
  return {
    id: `run-${taskId}-${sessionId}`,
    taskId,
    sessionId,
    state: "idle",
    startedAt: new Date().toISOString(),
    summary: "",
    steps: [],
  };
}
