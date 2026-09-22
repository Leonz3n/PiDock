import { act, render, screen } from "@testing-library/react";
import { VirtualList, resolveViewportHeight, viewportWindowSize } from "../components/VirtualList";
import { notifyResize, resetResizeObserverStub, simulateVerticalBorder, watcherCount } from "./resizeObserver";

const items = Array.from({ length: 240 }, (_, index) => ({ id: `row-${index}` }));

function renderList(className: string) {
  return render(
    <VirtualList
      testId="list"
      items={items}
      rowHeight={34}
      height={420}
      overscan={6}
      className={className}
      getRowKey={(item) => item.id}
      renderRow={(item) => <div>{item.id}</div>}
    />,
  );
}

beforeEach(() => {
  resetResizeObserverStub();
});

describe("resolveViewportHeight", () => {
  it("prefers the border box so a bordered element keeps the height it was given", () => {
    // A 420px border-box element with 1px top and bottom borders measures 418px
    // of content. Writing 418 back would shrink the element by 2px every time.
    expect(resolveViewportHeight({ contentBox: 418, borderBox: 420 })).toBe(420);
    expect(resolveViewportHeight({ contentBox: 420, borderBox: 420 })).toBe(420);
  });

  it("falls back to the layout rect, then the content box, when borderBoxSize is unavailable", () => {
    expect(resolveViewportHeight({ contentBox: 418, rect: 420 })).toBe(420);
    expect(resolveViewportHeight({ contentBox: 418 })).toBe(418);
  });

  it("never returns a non-positive height", () => {
    expect(resolveViewportHeight({ contentBox: 0 })).toBe(0);
    expect(resolveViewportHeight({ contentBox: Number.NaN })).toBe(0);
    expect(resolveViewportHeight({ contentBox: -12, borderBox: 0 })).toBe(0);
  });

  it("is stable when a bordered element's measurement is fed back (would shrink on content-box code)", () => {
    const declared = 420;
    const border = 2;
    // The browser reports the boxes for the *current* styled height; border-box
    // sizing means the styled height is the border box.
    const observe = (height: number) => ({ contentBox: height - border, borderBox: height });
    let height = declared;
    for (let round = 0; round < 10; round += 1) {
      height = resolveViewportHeight(observe(height));
    }
    expect(height).toBe(declared);

    // The pre-fix derivation (`Math.round(contentRect.height)`) shrinks forever:
    let legacy = declared;
    for (let round = 0; round < 10; round += 1) {
      legacy = Math.round(observe(legacy).contentBox);
    }
    expect(legacy).toBe(declared - 20);
  });
});

describe("viewportWindowSize", () => {
  it("matches ceil(viewportHeight / rowHeight) + overscan, capped at the item count", () => {
    expect(viewportWindowSize({ itemCount: 240, rowHeight: 34, viewportHeight: 420, overscan: 6 })).toBe(19);
    expect(viewportWindowSize({ itemCount: 47, rowHeight: 40, viewportHeight: 280, overscan: 6 })).toBe(13);
    expect(viewportWindowSize({ itemCount: 43, rowHeight: 56, viewportHeight: 280, overscan: 6 })).toBe(11);
    expect(viewportWindowSize({ itemCount: 5, rowHeight: 40, viewportHeight: 280, overscan: 6 })).toBe(5);
  });
});

describe("VirtualList with a bordered viewport", () => {
  it("keeps its declared height across repeated resize notifications", async () => {
    renderList("rounded-md border border-line");
    const list = screen.getByTestId("list");
    // Two observers watch the scroll element: ours and TanStack Virtual's own.
    expect(watcherCount(list)).toBeGreaterThanOrEqual(1);
    simulateVerticalBorder(list, 2);

    const heights: string[] = [];
    for (let round = 0; round < 5; round += 1) {
      await act(async () => {
        notifyResize(list);
      });
      heights.push((list as HTMLElement).style.height);
    }

    // Pre-fix this was ["418px", "416px", "414px", "412px", "410px"].
    expect(heights).toEqual(["420px", "420px", "420px", "420px", "420px"]);
    expect(list).toHaveAttribute("data-viewport-height", "420");
  });

  it("renders exactly the expected window for a bordered list", async () => {
    renderList("rounded-md border border-line");
    const list = screen.getByTestId("list");
    simulateVerticalBorder(list, 2);
    await act(async () => {
      notifyResize(list);
    });

    expect(list).toHaveAttribute("data-expected-rows", "19");
    expect(list.querySelectorAll("[style*='translateY']").length).toBe(19);
  });

  it("treats an unbordered viewport the same as a bordered one with matching boxes", async () => {
    renderList("");
    const list = screen.getByTestId("list");
    await act(async () => {
      notifyResize(list);
    });
    expect((list as HTMLElement).style.height).toBe("420px");
    expect(list.querySelectorAll("[style*='translateY']").length).toBe(19);
  });

  it("stops observing when it unmounts", () => {
    const { unmount } = renderList("border border-line");
    const list = screen.getByTestId("list");
    expect(watcherCount(list)).toBeGreaterThanOrEqual(1);
    unmount();
    expect(watcherCount(list)).toBe(0);
  });
});
