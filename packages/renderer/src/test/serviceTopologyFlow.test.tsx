import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "./helpers";

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
    expect(record).toHaveTextContent("5173");
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
    expect(failure).toHaveTextContent("端口 9002 已被任务实例 release/invoice-service@9002 占用");
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
});
