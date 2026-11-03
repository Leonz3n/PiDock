import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DesktopWorkspaceDialog } from "../components/DesktopWorkspaceDialog";
import { projectDraft, type ProjectInput, type SourceVerification } from "../data/desktopProjects";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

/** The dialog is controlled; this harness keeps the draft exactly as the page does. */
function Harness({ mode = "create", initial, onSubmit = vi.fn(), onCancel = () => undefined,
  busy = false, error = null, sourceStatus = {} as Record<string, SourceVerification>, saveDisabled = false }: {
    mode?: "create" | "edit";
    initial?: ProjectInput;
    onSubmit?: (draft: ProjectInput) => void;
    onCancel?: () => void;
    busy?: boolean;
    error?: string | null;
    sourceStatus?: Record<string, SourceVerification>;
    saveDisabled?: boolean;
  }) {
  const [draft, setDraft] = useState<ProjectInput>(initial ?? projectDraft());
  return <DesktopWorkspaceDialog mode={mode} draft={draft} onChange={setDraft} busy={busy} error={error}
    saveDisabled={saveDisabled} sourceStatus={sourceStatus} onCancel={onCancel} onSubmit={() => onSubmit(draft)} />;
}

const openCreate = () => within(screen.getByRole("dialog", { name: "新建工作空间" }));

describe("S10 workspace dialog", () => {
  it("shows the designed fields and requires a name and at least one source", async () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    const dialog = openCreate();
    expect(dialog.getByLabelText("工作空间名称 *")).toBeInTheDocument();
    expect(dialog.getByLabelText("描述与业务用途")).toBeInTheDocument();
    expect(dialog.getByLabelText("工作空间全局环境变量 *")).toBeInTheDocument();
    expect(dialog.getByLabelText("Git 远程分支模板 *")).toHaveValue("feature/{task-name}");
    expect(dialog.getByRole("button", { name: "添加 Git 仓库" })).toBeInTheDocument();
    expect(dialog.getByRole("button", { name: "添加普通目录" })).toBeInTheDocument();
    expect(dialog.getByText("创建工作区并保存配置")).toBeInTheDocument();
    expect(dialog.getByText("⌘↵")).toBeInTheDocument();

    fireEvent.click(dialog.getByRole("button", { name: "创建工作区并保存配置" }));
    expect(await dialog.findByText("请填写工作空间名称")).toBeInTheDocument();
    expect(dialog.getByText("请至少登记一个 Git 仓库或普通目录")).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
    // The dialog keeps the user's place: the name field is focused, not closed.
    expect(dialog.getByLabelText("工作空间名称 *")).toHaveFocus();
  });

  it("collects Git repositories, ordinary directories, variables and a branch template", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<Harness onSubmit={onSubmit} />);
    const dialog = openCreate();
    await user.type(dialog.getByLabelText("工作空间名称 *"), "PiDock 核心开发");
    await user.type(dialog.getByLabelText("描述与业务用途"), "桌面客户端与文档");
    await user.click(dialog.getByRole("button", { name: "添加 Git 仓库" }));
    await user.type(dialog.getByLabelText("仓库名称 1"), "pi-agent-ui");
    await user.type(dialog.getByLabelText("仓库路径 1"), "/Users/me/pi-agent-ui");
    await user.click(dialog.getByRole("button", { name: "添加普通目录" }));
    await user.type(dialog.getByLabelText("目录名称 1"), "docs");
    await user.type(dialog.getByLabelText("目录路径 1"), "/Users/me/docs");
    await user.click(dialog.getByRole("button", { name: "添加变量" }));
    await user.type(dialog.getByLabelText("环境变量名 1"), "NODE_ENV");
    await user.type(dialog.getByLabelText("环境变量值 1"), "development");
    const template = dialog.getByLabelText("Git 远程分支模板 *");
    fireEvent.change(template, { target: { value: "feature/{task-name}" } });
    // A second row can be removed again without touching the first.
    await user.click(dialog.getByRole("button", { name: "添加 Git 仓库" }));
    await user.click(dialog.getByRole("button", { name: "移除仓库 2" }));
    expect(dialog.queryByLabelText("仓库路径 2")).toBeNull();

    await user.click(dialog.getByRole("button", { name: "创建工作区并保存配置" }));
    expect(onSubmit).toHaveBeenCalledWith({
      name: "PiDock 核心开发",
      description: "桌面客户端与文档",
      repositories: [{ name: "pi-agent-ui", path: "/Users/me/pi-agent-ui" }],
      directories: [{ name: "docs", path: "/Users/me/docs" }],
      environment: [{ key: "NODE_ENV", value: "development" }],
      branchTemplate: "feature/{task-name}",
    });
  });

  it("keeps invalid rows and variables in place and names the field", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<Harness onSubmit={onSubmit} />);
    const dialog = openCreate();
    await user.type(dialog.getByLabelText("工作空间名称 *"), "A");
    await user.click(dialog.getByRole("button", { name: "添加 Git 仓库" }));
    await user.type(dialog.getByLabelText("仓库名称 1"), "relative-only");
    await user.type(dialog.getByLabelText("仓库路径 1"), "relative/path");
    await user.click(dialog.getByRole("button", { name: "添加变量" }));
    await user.type(dialog.getByLabelText("环境变量名 1"), "1BAD");
    await user.click(dialog.getByRole("button", { name: "创建工作区并保存配置" }));
    expect(await dialog.findByText("仓库 1：请填写名称和以 / 开头的本机绝对路径")).toBeInTheDocument();
    expect(dialog.getByText("环境变量 1：名称只能包含字母、数字或下划线，且不能以数字开头")).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(dialog.getByLabelText("仓库路径 1")).toHaveValue("relative/path");
  });

  it("saves with ⌘↵ and closes with Esc without submitting", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<Harness initial={{ ...projectDraft(), name: "PiDock", repositories: [{ name: "web", path: "/w/web" }] }} onSubmit={onSubmit} />);
    const dialog = openCreate();
    await user.click(dialog.getByLabelText("工作空间名称 *"));
    fireEvent.keyDown(document, { key: "Enter", metaKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("reuses the same dialog for editing and names the stored settings", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<Harness mode="edit" initial={{ ...projectDraft(), name: "PiDock", description: "旧描述",
      repositories: [{ id: "r1", name: "web", path: "/w/web" }], environment: [{ key: "NODE_ENV", value: "development" }],
      branchTemplate: "pi/{task-name}" }} onSubmit={onSubmit} sourceStatus={{ r1: { id: "r1", kind: "repository", status: "ok" } }} />);
    const dialog = within(screen.getByRole("dialog", { name: "编辑工作空间" }));
    expect(dialog.getByLabelText("工作空间名称 *")).toHaveValue("PiDock");
    expect(dialog.getByLabelText("Git 远程分支模板 *")).toHaveValue("pi/{task-name}");
    expect(dialog.getByText("路径可用")).toBeInTheDocument();
    await user.type(dialog.getByLabelText("工作空间名称 *"), " 2");
    await user.click(dialog.getByRole("button", { name: "保存更改" }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ name: "PiDock 2", repositories: [{ id: "r1", name: "web", path: "/w/web" }] }));
  });

  it("names a missing source and moves focus to that path so it can be repaired", async () => {
    const user = userEvent.setup();
    render(<Harness mode="edit" initial={{ ...projectDraft(), name: "PiDock",
      repositories: [{ id: "r1", name: "web", path: "/w/gone" }] }}
      sourceStatus={{ r1: { id: "r1", kind: "repository", status: "missing" } }} />);
    const dialog = within(screen.getByRole("dialog", { name: "编辑工作空间" }));
    expect(dialog.getByText("来源缺失")).toBeInTheDocument();
    await user.click(dialog.getByRole("button", { name: "修复路径" }));
    expect(dialog.getByLabelText("仓库路径 1")).toHaveFocus();
  });

  it("keeps a Host failure inside the dialog with the typed input", () => {
    render(<Harness initial={{ ...projectDraft(), name: "PiDock", repositories: [{ name: "web", path: "/w/web" }] }}
      error="项目名称重复" />);
    const dialog = openCreate();
    expect(dialog.getByRole("alert")).toHaveTextContent("项目名称重复");
    expect(dialog.getByLabelText("工作空间名称 *")).toHaveValue("PiDock");
    // Host errors never disable a retry.
    expect(dialog.getByRole("button", { name: "创建工作区并保存配置" })).toBeEnabled();
  });

  it("owns focus while open and returns it to the trigger on close", async () => {
    const user = userEvent.setup();
    function Host() {
      const [open, setOpen] = useState(false);
      return <>
        <button type="button" onClick={() => setOpen(true)}>打开</button>
        {open && <Harness onCancel={() => setOpen(false)} />}
      </>;
    }
    render(<Host />);
    await user.click(screen.getByRole("button", { name: "打开" }));
    const dialog = openCreate();
    expect(dialog.getByLabelText("工作空间名称 *")).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
