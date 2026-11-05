import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LocalResourcePicker } from "../components/LocalResourcePicker";
import type { PidockBridge } from "../data/shellBridge";
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe("native resource selector", () => {
  it("does not apply canceled, empty or rejected selections and returns focus", async () => {
    const onSelect = vi.fn();
    const picker = vi.fn<NonNullable<PidockBridge["pickLocalResource"]>>();
    render(<LocalResourcePicker label="选择文件夹" kind="directory" bridge={{ pickLocalResource: picker }} onSelect={onSelect} />);
    for (const result of [{ ok: true, payload: { canceled: true } }, { ok: true }, { ok: false, error: "resource-selection-failed" }]) {
      picker.mockResolvedValueOnce(result);
      fireEvent.click(screen.getByRole("button"));
      await waitFor(() => expect(screen.getByRole("button")).toBeEnabled());
    }
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("resource-selection-failed");
    await waitFor(() => expect(screen.getByRole("button")).toHaveFocus());
  });
  it("permits only one pending invocation and ignores replies after unmount", async () => {
    let resolve!: (value: Awaited<ReturnType<NonNullable<PidockBridge["pickLocalResource"]>>>) => void;
    const picker = vi.fn(() => new Promise<Awaited<ReturnType<NonNullable<PidockBridge["pickLocalResource"]>>>>((done) => { resolve = done; }));
    const onSelect = vi.fn();
    const { unmount } = render(<LocalResourcePicker label="选择程序" kind="executable" bridge={{ pickLocalResource: picker }} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button")); fireEvent.click(screen.getByRole("button"));
    expect(picker).toHaveBeenCalledTimes(1); expect(picker).toHaveBeenCalledWith({ kind: "executable" });
    unmount(); resolve({ ok: true, payload: { canceled: false, path: "/late" } });
    await Promise.resolve(); expect(onSelect).not.toHaveBeenCalled();
  });
});

it("restores focus after the owner re-enables its fieldset without relying on animation frames", async () => {
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
  const pickLocalResource = vi.fn().mockResolvedValue({ ok: true, payload: { canceled: true } });
  function Form() {
    const [busy, setBusy] = useState(false);
    return <fieldset disabled={busy}><LocalResourcePicker kind="directory" label="选择文件夹" disabled={busy} bridge={{ pickLocalResource }} onBusy={setBusy} onSelect={vi.fn()} /></fieldset>;
  }
  render(<Form />);
  fireEvent.click(screen.getByRole("button"));
  await waitFor(() => expect(screen.getByRole("button")).toBeEnabled());
  expect(screen.getByRole("button")).toHaveFocus();
});
