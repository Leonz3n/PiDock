import { vi } from "vitest";

/**
 * Controllable `ResizeObserver` for tests.
 *
 * jsdom has no layout engine, so the previous no-op stub meant the resize path
 * could never be exercised in CI — which is how the VirtualList height feedback
 * loop escaped. This stub keeps the real observer contract (a callback per
 * watched element) but derives the box sizes from an explicit, test-owned model:
 *
 * - the styled `style.height` is the declared border-box height,
 * - `simulateVerticalBorder(element, px)` declares `px` of vertical border,
 *   so the content box shrinks by `px` relative to the border box, exactly like
 *   a bordered element under `box-sizing: border-box`.
 *
 * A test can therefore call `notifyResize(element)` repeatedly: each call reads
 * the element's *current* styled height and reports the boxes a browser would,
 * which makes feedback loops reproducible instead of invisible.
 */

type ResizeCallback = (entries: ResizeObserverEntry[], observer: ResizeObserver) => void;

type Watcher = { target: Element; callback: ResizeCallback };

const watchers = new Set<Watcher>();
const verticalBorders = new WeakMap<Element, number>();

/** Declare that `element` has `px` of vertical border (top + bottom combined). */
export function simulateVerticalBorder(element: Element, px: number): void {
  verticalBorders.set(element, px);
}

/** Number of observers currently watching `element` (asserts wiring, not behaviour). */
export function watcherCount(element: Element): number {
  return [...watchers].filter((watcher) => watcher.target === element).length;
}

/**
 * Fire one resize notification with sizes derived from the element's current
 * layout model. Returns how many observers were notified.
 */
export function notifyResize(element: Element): number {
  let delivered = 0;
  for (const watcher of [...watchers]) {
    if (watcher.target !== element) continue;
    watcher.callback([resizeEntry(element)], watcher as unknown as ResizeObserver);
    delivered += 1;
  }
  return delivered;
}

function boxes(element: Element) {
  const declared = Number.parseFloat((element as HTMLElement).style.height);
  const borderBoxHeight = Number.isFinite(declared) ? declared : 0;
  const border = verticalBorders.get(element) ?? 0;
  return { borderBoxHeight, contentBoxHeight: Math.max(0, borderBoxHeight - border) };
}

function resizeEntry(target: Element): ResizeObserverEntry {
  const { borderBoxHeight, contentBoxHeight } = boxes(target);
  const width = target.getBoundingClientRect().width;
  const rect: DOMRectReadOnly = {
    x: 0,
    y: 0,
    width,
    height: borderBoxHeight,
    top: 0,
    left: 0,
    right: width,
    bottom: borderBoxHeight,
    toJSON: () => ({}),
  };
  return {
    target,
    contentRect: { ...rect, height: contentBoxHeight },
    borderBoxSize: [{ blockSize: borderBoxHeight, inlineSize: width }],
    contentBoxSize: [{ blockSize: contentBoxHeight, inlineSize: width }],
    devicePixelContentBoxSize: [{ blockSize: borderBoxHeight, inlineSize: width }],
  } as unknown as ResizeObserverEntry;
}

export function resetResizeObserverStub(): void {
  watchers.clear();
}

/** Install the stub globally; called from `setup.ts` and idempotent. */
export function installResizeObserverStub(): void {
  const Stub = class implements ResizeObserver {
    constructor(private readonly callback: ResizeCallback) {}
    observe(target: Element): void {
      watchers.add({ target, callback: this.callback });
    }
    unobserve(target: Element): void {
      for (const watcher of watchers) {
        if (watcher.target === target && watcher.callback === this.callback) watchers.delete(watcher);
      }
    }
    disconnect(): void {
      for (const watcher of watchers) {
        if (watcher.callback === this.callback) watchers.delete(watcher);
      }
    }
  };
  vi.stubGlobal("ResizeObserver", Stub);
}
