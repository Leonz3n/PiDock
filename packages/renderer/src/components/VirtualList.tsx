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

/**
 * Virtualised list. The measured viewport height wins; `height` is the fallback
 * used before layout exists (for example under jsdom), so callers always get a
 * bounded window of rows instead of the whole collection.
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
        setMeasured(Math.round(entry.contentRect.height));
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const viewportHeight = measured > 0 ? measured : height;
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan,
  });

  const virtualRows = virtualizer.getVirtualItems();
  const rows = virtualRows.length > 0 || items.length === 0 ? virtualRows : fallbackRows(items.length, rowHeight, viewportHeight, overscan);

  return (
    <div
      ref={scrollRef}
      data-testid={testId}
      data-virtualized="true"
      data-total-rows={items.length}
      {...dataAttributes}
      className={`relative overflow-auto ${className}`}
      style={{ height: viewportHeight }}
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

function fallbackRows(count: number, rowHeight: number, viewportHeight: number, overscan: number) {
  const visible = Math.ceil(viewportHeight / rowHeight) + overscan;
  return Array.from({ length: Math.min(count, visible) }, (_, index) => ({
    index,
    start: index * rowHeight,
    size: rowHeight,
  }));
}
