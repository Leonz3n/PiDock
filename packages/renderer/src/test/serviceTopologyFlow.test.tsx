import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { RuntimePanel } from "../components/ToolPanels";
import { createMemoryHost } from "../data/memoryHost";
import { resolveHostAdapter } from "../data/shellHost";
import { renderApp, resetRenderer } from "./helpers";

/**
 * [PiDock 05] (#10) task-view topology flows: the runtime panel shows the
 * instance identity + location, the actual dependency destination, the start
 * order (prestart step, bidirectional listener group, remote reachability),
 * the run record with code/build state, a locatable failure and the shared
 * external resources / known limits.
 */
describe("runtime panel topology", () => {
  it("shows instance identity, dependency routing, start order and the run record", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });

    await user.click(screen.getByRole("button", { name: "运行" }));

    // Box 1/3: each service row carries its own instance address, so two
    // tasks' same-name services are distinguishable.
    expect(await screen.findByTestId("service-instance-release-service-1")).toHaveTextContent("release/release-service-1@5173");
    expect(screen.getByTestId("service-instance-release-service-2")).toHaveTextContent("release/release-service-2@3001");

    // [UI 对齐 03] (#27) a 43%-wide panel with a long monospace address used to
    // squeeze the action buttons into wrapped text; the row keeps the action
    // group at its own size and truncates the name/address instead. jsdom has no
    // layout, so the class contract is asserted here (the rendered result is in
    // `docs/evidence/ui-alignment-s2/renderer/*-one-panel.png`).
    // [UI 对齐 04] (#28) moved the row to the prototype's shape: the endpoint
    // (`127.0.0.1:port · 运行中`) owns the second line, the mode toggle and the
    // run button are icon-sized, and the untruncated identity stays in `title`.
    const firstRow = screen.getByTestId("service-row-release-service-1");
    expect(firstRow.querySelector("span.truncate")).not.toBeNull();
    expect(screen.getByTestId("service-instance-release-service-1").className).toContain("truncate");
    const rowItem = firstRow.closest("li") as HTMLElement;
    expect(rowItem).toHaveTextContent("127.0.0.1:5173 · 运行中");
    expect(rowItem).toHaveAttribute("title", expect.stringContaining("release/release-service-1@5173"));
    const stopButton = within(rowItem).getByRole("button", { name: "停止 saas-web" });
    expect(stopButton.className).toContain("shrink-0");
    expect(stopButton.parentElement?.className).toContain("shrink-0");
    expect(stopButton.parentElement?.className).toContain("whitespace-nowrap");

    // Box 1: the runtime binding of the selected service goes to this task's
    // instance; its repo-default URL keeps the shared environment value.
    const routing = await screen.findByTestId("service-routing");
    expect(routing).toHaveTextContent("PORT");
    expect(routing).toHaveTextContent("release/release-service-1@5173（本任务实例）");
    expect(routing).toHaveTextContent("API_BASE_URL");
    expect(routing).toHaveTextContent("共享环境 测试环境");
    // Box 2: the binding is audited against the read points it actually has.
    expect(routing).toHaveTextContent("读取点：仓库默认配置 · .env");
    expect(routing).toHaveTextContent("读取点：运行时端口绑定 · 本地");

    // Box 4: the prepare step runs first, the bidirectional pair listens as
    // one group, and the remote dependency is a reachability check.
    const groups = await screen.findByTestId("service-groups");
    expect(groups).toHaveTextContent("准备步骤（先完成）");
    expect(groups).toHaveTextContent("db-migrate");
    expect(groups).toHaveTextContent("双向调用组（先监听再互验）");
    expect(groups).toHaveTextContent("invoice-service + shipment-service");
    expect(groups).toHaveTextContent("远程依赖可达性检查 account-service");
    expect(groups).toHaveTextContent("先监听再互验，不等待对方就绪");

    // Box 6: the run record ties code state, build freshness, ports, process
    // identity and the per-instance log path together.
    const record = await screen.findByTestId("service-run-record");
    expect(record).toHaveTextContent("构建与当前提交一致");
    expect(record).toHaveTextContent("已提交且干净");
    // Box 3/6 honesty: the port a service row shows is a DECLARED one - nothing
    // probed the socket - so the record says so instead of reading as observed.
    expect(record).toHaveTextContent("5173（声明端口，未实测监听）");
    expect(record).not.toHaveTextContent("5173（实测监听）");
    expect(record).toHaveTextContent("pid 4100");
    expect(record).toHaveTextContent("/tasks/release/services/saas-web/run-1.log");
    expect(record).toHaveTextContent("内存模拟记录（未接入真实进程）");

    // Box 7: shared external resources with their limits, never "isolated".
    const limits = await screen.findByTestId("service-known-limits");
    expect(limits).toHaveTextContent("invoice-events");
    expect(limits).toHaveTextContent("共享（未隔离）");
    expect(limits).toHaveTextContent("dtm-callback");
    expect(limits).toHaveTextContent("不标记为任务隔离成功");
  });

  it("labels an uncommitted-code run differently from a stale build", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });
    await user.click(screen.getByRole("button", { name: "运行" }));

    await user.click(await screen.findByTestId("service-row-release-service-2"));
    const record = await screen.findByTestId("service-run-record");
    expect(record).toHaveTextContent("有未提交修改");
    expect(record).toHaveTextContent("工作副本有未提交修改，构建不含这些改动");

    await user.click(screen.getByTestId("service-row-release-service-3"));
    expect(await screen.findByTestId("service-run-record")).toHaveTextContent("构建来自旧提交");
  });

  it("shows a locatable failure with its retry hint", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/checkout?session=main");
    await screen.findByRole("heading", { name: "结账页无障碍" });

    await user.click(screen.getByRole("button", { name: "运行" }));
    // The failure block belongs to the selected service.
    await user.click(await screen.findByTestId("service-row-checkout-service-3"));
    const failure = await screen.findByTestId("service-failure");
    expect(failure).toHaveTextContent("端口被占用 · invoice-service");
    expect(failure).toHaveTextContent("端口 9001 已被任务实例 release/invoice-service@9001 占用");
    expect(failure).toHaveTextContent("运行管理会重新分配端口并更新受影响的消费者");
  });

  it("names the run instance and log file in the logs panel", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });

    await user.click(screen.getByRole("button", { name: "日志" }));
    const instances = await screen.findByTestId("log-instances");
    expect(instances).toHaveTextContent("saas-web · release/release-service-1@5173");
    expect(instances).toHaveTextContent("/tasks/release/services/saas-web/run-1.log");
    expect(within(await screen.findByTestId("runtime-logs")).getByText(/saas-web/)).toBeInTheDocument();
  });

  it("renders a real Host run record's declared ports and observed pid instead of the fixture", async () => {
    /**
     * [PiDock 05] (#10 review P1) reachability of the declared-port field: the
     * bridge answers `task/serviceRunRecords` with the SAME shape the real Host
     * returns after a catalog start (`packages/shell/src/host/
     * service-two-task-isolation.test.ts` reads it back from the Host) - the pid
     * is OBSERVED, the port list is DECLARED (`portsSource: "declared"`) and the
     * code/build state is `unknown`. The panel must show THAT record, not the
     * memory fixture (`release-service-1@5173`, pid 4100, 内存模拟记录). A rename
     * of the Host's fields turns this red instead of silently falling back.
     */
    const taskOp = vi.fn(async (_taskId: string, op: string) => {
      if (op === "task/serviceRunRecords") {
        return {
          ok: true,
          payload: {
            records: [
              {
                runId: "run-1",
                taskId: "release",
                serviceId: "release-service-1",
                instanceId: "release/release-service-1@53101",
                templateVersion: "v1",
                codeState: { kind: "unknown", note: "缺少提交信息，无法判断代码状态" },
                buildFreshness: "unknown",
                ports: [53101],
                portsSource: "declared",
                processIdentity: { owner: "human", pid: 4242, startedAt: "2026-10-07T01:00:00.000Z" },
                logRef: "/tasks/release/services/release-service-1/run-run-1.log",
                startedAt: "2026-10-07T01:00:00.000Z",
                verifications: [],
              },
            ],
            registered: [],
          },
        };
      }
      return { ok: false, error: "no plan in this test" };
    });
    window.pidock = { taskOp };
    try {
      resetRenderer();
      const host = createMemoryHost();
      const view = await resolveHostAdapter(host).serviceTopology("release");
      const task = await createMemoryHost().getTask("release");
      if (!task) throw Error("release task missing");
      render(<RuntimePanel task={task} topology={view} onToggleService={() => {}} />);

      const record = await screen.findByTestId("service-run-record");
      expect(record).toHaveTextContent("53101（声明端口，未实测监听）");
      expect(record).not.toHaveTextContent("5173（声明端口，未实测监听）");
      expect(record).toHaveTextContent("pid 4242");
      expect(record).not.toHaveTextContent("内存模拟记录");
    } finally {
      delete window.pidock;
    }
  });
});
