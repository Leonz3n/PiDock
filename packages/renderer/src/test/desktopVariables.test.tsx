/**
 * [Pencil T09] #144: S07/S08 variable panel — provenance, exact-key edits and
 * the stated change boundary. The form never rewrites a whole variable array:
 * each save/delete is one `projectOp` naming one key.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DesktopTaskVariables, DesktopWorkspaceVariables } from "../components/DesktopVariables";
import type { PidockBridge } from "../data/shellBridge";

afterEach(() => { cleanup(); delete (window as { pidock?: unknown }).pidock; });

type Row = { key: string; value: string };
function harness(initial: { workspace: Row[]; overrides: Row[] }) {
  const workspace = [...initial.workspace];
  let overrides = [...initial.overrides];
  const effective = () => {
    const map = new Map<string, { key: string; value: string; scope: "workspace" | "task"; inheritedValue: string | null }>();
    for (const row of workspace) map.set(row.key, { ...row, scope: "workspace", inheritedValue: null });
    for (const row of overrides) {
      const base = map.get(row.key);
      map.set(row.key, { ...row, scope: "task", inheritedValue: base?.scope === "workspace" ? base.value : base?.inheritedValue ?? null });
    }
    return [...map.values()].sort((left, right) => left.key.localeCompare(right.key));
  };
  const view = () => ({ taskId: "task-1", projectId: "project-1", workspace, overrides, effective: effective(),
    refused: [], environment: Object.fromEntries(effective().map((row) => [row.key, row.value])) });
  const projectOp = vi.fn(async (request: { op: string; taskId?: string; projectId?: string; key?: string; value?: string }) => {
    switch (request.op) {
      case "taskVariables": return { ok: true, payload: view() };
      case "setTaskVariable": {
        overrides = [...overrides.filter((row) => row.key !== request.key), { key: request.key!, value: request.value! }];
        return { ok: true, payload: view() };
      }
      case "removeTaskVariable": {
        overrides = overrides.filter((row) => row.key !== request.key);
        return { ok: true, payload: { ...view(), removed: true } };
      }
      case "variables": return { ok: true, payload: { workspace } };
      case "setVariable": {
        const index = workspace.findIndex((row) => row.key === request.key);
        const row = { key: request.key!, value: request.value! };
        if (index < 0) workspace.push(row); else workspace[index] = row;
        return { ok: true, payload: { workspace } };
      }
      case "removeVariable": {
        const index = workspace.findIndex((row) => row.key === request.key);
        if (index >= 0) workspace.splice(index, 1);
        return { ok: true, payload: { removed: index >= 0, workspace } };
      }
      default: return { ok: false, error: `unexpected ${request.op}` };
    }
  });
  const bridge: PidockBridge = { projectOp };
  return { bridge, projectOp, overrides: () => overrides };
}

describe("task variables (S08)", () => {
  it("shows inherited and overridden values with their real scope and the change boundary", async () => {
    const f = harness({ workspace: [{ key: "NODE_ENV", value: "development" }, { key: "API_BASE_URL", value: "https://api.dev" }],
      overrides: [{ key: "NODE_ENV", value: "test" }] });
    render(<DesktopTaskVariables taskId="task-1" bridge={f.bridge} />);
    await screen.findByTestId("variable-NODE_ENV");
    const overridden = screen.getByTestId("variable-NODE_ENV");
    expect(overridden).toHaveTextContent("任务覆盖");
    expect(overridden).toHaveTextContent("NODE_ENV = test");
    expect(overridden).toHaveTextContent("工作区值 development");
    const inherited = screen.getByTestId("variable-API_BASE_URL");
    expect(inherited).toHaveTextContent("工作区继承");
    expect(inherited).toHaveTextContent("API_BASE_URL = https://api.dev");
    expect(screen.getByText(/变更在任务 Host 下次启动时生效；运行中的会话保持原环境/)).toBeInTheDocument();
    expect(screen.getByText(/凭据请使用 Provider 凭据/)).toBeInTheDocument();
  });

  it("saves one task override by exact key and deletes it to restore inheritance", async () => {
    const f = harness({ workspace: [{ key: "NODE_ENV", value: "development" }], overrides: [] });
    render(<DesktopTaskVariables taskId="task-1" bridge={f.bridge} />);
    await screen.findByTestId("variable-NODE_ENV");

    fireEvent.change(screen.getByLabelText("任务变量名"), { target: { value: "NODE_ENV" } });
    fireEvent.change(screen.getByLabelText("任务变量值"), { target: { value: "test" } });
    fireEvent.click(screen.getByRole("button", { name: "保存任务覆盖" }));
    await waitFor(() => expect(f.projectOp).toHaveBeenCalledWith({ op: "setTaskVariable", taskId: "task-1", key: "NODE_ENV", value: "test" }));
    await waitFor(() => expect(screen.getByTestId("variable-NODE_ENV")).toHaveTextContent("任务覆盖"));
    expect(f.overrides()).toEqual([{ key: "NODE_ENV", value: "test" }]);

    fireEvent.click(screen.getByRole("button", { name: "删除覆盖" }));
    await waitFor(() => expect(f.projectOp).toHaveBeenCalledWith({ op: "removeTaskVariable", taskId: "task-1", key: "NODE_ENV" }));
    await waitFor(() => expect(screen.getByTestId("variable-NODE_ENV")).toHaveTextContent("工作区继承"));
    expect(f.overrides()).toEqual([]);
  });

  it("refuses reserved and credential-shaped names before any IPC call", async () => {
    const f = harness({ workspace: [{ key: "NODE_ENV", value: "development" }], overrides: [] });
    render(<DesktopTaskVariables taskId="task-1" bridge={f.bridge} />);
    await screen.findByTestId("variable-NODE_ENV");
    for (const key of ["PATH", "PIDOCK_TASK_ID", "OPENAI_API_KEY"]) {
      fireEvent.change(screen.getByLabelText("任务变量名"), { target: { value: key } });
      fireEvent.change(screen.getByLabelText("任务变量值"), { target: { value: "x" } });
      fireEvent.click(screen.getByRole("button", { name: "保存任务覆盖" }));
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(key);
      expect(f.projectOp.mock.calls.filter(([request]) => request.op === "setTaskVariable")).toHaveLength(0);
    }
  });

  it("names a failed read instead of rendering an empty inherited list", async () => {
    const bridge: PidockBridge = { projectOp: vi.fn(async () => ({ ok: false, error: "该任务未归属工作空间，无法继承工作空间变量" })) };
    render(<DesktopTaskVariables taskId="task-1" bridge={bridge} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("未归属工作空间");
    expect(screen.queryByTestId("variable-NODE_ENV")).not.toBeInTheDocument();
  });
});

describe("workspace variables (S07)", () => {
  it("adds, edits and deletes by exact key", async () => {
    const f = harness({ workspace: [], overrides: [] });
    render(<DesktopWorkspaceVariables projectId="project-1" bridge={f.bridge} />);
    await screen.findByTestId("desktop-workspace-variables");
    fireEvent.change(screen.getByLabelText("工作空间变量名"), { target: { value: "DEBUG" } });
    fireEvent.change(screen.getByLabelText("工作空间变量值"), { target: { value: "pidock:*" } });
    fireEvent.click(screen.getByRole("button", { name: "保存变量" }));
    await waitFor(() => expect(f.projectOp).toHaveBeenCalledWith({ op: "setVariable", projectId: "project-1", key: "DEBUG", value: "pidock:*" }));
    await screen.findByTestId("workspace-variable-DEBUG");

    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() => expect(f.projectOp).toHaveBeenCalledWith({ op: "removeVariable", projectId: "project-1", key: "DEBUG" }));
    await waitFor(() => expect(screen.queryByTestId("workspace-variable-DEBUG")).not.toBeInTheDocument());
    expect(screen.getByText(/逐键保存；任务默认继承/)).toBeInTheDocument();
  });

  it("keeps the dense rows usable at the 900 and 560 window heights", async () => {
    const f = harness({ workspace: [{ key: "NODE_ENV", value: "development" }, { key: "API_BASE_URL", value: "https://api.dev" }], overrides: [] });
    for (const height of [900, 560]) {
      const { unmount } = render(<div style={{ width: height === 900 ? 1440 : 720, height }}>
        <DesktopWorkspaceVariables projectId="project-1" bridge={f.bridge} />
      </div>);
      await screen.findByTestId("workspace-variable-NODE_ENV");
      // Rows keep their own line box and the key/value form wraps to one column below the narrow tier.
      expect(screen.getByTestId("workspace-variable-NODE_ENV").className).toContain("flex-wrap");
      const form = screen.getByLabelText("工作空间变量名").parentElement!;
      expect(form.className).toContain("below-narrow:grid-cols-1");
      expect(form.className).not.toContain("overflow-hidden");
      unmount();
    }
  });
});
