import { useEffect, useRef, useState, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

type VirtualListProps<T> = {
  items: T[];
  rowHeight: number;
  height?: number;
  overscan?: number;
  className?: string;
  testId?: string;
  getRowKey?: (item: T, index: number) => string;
  renderRow: (item: T, index: number) => ReactNode;
  dataAttributes?: Record<string, string>;
};

type ObservedHeight = {
  /** Content-box height, the only box `ResizeObserver.contentRect` reports. */
  contentBox: number;
  /** Border-box height from `ResizeObserverEntry.borderBoxSize`, when available. */
  borderBox?: number;
  /** Border-box height from `getBoundingClientRect()`, when available. */
  rect?: number;
};

/**
 * The height to store for the scroll element.
 *
 * Under Tailwind's preflight (`box-sizing: border-box`) `style.height` is the
 * **border-box** height, so the element must be measured by its border box.
 * Measuring `contentRect.height` instead made any caller with a border shrink
 * by the border width on every observer callback (420 → 418 → 416 …), which
 * silently collapsed the windowed row count. `borderBoxSize` is preferred
 * because it is the value the observer itself reports; `getBoundingClientRect`
 * covers engines (and test doubles) without it, and the content box is the
 * last resort so an element without borders still works.
 */
export function resolveViewportHeight(observed: ObservedHeight): number {
  const candidate = [observed.borderBox, observed.rect, observed.contentBox].find(
    (value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0,
  );
  return candidate === undefined ? 0 : Math.round(candidate);
}

/**
 * How many rows a window of `viewportHeight` covers: the visible rows plus the
 * overscan buffer, capped at the collection size. Shared with the fallback
 * renderer and with the measurement script's expectation.
 */
export function viewportWindowSize(options: { itemCount: number; rowHeight: number; viewportHeight: number; overscan: number }): number {
  const { itemCount, rowHeight, viewportHeight, overscan } = options;
  return Math.min(itemCount, Math.ceil(viewportHeight / rowHeight) + overscan);
}

/**
 * Virtualised list. The measured border-box height wins; `height` is the
 * fallback used before layout exists (for example under jsdom), so callers
 * always get a bounded window of rows instead of the whole collection.
 *
 * `data-viewport-height` / `data-row-height` / `data-overscan` /
 * `data-expected-rows` expose the window derivation so evidence scripts can
 * compare the rendered row count against `ceil(viewportHeight / rowHeight) + overscan`.
 */
export function VirtualList<T>({
  items,
  rowHeight,
  height = 320,
  overscan = 6,
  className = "",
  testId,
  getRowKey,
  renderRow,
  dataAttributes,
}: VirtualListProps<T>) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [measured, setMeasured] = useState(0);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const target = entry.target ?? element;
        const next = resolveViewportHeight({
          contentBox: entry.contentRect.height,
          borderBox: entry.borderBoxSize?.[0]?.blockSize,
          rect: target.getBoundingClientRect().height,
        });
        if (next > 0) setMeasured(next);
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const viewportHeight = measured > 0 ? measured : height;
  const expectedRows = viewportWindowSize({ itemCount: items.length, rowHeight, viewportHeight, overscan });
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan,
  });

  const virtualRows = virtualizer.getVirtualItems();
  const rows =
    virtualRows.length > 0 || items.length === 0
      ? virtualRows
      : Array.from({ length: expectedRows }, (_, index) => ({ index, start: index * rowHeight, size: rowHeight }));

  return (
    <div
      ref={scrollRef}
      data-testid={testId}
      data-virtualized="true"
      data-total-rows={items.length}
      data-viewport-height={viewportHeight}
      data-row-height={rowHeight}
      data-overscan={overscan}
      data-expected-rows={expectedRows}
      {...dataAttributes}
      className={`relative overflow-auto ${className}`}
      // `box-sizing: border-box` makes the styled height and the measured
      // border box the same quantity, independent of the host's preflight.
      style={{ height: viewportHeight, boxSizing: "border-box" }}
    >
      <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
        {rows.map((row) => (
          <div
            key={getRowKey ? getRowKey(items[row.index], row.index) : row.index}
            style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${row.start}px)` }}
          >
            {renderRow(items[row.index], row.index)}
          </div>
        ))}
      </div>
    </div>
  );
}
