import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DesktopWorkspaceDialog } from "../components/DesktopWorkspaceDialog";
import { projectDraft, type ProjectInput } from "../data/desktopProjects";
afterEach(cleanup);
it("contains focus after removing the source selected for repair on open", () => {
  function Harness() {
    const [draft, setDraft] = useState<ProjectInput>({ ...projectDraft(), name: "Repair workspace", repositories: [{ id: "missing-source", name: "Gone", path: "/missing/repo" }] });
    return <><button>Background action</button><DesktopWorkspaceDialog mode="edit" draft={draft} onChange={setDraft} onCancel={vi.fn()} onSubmit={vi.fn()} busy={false} focusSourceId="missing-source" sourceStatus={{ "missing-source": { id: "missing-source", kind: "repository", status: "missing" } }} /></>;
  }
  render(<Harness />);
  expect(screen.getByLabelText("仓库路径 1")).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: "移除仓库 1" }));
  expect(screen.queryByLabelText("仓库路径 1")).not.toBeInTheDocument();
  screen.getByRole("button", { name: "Background action" }).focus();
  expect(screen.getByRole("dialog", { name: "编辑工作空间" })).toContainElement(document.activeElement as HTMLElement);
  expect(screen.getByLabelText("工作空间名称 *")).toHaveFocus();
});


it("uses the dialog while a repair input and every other control are disabled, then resumes live repair focus", async () => {
  const user = userEvent.setup();
  const onCancel = vi.fn();
  const onSubmit = vi.fn();
  const draft = { ...projectDraft(), name: "Repair workspace", repositories: [{ id: "missing-source", name: "Gone", path: "/missing/repo" }] };
  const view = (busy: boolean) => <><button>Background action</button><DesktopWorkspaceDialog mode="edit" draft={draft} onChange={vi.fn()} onCancel={onCancel} onSubmit={onSubmit} busy={busy} focusSourceId="missing-source" /></>;
  const { rerender } = render(view(true));
  const dialog = screen.getByRole("dialog", { name: "编辑工作空间" });
  expect(dialog).toHaveFocus();
  screen.getByRole("button", { name: "Background action" }).focus();
  expect(dialog).toHaveFocus();
  await user.tab();
  expect(dialog).toHaveFocus();
  await user.tab({ shift: true });
  expect(dialog).toHaveFocus();
  await user.keyboard("{Escape}{Control>}{Enter}{/Control}");
  expect(onCancel).not.toHaveBeenCalled();
  expect(onSubmit).not.toHaveBeenCalled();
  rerender(view(false));
  screen.getByRole("button", { name: "Background action" }).focus();
  expect(screen.getByLabelText("仓库路径 1")).toHaveFocus();
});

it.each(["Escape", "cancel"])("cycles focus after repair removal and restores the exact opener on %s", async (close) => {
  const user = userEvent.setup();
  const onSubmit = vi.fn();
  function Host() {
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState<ProjectInput>({ ...projectDraft(), name: "Repair workspace", repositories: [{ id: "missing-source", name: "Gone", path: "/missing/repo" }] });
    return <><button onClick={() => setOpen(true)}>Repair opener</button><button>Other background action</button>{open && <DesktopWorkspaceDialog mode="edit" draft={draft} onChange={setDraft} onCancel={() => setOpen(false)} onSubmit={onSubmit} busy={false} focusSourceId="missing-source" />}</>;
  }
  render(<Host />);
  const opener = screen.getByRole("button", { name: "Repair opener" });
  await user.click(opener);
  expect(screen.getByLabelText("仓库路径 1")).toHaveFocus();
  await user.click(screen.getByRole("button", { name: "移除仓库 1" }));
  screen.getByRole("button", { name: "Other background action" }).focus();
  const name = screen.getByLabelText("工作空间名称 *");
  expect(name).toHaveFocus();
  // jsdom's selector-list ordering differs from Chromium. Native evidence
  // separately asserts exact first/last wrap; here assert modal containment.
  await user.tab({ shift: true });
  expect(screen.getByRole("dialog")).toContainElement(document.activeElement as HTMLElement);
  await user.tab();
  expect(screen.getByRole("dialog")).toContainElement(document.activeElement as HTMLElement);
  if (close === "Escape") await user.keyboard("{Escape}");
  else await user.click(screen.getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(opener).toHaveFocus();
  expect(onSubmit).not.toHaveBeenCalled();
});
