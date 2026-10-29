import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DesktopSchedulesPage } from "../components/DesktopSchedulesPage";

const tasks = [{ taskId: "a", name: "任务 A" }, { taskId: "b", name: "任务 B" }];
const schedule = (taskId: string, enabled: boolean) => ({ scheduleId: `schedule-${taskId}`, taskId, name: `计划 ${taskId}`, ruleText: "0 9 * * *", timezone: "Asia/Shanghai", providerId: "provider-x", model: "model-x", prompt: "整理报告", permission: "default", enabled });
const run = (taskId: string) => ({ runId: `run-${taskId}`, scheduleId: `schedule-${taskId}`, taskId, startedAt: "2026-09-29T09:00:00Z", result: "completed" });
const bridge = (handler: (taskId: string, op: string, payload: Record<string, unknown>) => unknown) => {
  const taskOp = vi.fn(async (taskId: string, op: string, payload: Record<string, unknown>) => handler(taskId, op, payload));
  window.pidock = { taskOp: taskOp as never };
  return taskOp;
};
afterEach(() => { cleanup(); delete window.pidock; });

const profile = (id: string, name: string, modelId: string) => ({ id, name, baseUrl: "https://127.0.0.1:8443", modelId, contextWindow: 128000, maxTokens: 8192, authRef: "PIDOCK_PROVIDER_TEST", generation: 1, credentialAvailable: true });
const providerStatus = (profiles: unknown[]) => ({ state: "configured", profileId: null, generation: null, profiles });
/** `shell/providerOp` is a separate bridge: the editor reads the task's real profiles through it. */
const withProviders = (payload: unknown) => {
  const providerOp = vi.fn(async () => ({ ok: true, payload }));
  window.pidock = { ...window.pidock, providerOp } as never;
  return providerOp;
};
const withProviderFailure = (error: string) => {
  const providerOp = vi.fn(async () => ({ ok: false, error }));
  window.pidock = { ...window.pidock, providerOp } as never;
  return providerOp;
};

it("lists Host schedules and runs across tasks with working filters and task navigation", async () => {
  const taskOp = bridge((taskId, op) => ({ ok: true, payload: { workspaceId: "local", taskId, op, payload: op === "task/scheduleList"
    ? { schedules: [schedule(taskId, taskId === "a")], templates: [] } : { runs: [run(taskId)] } } }));
  const onOpenTask = vi.fn();
  render(<DesktopSchedulesPage tasks={tasks} onOpenTask={onOpenTask} />);
  await waitFor(() => expect(screen.getAllByText("0 9 * * *")).toHaveLength(2));
  expect(within(document.querySelector('[data-schedule-row="schedule-a"]')!).getByText("计划 a")).toBeInTheDocument();
  expect(screen.getAllByText("已完成").length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("button", { name: "已暂停" }));
  expect(document.querySelector('[data-schedule-row="schedule-a"]')).toBeNull();
  expect(within(document.querySelector('[data-schedule-row="schedule-b"]')!).getByText("计划 b")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "查看任务" }));
  expect(onOpenTask).toHaveBeenCalledWith("b");
  expect(taskOp).toHaveBeenCalledWith("b", "task/scheduleRuns", {});
});

it("names a blank schedule field instead of an empty rule, name or table cell", async () => {
  // `parseSchedules`/`parseRuns` read every string with `text = typeof ===
  // "string"`, so a blank Host field really reaches this page; each fact names
  // its own absence instead of emptying a column or a row's own identity.
  bridge((taskId, op) => ({ ok: true, payload: { workspaceId: "local", taskId, op, payload: op === "task/scheduleList"
    ? { schedules: [{ ...schedule(taskId, true), name: "", ruleText: "", timezone: "", providerId: "", model: "" }], templates: [] }
    : { runs: [{ ...run(taskId), startedAt: "", reason: "" }] } } }));
  render(<DesktopSchedulesPage tasks={[tasks[0]!]} onOpenTask={() => {}} />);
  await screen.findByText("Host 未上报规则");
  const row = document.querySelector('[data-schedule-row="schedule-a"]') as HTMLElement;
  expect(row).toHaveTextContent("Host 未上报规则");
  expect(row).toHaveTextContent("Host 未上报时区");
  expect(row).toHaveTextContent("Host 未上报定时任务名称");
  expect(row).toHaveTextContent("Host 未上报 Provider / Host 未上报模型");
  const runRow = within(document.querySelector('[data-schedule-run="run-a"]') as HTMLElement);
  expect(runRow.getByText("Host 未上报开始时间")).toBeInTheDocument();
  // `??` used to miss a real `""`; the em dash is the named absence for this column.
  expect(runRow.getByText("—")).toBeInTheDocument();
  // The run table's 定时任务 cell names the same blank schedule name instead of
  // rendering a blank cell under a column header (the card above is not the only
  // render path of `parseSchedules.name`).
  expect(runRow.getByText("Host 未上报定时任务名称")).toBeInTheDocument();
  // ...and a run whose schedule really is gone keeps its own wording, so the two
  // cases stay distinguishable instead of collapsing into one string.
  expect(runRow.queryByText("已删除的定时任务")).toBeNull();
});

it("shows partial failure without presenting a global empty result", async () => {
  bridge((taskId, op) => taskId === "a" ? { ok: false, error: "host-unavailable" } : { ok: true, payload: op === "task/scheduleList" ? { schedules: [schedule(taskId, true)] } : { runs: [] } });
  render(<DesktopSchedulesPage tasks={tasks} onOpenTask={() => {}} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("任务 A：host-unavailable");
  expect(screen.getByText("计划 b")).toBeInTheDocument();
  expect(screen.getByText("已启用（部分）")).toBeInTheDocument();
});

it("retains schedules when only the execution history fails", async () => {
  bridge((taskId, op) => op === "task/scheduleList" ? { ok: true, payload: { schedules: [schedule(taskId, true)] } } : { ok: false, error: "history-unavailable" });
  render(<DesktopSchedulesPage tasks={[tasks[0]!]} onOpenTask={() => {}} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("任务 A：执行记录 history-unavailable");
  expect(screen.getByText("计划 a")).toBeInTheDocument();
  expect(screen.getByText("成功读取的任务中没有执行记录。")).toBeInTheDocument();
});

it("rejects malformed records and exposes a retry", async () => {
  let valid = false;
  const taskOp = bridge((taskId, op) => ({ ok: true, payload: op === "task/scheduleList" ? { schedules: valid ? [] : [{ ...schedule(taskId, true), taskId: "other-task" }] } : { runs: [] } }));
  render(<DesktopSchedulesPage tasks={[tasks[0]!]} onOpenTask={() => {}} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("定时配置返回异常");
  valid = true;
  fireEvent.click(screen.getByRole("button", { name: "刷新" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(screen.getByText("当前筛选下没有定时任务。")).toBeInTheDocument();
  expect(taskOp).toHaveBeenCalledTimes(3);
});

it("does not invent records when no task exists", async () => {
  const taskOp = bridge(() => { throw new Error("unexpected Host call"); });
  render(<DesktopSchedulesPage tasks={[]} onOpenTask={() => {}} />);
  expect(await screen.findByText("当前筛选下没有定时任务。")).toBeInTheDocument();
  expect(taskOp).not.toHaveBeenCalled();
});

it("toggles a schedule through the Host and re-reads its answer instead of flipping the row", async () => {
  let paused = true;
  const taskOp = bridge((taskId, op) => {
    if (op === "task/scheduleSetEnabled") { paused = false; return { ok: true, payload: { schedule: schedule(taskId, true) } }; }
    return { ok: true, payload: op === "task/scheduleList" ? { schedules: [schedule(taskId, !paused)] } : { runs: [] } };
  });
  const listReads = () => taskOp.mock.calls.filter(([, op]) => op === "task/scheduleList").length;
  render(<DesktopSchedulesPage tasks={[tasks[0]!]} onOpenTask={() => {}} />);
  await waitFor(() => expect(document.querySelector('[data-schedule-row="schedule-a"')).not.toBeNull());
  const row = () => document.querySelector('[data-schedule-row="schedule-a"]') as HTMLElement;
  expect(within(row()).getByText("已暂停")).toBeInTheDocument();
  expect(listReads()).toBe(1);
  fireEvent.click(within(row()).getByRole("button", { name: "启用 计划 a" }));
  await waitFor(() => expect(within(row()).getByText("已启用")).toBeInTheDocument());
  expect(taskOp).toHaveBeenCalledWith("a", "task/scheduleSetEnabled", { scheduleId: "schedule-a", enabled: true });
  // The badge comes from the Host's next list answer, not from the click: the row
  // is re-read after the Host accepts, so no optimistic flip can outlive a refusal.
  expect(listReads()).toBe(2);
});

it("keeps the previous state and quotes the Host refusal when a pause is refused", async () => {
  const taskOp = bridge((taskId, op) => op === "task/scheduleSetEnabled"
    ? { ok: false, error: "unknown-schedule: 定时任务 schedule-a 不存在" }
    : { ok: true, payload: op === "task/scheduleList" ? { schedules: [schedule(taskId, true)] } : { runs: [] } });
  render(<DesktopSchedulesPage tasks={[tasks[0]!]} onOpenTask={() => {}} />);
  await waitFor(() => expect(document.querySelector('[data-schedule-row="schedule-a"')).not.toBeNull());
  const row = () => document.querySelector('[data-schedule-row="schedule-a"]') as HTMLElement;
  fireEvent.click(within(row()).getByRole("button", { name: "暂停 计划 a" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("计划 a：unknown-schedule: 定时任务 schedule-a 不存在");
  // A refusal is not a new answer about the list: no re-read, no flipped badge.
  expect(taskOp.mock.calls.filter(([, op]) => op === "task/scheduleList")).toHaveLength(1);
  expect(within(row()).getByText("已启用")).toBeInTheDocument();
});

it("runs a schedule now through the Host, then shows the run the Host recorded", async () => {
  let runs: unknown[] = [];
  const taskOp = bridge((taskId, op, payload) => {
    if (op === "task/scheduleRunNow") {
      expect(payload).toEqual({ scheduleId: "schedule-a", label: "定时任务页" });
      runs = [{ runId: "run-manual", scheduleId: "schedule-a", taskId, startedAt: "2026-10-27T09:00:00Z", result: "awaiting-approval" }];
      return { ok: true, payload: { run: runs[0] } };
    }
    return { ok: true, payload: op === "task/scheduleList" ? { schedules: [schedule(taskId, true)] } : { runs } };
  });
  render(<DesktopSchedulesPage tasks={[tasks[0]!]} onOpenTask={() => {}} />);
  await waitFor(() => expect(document.querySelector('[data-schedule-row="schedule-a"')).not.toBeNull());
  expect(screen.getByText("暂无执行记录。")).toBeInTheDocument();
  fireEvent.click(within(document.querySelector('[data-schedule-row="schedule-a"]') as HTMLElement).getByRole("button", { name: "立即运行 计划 a" }));
  await waitFor(() => expect(document.querySelector('[data-schedule-run="run-manual"]')).not.toBeNull());
  expect(within(document.querySelector('[data-schedule-run="run-manual"]') as HTMLElement).getByText("待确认")).toBeInTheDocument();
  expect(screen.queryByText("暂无执行记录。")).toBeNull();
  expect(taskOp).toHaveBeenCalledWith("a", "task/scheduleRunNow", { scheduleId: "schedule-a", label: "定时任务页" });
});

it("shows the Host refusal when 立即运行 is refused and never claims a run", async () => {
  const taskOp = bridge((taskId, op) => op === "task/scheduleRunNow"
    ? { ok: false, error: "archived: 已归档任务不能通过「立即运行」绕过恢复" }
    : { ok: true, payload: op === "task/scheduleList" ? { schedules: [schedule(taskId, true)] } : { runs: [] } });
  render(<DesktopSchedulesPage tasks={[tasks[0]!]} onOpenTask={() => {}} />);
  await waitFor(() => expect(document.querySelector('[data-schedule-row="schedule-a"')).not.toBeNull());
  fireEvent.click(within(document.querySelector('[data-schedule-row="schedule-a"]') as HTMLElement).getByRole("button", { name: "立即运行 计划 a" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("计划 a：archived: 已归档任务不能通过「立即运行」绕过恢复");
  expect(document.querySelector('[data-schedule-run]')).toBeNull();
  expect(screen.getByText("暂无执行记录。")).toBeInTheDocument();
  // Nothing was minted, so there is nothing new to read.
  expect(taskOp.mock.calls.filter(([, op]) => op === "task/scheduleRuns")).toHaveLength(1);
});

it("opens the editor with the Host's own rule text and previews the edit through the Host", async () => {
  const taskOp = bridge((taskId, op, payload) => {
    if (op === "task/schedulePreview") {
      expect(payload).toEqual({ ruleText: "每日 09:15", timezone: "Asia/Shanghai" });
      return { ok: true, payload: { preview: { ok: true, description: "每天 09:15", nextTriggerAt: "2026-10-28T01:15:00.000Z" } } };
    }
    return { ok: true, payload: op === "task/scheduleList" ? { schedules: [schedule(taskId, true)] } : { runs: [] } };
  });
  withProviders(providerStatus([profile("p-00000000-0000-0000-0000-000000000001", "主 Provider", "model-a")]));
  render(<DesktopSchedulesPage tasks={[tasks[0]!]} onOpenTask={() => {}} />);
  await waitFor(() => expect(document.querySelector('[data-schedule-row="schedule-a"]')).not.toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "编辑 计划 a" }));
  const dialog = await screen.findByRole("dialog", { name: "编辑定时任务" });
  const rule = within(dialog).getByLabelText("规则") as HTMLInputElement;
  // The editor starts from the stored text, not from a re-derived rule: the Host
  // owns the rule language, and a round trip through a renderer parser would
  // rewrite text the Host still accepts.
  expect(rule.value).toBe("0 9 * * *");
  fireEvent.change(rule, { target: { value: "每日 09:15" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "校验并预览" }));
  expect(await within(dialog).findByText("每天 09:15")).toBeInTheDocument();
  expect(within(dialog).getByText("下次触发 2026-10-28T01:15:00.000Z")).toBeInTheDocument();
  expect(taskOp).toHaveBeenCalledWith("a", "task/schedulePreview", { ruleText: "每日 09:15", timezone: "Asia/Shanghai" });
});

it("quotes the Host's rule refusal inside the editor", async () => {
  bridge((taskId, op) => op === "task/schedulePreview"
    ? { ok: true, payload: { preview: { ok: false, code: "rule-unrecognized", message: "无法识别的规则：每天九点" } } }
    : { ok: true, payload: op === "task/scheduleList" ? { schedules: [schedule(taskId, true)] } : { runs: [] } });
  withProviders(providerStatus([]));
  render(<DesktopSchedulesPage tasks={[tasks[0]!]} onOpenTask={() => {}} />);
  await waitFor(() => expect(document.querySelector('[data-schedule-row="schedule-a"]')).not.toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "编辑 计划 a" }));
  const dialog = await screen.findByRole("dialog", { name: "编辑定时任务" });
  fireEvent.change(within(dialog).getByLabelText("规则"), { target: { value: "每天九点" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "校验并预览" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent("无法识别的规则：每天九点");
  expect(within(dialog).queryByText(/下次触发/)).toBeNull();
});

it("saves exactly the edited config and closes only after the Host accepts", async () => {
  let name = "计划 a";
  const taskOp = bridge((taskId, op, payload) => {
    if (op === "task/scheduleSave") {
      expect(payload).toEqual({ scheduleId: "schedule-a", name: "每日站会", ruleText: "每日 09:15", timezone: "Asia/Shanghai", prompt: "整理报告", providerId: "provider-x", model: "model-x", permission: "default" });
      name = "每日站会";
      return { ok: true, payload: { schedule: { ...schedule(taskId, true), name } } };
    }
    return { ok: true, payload: op === "task/scheduleList" ? { schedules: [{ ...schedule(taskId, true), name }] } : { runs: [] } };
  });
  withProviders(providerStatus([]));
  render(<DesktopSchedulesPage tasks={[tasks[0]!]} onOpenTask={() => {}} />);
  await waitFor(() => expect(document.querySelector('[data-schedule-row="schedule-a"]')).not.toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "编辑 计划 a" }));
  const dialog = await screen.findByRole("dialog", { name: "编辑定时任务" });
  fireEvent.change(within(dialog).getByLabelText("规则"), { target: { value: "每日 09:15" } });
  fireEvent.change(within(dialog).getByLabelText("名称"), { target: { value: "每日站会" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "编辑定时任务" })).toBeNull());
  // The row shows the Host's next list answer, not the text that was typed.
  await waitFor(() => expect(screen.getByText("每日站会")).toBeInTheDocument());
  expect(taskOp.mock.calls.filter(([, op]) => op === "task/scheduleList")).toHaveLength(2);
  expect(taskOp.mock.calls.filter(([, op]) => op === "task/scheduleSave")).toHaveLength(1);
});

it("keeps the editor open and quotes the Host when the save is refused", async () => {
  const taskOp = bridge((taskId, op) => op === "task/scheduleSave"
    ? { ok: false, error: "provider-missing: Provider 配置 provider-x 已不存在" }
    : { ok: true, payload: op === "task/scheduleList" ? { schedules: [schedule(taskId, true)] } : { runs: [] } });
  withProviders(providerStatus([]));
  render(<DesktopSchedulesPage tasks={[tasks[0]!]} onOpenTask={() => {}} />);
  await waitFor(() => expect(document.querySelector('[data-schedule-row="schedule-a"]')).not.toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "编辑 计划 a" }));
  const dialog = await screen.findByRole("dialog", { name: "编辑定时任务" });
  fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent("provider-missing: Provider 配置 provider-x 已不存在");
  expect(screen.getByRole("dialog", { name: "编辑定时任务" })).toBeInTheDocument();
  // A refusal is not a new list answer: the rows are not re-read.
  expect(taskOp.mock.calls.filter(([, op]) => op === "task/scheduleList")).toHaveLength(1);
});

it("offers the task's real Provider profiles and keeps a Provider the list does not name", async () => {
  bridge((taskId, op, payload) => {
    if (op === "task/scheduleSave") {
      expect(payload).toMatchObject({ providerId: "p-00000000-0000-0000-0000-000000000001", model: "model-a" });
      return { ok: true, payload: { schedule: schedule(taskId, true) } };
    }
    return { ok: true, payload: op === "task/scheduleList" ? { schedules: [schedule(taskId, true)] } : { runs: [] } };
  });
  withProviders(providerStatus([profile("p-00000000-0000-0000-0000-000000000001", "主 Provider", "model-a")]));
  render(<DesktopSchedulesPage tasks={[tasks[0]!]} onOpenTask={() => {}} />);
  await waitFor(() => expect(document.querySelector('[data-schedule-row="schedule-a"]')).not.toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "编辑 计划 a" }));
  const dialog = await screen.findByRole("dialog", { name: "编辑定时任务" });
  const model = within(dialog).getByLabelText("Provider / 模型") as HTMLSelectElement;
  await waitFor(() => expect(within(model).getByRole("option", { name: "主 Provider / model-a" })).toBeInTheDocument());
  // The stored identity is not silently replaced by the first listed profile.
  expect(within(model).getByRole("option", { name: "provider-x / model-x（不在当前 Provider 列表）" })).toBeInTheDocument();
  expect(model.value).toBe("provider-x\u0000model-x");
  fireEvent.change(model, { target: { value: "p-00000000-0000-0000-0000-000000000001\u0000model-a" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "编辑定时任务" })).toBeNull());
});

it("keeps the stored Provider selectable when the Provider list cannot be read", async () => {
  const taskOp = bridge((taskId, op) => ({ ok: true, payload: op === "task/scheduleList" ? { schedules: [schedule(taskId, true)] } : { runs: [] } }));
  withProviderFailure("Provider 配置不可用");
  render(<DesktopSchedulesPage tasks={[tasks[0]!]} onOpenTask={() => {}} />);
  await waitFor(() => expect(document.querySelector('[data-schedule-row="schedule-a"]')).not.toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "编辑 计划 a" }));
  const dialog = await screen.findByRole("dialog", { name: "编辑定时任务" });
  expect(await within(dialog).findByRole("alert")).toHaveTextContent("Provider 列表读取失败：Provider 配置不可用");
  const model = within(dialog).getByLabelText("Provider / 模型") as HTMLSelectElement;
  expect(within(model).getAllByRole("option")).toHaveLength(1);
  expect(model.value).toBe("provider-x\u0000model-x");
  fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
  // The stored identity stays the one that is saved: an unreadable list never
  // turns into a silent switch to another Provider.
  await waitFor(() => expect(taskOp).toHaveBeenCalledWith("a", "task/scheduleSave", expect.objectContaining({ providerId: "provider-x", model: "model-x" })));
});
