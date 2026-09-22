import type { ElementDetails, Locator } from "./task-automation.js";

/**
 * A marker records that an Agent identified a semantic target on a page at a
 * particular navigation epoch. Navigation invalidates the marker: the old
 * element handle is dropped and must be re-located on the new document.
 */
export interface PageMarker {
  readonly id: string;
  readonly pageId: string;
  readonly label: string;
  readonly locator: Locator;
  readonly epoch: number;
  stale: boolean;
  element: ElementDetails | null;
}

export interface TakeoverState {
  readonly paused: boolean;
  readonly reason?: string;
}

export interface AgentSessionState {
  readonly pageEpochs: Readonly<Record<string, number>>;
  readonly markers: readonly PageMarker[];
  readonly takeover: TakeoverState;
  readonly nextMarkerNumber: number;
}

export interface MarkerInput {
  readonly pageId: string;
  readonly label: string;
  readonly locator: Locator;
  readonly element: ElementDetails | null;
}

export interface NavigationEffect {
  readonly state: AgentSessionState;
  readonly invalidatedMarkerIds: readonly string[];
}

export function createAgentSessionState(): AgentSessionState {
  return {
    pageEpochs: {},
    markers: [],
    takeover: { paused: false },
    nextMarkerNumber: 1,
  };
}

export function pageEpoch(state: AgentSessionState, pageId: string): number {
  return state.pageEpochs[pageId] ?? 0;
}

/**
 * Advances a page's epoch and invalidates that page's markers so the Agent
 * must re-locate them against the freshly loaded document.
 */
export function beginNavigation(
  state: AgentSessionState,
  pageId: string,
): NavigationEffect {
  const epoch = pageEpoch(state, pageId) + 1;
  const invalidatedMarkerIds: string[] = [];
  const markers = state.markers.map((marker) => {
    if (marker.pageId !== pageId) return marker;
    invalidatedMarkerIds.push(marker.id);
    return { ...marker, stale: true, element: null };
  });
  return {
    state: {
      ...state,
      pageEpochs: { ...state.pageEpochs, [pageId]: epoch },
      markers,
    },
    invalidatedMarkerIds,
  };
}

export function addMarker(
  state: AgentSessionState,
  input: MarkerInput,
): { state: AgentSessionState; marker: PageMarker } {
  const marker: PageMarker = {
    id: `marker-${state.nextMarkerNumber}`,
    pageId: input.pageId,
    label: input.label,
    locator: input.locator,
    epoch: pageEpoch(state, input.pageId),
    stale: input.element === null,
    element: input.element,
  };
  return {
    state: {
      ...state,
      markers: [...state.markers, marker],
      nextMarkerNumber: state.nextMarkerNumber + 1,
    },
    marker,
  };
}

export function resolveMarker(
  state: AgentSessionState,
  markerId: string,
  element: ElementDetails | null,
): AgentSessionState {
  return {
    ...state,
    markers: state.markers.map((marker) =>
      marker.id === markerId
        ? { ...marker, element, stale: element === null }
        : marker,
    ),
  };
}

export function staleMarkers(
  state: AgentSessionState,
  pageId?: string,
): PageMarker[] {
  return state.markers.filter(
    (marker) => marker.stale && (pageId === undefined || marker.pageId === pageId),
  );
}

export function beginTakeover(
  state: AgentSessionState,
  reason: string,
): AgentSessionState {
  return { ...state, takeover: { paused: true, reason } };
}

export function endTakeover(state: AgentSessionState): AgentSessionState {
  return { ...state, takeover: { paused: false } };
}

export function canAutomate(state: AgentSessionState): boolean {
  return !state.takeover.paused;
}
