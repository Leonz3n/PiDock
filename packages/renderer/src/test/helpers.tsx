import { render } from "@testing-library/react";
import { App } from "../App";
import { createMemoryHost } from "../data/memoryHost";
import { seedDrafts, useDraftStore } from "../stores/drafts";
import { useEventsStore } from "../stores/events";
import { useHostStore } from "../stores/host";
import { useUiStore } from "../stores/ui";

export function resetRenderer(path = "/") {
  useHostStore.setState({
    adapter: createMemoryHost(),
    workspace: undefined,
    attention: [],
    approvals: [],
    usage: [],
    cleanupPreview: undefined,
    status: "loading",
    error: undefined,
  });
  useEventsStore.setState({ liveMessages: {}, runs: {} });
  useDraftStore.setState({ drafts: { ...seedDrafts } });
  useUiStore.setState({ panels: {}, activeTab: {}, modal: null, toasts: [], attentionFilter: "all", sessionSearch: "" });
  window.history.replaceState({}, "", path);
}

export function renderApp(path = "/") {
  resetRenderer(path);
  return render(<App />);
}
