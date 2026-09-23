import { create } from "zustand";
import type { TaskWriteLockView } from "../data/types";
import type { SessionWriteState } from "../data/writeCoordination";
import { useHostStore } from "./host";

/**
 * [PiDock 09] (#11) write-coordination views, keyed by task.
 *
 * The workspace itself carries `task.writeLock` for the memory adapter, but in
 * the shell adapter the coordination state comes from the Host
 * (`task/sessionStates`) and is fetched per task. The navigation reads it from
 * here, and the events store refreshes the affected task whenever a run state
 * or approval changes, so holder/queue/read-only stay live without a poll.
 */
type WriteLockState = {
  views: Record<string, { writeLock: TaskWriteLockView; sessions: SessionWriteState[] }>;
  load: (taskId: string) => Promise<void>;
  clear: () => void;
};

export const useWriteLockStore = create<WriteLockState>((set, get) => ({
  views: {},
  load: async (taskId) => {
    try {
      const view = await useHostStore.getState().adapter.sessionWriteStates(taskId);
      set({ views: { ...get().views, [taskId]: view } });
    } catch {
      // A task the Host cannot answer for (or a disconnected shell) leaves the
      // last known view in place: the coordination bar must never invent a
      // holder it did not receive.
    }
  },
  clear: () => set({ views: {} }),
}));
