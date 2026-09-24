import { act, render } from "@testing-library/react";
import { App } from "../App";
import { createMemoryHost } from "../data/memoryHost";
import { seedDrafts, useDraftStore } from "../stores/drafts";
import { useEnvDraftStore } from "../stores/envDrafts";
import { useEventsStore } from "../stores/events";
import { useHostStore } from "../stores/host";
import { useUiStore } from "../stores/ui";

export function resetRenderer(path = "/") {
  // A test may render twice (the second `renderApp` re-seeds the projection), so
  // the reset updates the tree the previous render left mounted: keep it in act.
  act(() => {
    useHostStore.setState({
      adapter: createMemoryHost(),
      workspace: undefined,
      localSettings: undefined,
      attention: [],
      approvals: [],
      usage: [],
      status: "loading",
      error: undefined,
    });
    useEventsStore.setState({ liveMessages: {}, runs: {} });
    useDraftStore.setState({ drafts: { ...seedDrafts } });
    useEnvDraftStore.setState({ drafts: {} });
    useUiStore.setState({
      panels: {},
      activePanel: {},
      browserTakeover: {},
      toolPanelState: {},
      modal: null,
      toasts: [],
      attentionFilter: "all",
    });
  });
  window.history.replaceState({}, "", path);
}

export function renderApp(path = "/") {
  resetRenderer(path);
  return render(<App />);
}

/**
 * Run one store action inside `act` ([UI 对齐 01] #25 review note).
 *
 * Store actions (`refresh`, `sendMessage`, `stopRun`, …) `set()` state after
 * their own await, so calling them straight from a test updated the mounted
 * shell outside React's act scope and produced "not wrapped in act(…)"
 * warnings for every subscriber. Wrapping keeps the existing assertions and
 * test intent unchanged; it only scopes the state update.
 */
export async function actStore<T>(action: () => Promise<T>): Promise<T> {
  let result: T | undefined;
  await act(async () => {
    result = await action();
  });
  return result as T;
}
