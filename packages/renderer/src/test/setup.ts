import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";
import { installResizeObserverStub } from "./resizeObserver";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// jsdom ships no ResizeObserver. Instead of a silent no-op (which hid the
// VirtualList height feedback loop) install a controllable stub: it keeps the
// observer contract and lets tests drive resize notifications with real box
// sizes via `test/resizeObserver.ts`.
installResizeObserverStub();
