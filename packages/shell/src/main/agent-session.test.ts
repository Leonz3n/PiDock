import { describe, expect, it } from "vitest";
import type { ElementDetails } from "./task-automation.js";
import {
  addMarker,
  beginNavigation,
  beginTakeover,
  canAutomate,
  createAgentSessionState,
  endTakeover,
  pageEpoch,
  resolveMarker,
  staleMarkers,
} from "./agent-session.js";

function details(label: string): ElementDetails {
  return {
    tag: "button",
    text: label,
    role: "button",
    name: label,
    disabled: false,
    visible: true,
    inViewport: true,
    interactable: true,
    hit: true,
    editable: false,
    rect: { x: 0, y: 0, width: 10, height: 10 },
    center: { x: 5, y: 5 },
  };
}

describe("agent session model", () => {
  it("starts empty, unpaused and automatable", () => {
    const state = createAgentSessionState();
    expect(state.markers).toEqual([]);
    expect(pageEpoch(state, "p1")).toBe(0);
    expect(canAutomate(state)).toBe(true);
  });

  it("assigns deterministic ids and stamps the current page epoch", () => {
    const empty = createAgentSessionState();
    const first = addMarker(empty, {
      pageId: "p1",
      label: "save",
      locator: { kind: "testId", value: "save" },
      element: details("save"),
    });
    const second = addMarker(first.state, {
      pageId: "p1",
      label: "name",
      locator: { kind: "label", value: "名称" },
      element: null,
    });
    expect(first.marker.id).toBe("marker-1");
    expect(second.marker.id).toBe("marker-2");
    expect(first.marker.epoch).toBe(0);
    expect(second.marker.stale).toBe(true);
    expect(empty.markers).toEqual([]);
  });

  it("bumps the epoch and invalidates only the navigated page's markers", () => {
    let state = createAgentSessionState();
    state = addMarker(state, {
      pageId: "p1",
      label: "a",
      locator: { kind: "text", value: "a" },
      element: details("a"),
    }).state;
    state = addMarker(state, {
      pageId: "p2",
      label: "b",
      locator: { kind: "text", value: "b" },
      element: details("b"),
    }).state;

    const effect = beginNavigation(state, "p1");
    state = effect.state;
    expect(effect.invalidatedMarkerIds).toEqual(["marker-1"]);
    expect(pageEpoch(state, "p1")).toBe(1);
    expect(pageEpoch(state, "p2")).toBe(0);

    const p1 = state.markers.find((marker) => marker.pageId === "p1");
    const p2 = state.markers.find((marker) => marker.pageId === "p2");
    expect(p1?.stale).toBe(true);
    expect(p1?.element).toBeNull();
    expect(p2?.stale).toBe(false);
    expect(p2?.element?.name).toBe("b");
  });

  it("re-locates stale markers through resolution", () => {
    let state = createAgentSessionState();
    state = addMarker(state, {
      pageId: "p1",
      label: "save",
      locator: { kind: "testId", value: "save" },
      element: details("save"),
    }).state;
    state = beginNavigation(state, "p1").state;
    expect(staleMarkers(state, "p1").map((marker) => marker.id)).toEqual([
      "marker-1",
    ]);

    state = resolveMarker(state, "marker-1", details("save-v2"));
    expect(staleMarkers(state, "p1")).toEqual([]);
    expect(state.markers[0]?.element?.name).toBe("save-v2");
  });

  it("keeps a marker stale when it cannot be re-located", () => {
    let state = createAgentSessionState();
    state = addMarker(state, {
      pageId: "p1",
      label: "gone",
      locator: { kind: "testId", value: "gone" },
      element: details("gone"),
    }).state;
    state = beginNavigation(state, "p1").state;
    state = resolveMarker(state, "marker-1", null);
    expect(staleMarkers(state, "p1").map((marker) => marker.id)).toEqual([
      "marker-1",
    ]);
  });

  it("gates automation while a human owns the page", () => {
    let state = createAgentSessionState();
    state = beginTakeover(state, "human typing");
    expect(canAutomate(state)).toBe(false);
    expect(state.takeover.reason).toBe("human typing");

    state = endTakeover(state);
    expect(canAutomate(state)).toBe(true);
    expect(state.takeover.reason).toBeUndefined();
  });
});
