/**
 * #47 S8d hard constraint: opening a tool panel is on-demand, and closing one
 * must not implicitly stop services or destroy the session.
 *
 * The production conversation is mounted over a recording bridge, so the test
 * sees every op the renderer actually sends. The assertions are deliberately
 * negative: no `task/controlService` / `task/quit` / `task/archive` /
 * `task/terminalControl`, and no SDK `unsubscribe`/`cancel` — a panel close is
 * a view change, never a lifecycle change.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DesktopConversation } from "../components/DesktopConversation";
import type { PidockBridge } from "../data/shellBridge";

const roots = [{ label: "默认任务根", state: "ready" }];
const association = { taskId: "task-a", projectId: "project-1", state: "assigned" };
const SERVICE_ID = "s-33333333-3333-3333-3333-333333333333";
const ENVIRONMENT_ID = "e-33333333-3333-3333-3333-333333333333";
const WRITE_OPS = ["task/controlService", "task/quit", "task/archive", "task/restore", "task/terminalControl", "task/runCleanup"];

function setup() {
  let listener: ((event: unknown) => void) | undefined;
  const taskOpCalls: Array<{ taskId: string; op: string }> = [];
  const serviceCatalogOpCalls: Array<Record<string, unknown>> = [];
  const sdkActions: string[] = [];
  const bridge: PidockBridge = {
    listTasks: vi.fn(async () => ({ ok: true, payload: { tasks: [{ taskId: "task-a", name: "Task", branch: "main", repoCount: 0, updatedAt: "now" }], roots } })),
    projectOp: vi.fn(async (request) => ({ ok: true, payload: request.op === "list" ? { initialized: true, projects: [{ id: "project-1", name: "Adder", description: "", repositories: [], directories: [] }] } : { roots, tasks: [association] } })),
    serviceCatalogOp: vi.fn(async (request: Record<string, unknown>) => {
      serviceCatalogOpCalls.push(request);
      if (request["op"] === "taskBindings") return { ok: true, payload: [{ taskId: "task-a", serviceId: SERVICE_ID, environmentId: ENVIRONMENT_ID, environmentName: "本地开发", templateVersion: 1, rootId: "invoice-service", subdir: "", privateKeys: [] }] };
      if (request["op"] === "list") return { ok: true, payload: [{ projectId: "project-1", environmentId: ENVIRONMENT_ID, serviceId: SERVICE_ID, version: 1, shared: [], descriptor: { name: "invoice-local", program: "node", args: [], ports: [4100], runType: "long-lived" } }] };
      return { ok: false, error: `unexpected ${String(request["op"])}` };
    }),
    taskOp: vi.fn(async (taskId: string, op: string, payload?: Record<string, unknown>) => {
      taskOpCalls.push({ taskId, op });
      if (op === "task/browserAction" && payload?.["action"] === "page/open") return { ok: true, payload: { pageId: "browser-page-1", url: "http://127.0.0.1:4000" } };
      if (op === "task/serviceStatus") return { ok: true, payload: { service: { serviceId: SERVICE_ID, state: "running", ownerSessionId: null, busy: false, closing: false, retainedRights: null, executionAvailable: false } } };
      if (op === "task/serviceLog") return { ok: true, payload: { log: [{ at: "2026-10-08T00:00:01.000Z", line: "listening at :4100" }] } };
      if (op === "task/serviceRunRecords") return { ok: true, payload: { records: [], registered: [] } };
      return { ok: false, error: `unexpected ${op}` };
    }),
    providerOp: vi.fn(async () => ({ ok: true, payload: { state: "not-configured", profileId: null, generation: null, profiles: [] } })),
    onSdkTurnEvent: vi.fn((callback) => { listener = callback; return () => { listener = undefined; }; }),
    sdkTurn: vi.fn(async (request: Record<string, unknown>) => {
      sdkActions.push(String(request["action"]));
      if (request["action"] === "subscribe") return { ok: true, payload: { taskId: "task-a", sessionId: "main", snapshot: { source: "sdk-jsonl", sessionId: "main", messages: [], pending: false, interrupted: false }, turn: null } };
      if (request["action"] === "projection") return { ok: true, payload: { source: "sdk-jsonl", sessionId: "main", messages: [], pending: false, interrupted: false } };
      if (request["action"] === "status") return { ok: true, payload: { turn: null } };
      return { ok: true, payload: { unsubscribed: true } };
    }),
  };
  return { bridge, taskOpCalls, serviceCatalogOpCalls, sdkActions, subscribed: () => Boolean(listener) };
}

function mount(fixture: ReturnType<typeof setup>) {
  window.pidock = fixture.bridge;
  return render(
    <DesktopConversation taskId="task-a" name="Task" branch="task/main" repoCount={1} roots={JSON.stringify(roots)} association={JSON.stringify(association)} onBack={vi.fn()} onOpenProviders={vi.fn()} onArchived={vi.fn()} />,
  );
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  delete (window as { pidock?: unknown }).pidock;
  vi.restoreAllMocks();
});

describe("[UI 对齐] S8d tool panels are on-demand and close-only", () => {
  it("opens a real panel only after the user clicks, and closing it stops no service and keeps the session", async () => {
    const fixture = setup();
    mount(fixture);
    await screen.findByText(/仅 main 会话/);
    await waitFor(() => expect(fixture.subscribed()).toBe(true));
    expect(screen.queryByTestId("desktop-tool-dock")).not.toBeInTheDocument();
    // Mounting the conversation issues exactly two Host reads — the composer's own
    // 推理/上下文 readout (`task/sessionContext`) and the #24 execution-status read
    // (`task/executionState`, read only) — and no panel op: opening a tool panel is
    // still on demand.
    expect(fixture.taskOpCalls.map((call) => call.op).sort()).toEqual(["task/executionState", "task/sessionContext"]);

    fireEvent.click(screen.getByRole("button", { name: "运行" }));
    expect(await screen.findByTestId("desktop-tool-dock")).toHaveAttribute("data-tool", "runtime");
    expect(await screen.findByText("invoice-local")).toBeInTheDocument();
    expect(fixture.subscribed()).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "关闭面板" }));
    expect(screen.queryByTestId("desktop-tool-dock")).not.toBeInTheDocument();
    // The conversation is intact: history, session tab and composer are still there.
    expect(screen.getByText(/仅 main 会话/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "消息" })).toBeInTheDocument();
    expect(fixture.subscribed()).toBe(true);
    expect(fixture.sdkActions.filter((action) => action === "unsubscribe" || action === "cancel")).toEqual([]);
    expect(fixture.taskOpCalls.map((call) => call.op).filter((op) => WRITE_OPS.includes(op))).toEqual([]);

    // A second, different panel is a fresh on-demand open with the same guarantees.
    fireEvent.click(screen.getByRole("button", { name: "日志" }));
    expect(await screen.findByTestId("desktop-tool-dock")).toHaveAttribute("data-tool", "logs");
    expect(await screen.findByText(/listening at :4100/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭面板" }));
    expect(screen.queryByTestId("desktop-tool-dock")).not.toBeInTheDocument();
    expect(fixture.subscribed()).toBe(true);
    expect(fixture.sdkActions.filter((action) => action === "unsubscribe" || action === "cancel")).toEqual([]);
    expect(fixture.taskOpCalls.map((call) => call.op).filter((op) => WRITE_OPS.includes(op))).toEqual([]);
    await waitFor(() => expect(screen.getByRole("button", { name: "运行" })).toHaveAttribute("aria-pressed", "false"));
  });

  it("keeps two opened tools as selectable tabs", async () => {
    const fixture = setup();
    mount(fixture);
    await screen.findByText(/仅 main 会话/);
    fireEvent.click(screen.getByRole("button", { name: "运行" }));
    await screen.findByText("invoice-local");
    fireEvent.click(screen.getByRole("button", { name: "日志" }));
    await screen.findByText(/listening at :4100/);

    const tabs = screen.getByRole("tablist", { name: "已打开的工具" });
    expect(within(tabs).getByRole("tab", { name: "运行" })).toHaveAttribute("aria-selected", "false");
    expect(within(tabs).getByRole("tab", { name: "日志" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(within(tabs).getByRole("tab", { name: "运行" }));
    expect(within(tabs).getByRole("tab", { name: "运行" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByTestId("desktop-tool-dock")).toHaveAttribute("data-tool", "runtime");
  });

  it("closes one tool tab without issuing task or service-catalog operations", async () => {
    const fixture = setup();
    mount(fixture);
    await screen.findByText(/仅 main 会话/);
    fireEvent.click(screen.getByRole("button", { name: "运行" }));
    await screen.findByText("invoice-local");
    fireEvent.click(screen.getByRole("button", { name: "日志" }));
    await screen.findByText(/listening at :4100/);
    fireEvent.click(screen.getByRole("button", { name: "浏览器" }));
    fireEvent.change(screen.getByRole("textbox", { name: "任务页面地址" }), { target: { value: "http://127.0.0.1:4000" } });
    fireEvent.click(screen.getByRole("button", { name: "打开任务页面" }));
    await screen.findByTestId("dock-browser-page");
    const taskOpCount = fixture.taskOpCalls.length;
    const serviceCatalogOpCount = fixture.serviceCatalogOpCalls.length;

    fireEvent.click(screen.getByRole("button", { name: "关闭浏览器" }));

    expect(screen.queryByRole("tab", { name: "浏览器" })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "日志" })).toHaveAttribute("aria-selected", "true");
    expect(fixture.taskOpCalls).toHaveLength(taskOpCount);
    expect(fixture.serviceCatalogOpCalls).toHaveLength(serviceCatalogOpCount);
    expect(fixture.taskOpCalls.map((call) => call.op).filter((op) => WRITE_OPS.includes(op))).toEqual([]);

    fireEvent.click(screen.getByRole("tab", { name: "运行" }));
    const taskOpCountBeforeRuntimeClose = fixture.taskOpCalls.length;
    const serviceCatalogOpCountBeforeRuntimeClose = fixture.serviceCatalogOpCalls.length;
    fireEvent.click(screen.getByRole("button", { name: "关闭运行" }));
    expect(screen.queryByRole("tab", { name: "运行" })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "日志" })).toHaveAttribute("aria-selected", "true");
    expect(fixture.taskOpCalls).toHaveLength(taskOpCountBeforeRuntimeClose);
    expect(fixture.serviceCatalogOpCalls).toHaveLength(serviceCatalogOpCountBeforeRuntimeClose);
  });

  it("keeps the open tool tabs while the dock is collapsed and reopened", async () => {
    const fixture = setup();
    mount(fixture);
    await screen.findByText(/仅 main 会话/);
    fireEvent.click(screen.getByRole("button", { name: "运行" }));
    await screen.findByText("invoice-local");
    fireEvent.click(screen.getByRole("button", { name: "日志" }));
    await screen.findByText(/listening at :4100/);
    const taskOpCount = fixture.taskOpCalls.length;
    const serviceCatalogOpCount = fixture.serviceCatalogOpCalls.length;

    fireEvent.click(screen.getByRole("button", { name: "收起工具区" }));
    expect(screen.getByTestId("desktop-tool-dock")).toHaveAttribute("hidden");
    fireEvent.click(screen.getByRole("button", { name: "展开工具区" }));

    const tabs = screen.getByRole("tablist", { name: "已打开的工具" });
    expect(within(tabs).getByRole("tab", { name: "运行" })).toBeInTheDocument();
    expect(within(tabs).getByRole("tab", { name: "日志" })).toBeInTheDocument();
    expect(fixture.taskOpCalls).toHaveLength(taskOpCount);
    expect(fixture.serviceCatalogOpCalls).toHaveLength(serviceCatalogOpCount);
  });

  it("toggles a panel shut with the same tool button without breaking the session", async () => {
    const fixture = setup();
    mount(fixture);
    await screen.findByText(/仅 main 会话/);
    await waitFor(() => expect(fixture.subscribed()).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "协议" }));
    expect(await screen.findByTestId("desktop-tool-dock")).toHaveAttribute("data-tool", "protocol");
    fireEvent.click(screen.getByRole("button", { name: "协议" }));
    expect(screen.queryByTestId("desktop-tool-dock")).not.toBeInTheDocument();
    expect(fixture.subscribed()).toBe(true);
    expect(fixture.taskOpCalls.map((call) => call.op).filter((op) => WRITE_OPS.includes(op))).toEqual([]);
  });
});
