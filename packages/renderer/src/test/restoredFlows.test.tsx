import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { renderApp } from "./helpers";
import { useDraftStore } from "../stores/drafts";
import { useHostStore } from "../stores/host";
import { sessionKeyOf } from "../data/sessionKey";

describe("runtime logs panel", () => {
  it("shows per-service lifecycle lines from in-memory data", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });

    await user.click(screen.getByRole("button", { name: "日志" }));
    const logs = await screen.findByTestId("runtime-logs");
    expect(logs).toHaveTextContent("saas-web");
    expect(logs).toHaveTextContent("listening at");
    expect(logs).toHaveTextContent("[routes]");
  });
});

describe("context dialog", () => {
  it("shows the occupancy and simulates compaction without dropping tokens", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });

    await user.click(screen.getByRole("button", { name: "查看上下文占用" }));
    const dialog = await screen.findByRole("dialog", { name: "上下文占用" });
    // [PiDock 11] #9: unformatted token numbers plus the explicit estimate
    // marker, and the attribution shows the original provider/model.
    expect(within(dialog).getByTestId("context-numbers")).toHaveTextContent("占用 24800 Tokens · 上限 200000 Tokens · 12.4%");
    expect(within(dialog).getByTestId("context-attribution")).toHaveTextContent("Anthropic 官方 / Claude Sonnet");
    expect(within(dialog).getByTestId("context-tokens")).toHaveTextContent("68.4k Tokens");

    await user.click(within(dialog).getByRole("button", { name: "模拟压缩" }));
    expect(await screen.findByText("已压缩上下文；占用标记为待更新，累计 Token 保留")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "查看上下文占用" })).toHaveTextContent("待更新");
  });
});

describe("capability detail", () => {
  it("opens a read-only detail dialog with the boundary text", async () => {
    const user = userEvent.setup();
    renderApp("/capabilities");
    await screen.findByRole("heading", { name: "能力管理" });

    // Rows are ordered by source kind (global → project → …), so target the
    // code-review card instead of assuming the first 详情 button is it.
    const card = screen.getAllByText("code-review")[0]!.closest("section")!;
    await user.click(within(card).getByRole("button", { name: "详情" }));
    const dialog = await screen.findByRole("dialog", { name: "code-review" });
    expect(within(dialog).getByText(/继续遵循会话权限/)).toBeInTheDocument();
    expect(within(dialog).getByText("项目 · .pi/skills")).toBeInTheDocument();
  });
});

describe("failed-run retry dialog", () => {
  it("refuses to retry before the prior outcome is checked", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=failed");
    const input = await screen.findByLabelText("消息输入");
    await user.type(input, "修复构建并重试");
    await user.click(screen.getByRole("button", { name: "发送消息" }));

    await user.click(await screen.findByRole("button", { name: "检查并重试" }, { timeout: 4000 }));
    const dialog = await screen.findByRole("dialog", { name: "检查重试范围" });
    await user.click(within(dialog).getByRole("button", { name: "继续" }));
    expect(await screen.findByText("请先核对上一次操作结果")).toBeInTheDocument();

    await user.selectOptions(within(dialog).getByLabelText("上一次外部操作的结果"), "not-sent");
    await user.click(within(dialog).getByRole("button", { name: "继续" }));
    expect(await screen.findByText(/仅重试失败步骤/)).toBeInTheDocument();
  });
});

describe("provider reasoning configuration", () => {
  it("syncs example model candidates and keeps a custom display name", async () => {
    const user = userEvent.setup();
    renderApp("/providers");
    await screen.findByRole("heading", { name: "Provider 与上下文" });

    await user.click(screen.getAllByRole("button", { name: "编辑" })[0]!);
    const dialog = await screen.findByRole("dialog", { name: "编辑 Provider" });

    // Syncing only refreshes candidates; it never overwrites configured models.
    await user.click(within(dialog).getByRole("button", { name: "同步模型列表" }));
    expect(await within(dialog).findByText("已同步 3 个候选")).toBeInTheDocument();
    const candidates = Array.from(document.querySelectorAll("#provider-model-candidates option")).map((option) => (option as HTMLOptionElement).value);
    expect(candidates).toEqual(["claude-sonnet-4-5", "claude-haiku-4-5", "claude-opus-4-1"]);

    // The display name follows the ID until the user edits it.
    const idInput = within(dialog).getByLabelText("模型 ID 第 1 行");
    await user.clear(idInput);
    await user.type(idInput, "claude-sonnet-4-5");
    expect(within(dialog).getByLabelText("模型显示名称 第 1 行")).toHaveValue("claude-sonnet-4-5");
    await user.clear(within(dialog).getByLabelText("模型显示名称 第 1 行"));
    await user.type(within(dialog).getByLabelText("模型显示名称 第 1 行"), "Sonnet 4.5");
    await user.click(within(dialog).getByRole("button", { name: "保存" }));

    expect(await screen.findByText("已保存 Provider 配置；凭据只保存引用，不写入共享模板与日志")).toBeInTheDocument();
    expect(await screen.findByText("Sonnet 4.5")).toBeInTheDocument();
  });

  it("lets a model declare custom reasoning levels", async () => {
    const user = userEvent.setup();
    renderApp("/providers");
    await screen.findByRole("heading", { name: "Provider 与上下文" });

    await user.click(screen.getAllByRole("button", { name: "编辑" })[0]!);
    const dialog = await screen.findByRole("dialog", { name: "编辑 Provider" });
    await user.selectOptions(within(dialog).getByLabelText("推理能力 第 1 行"), "custom");
    expect(within(dialog).getByLabelText("推理档位 1 high")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("默认推理档位 第 1 行")).toBeInTheDocument();
  });
});

describe("composer commands and candidates", () => {
  it("lists app commands, runs them, and inserts @ / $ references", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });

    const input = screen.getByLabelText("消息输入");
    await user.type(input, "/comp");
    const listbox = await screen.findByRole("listbox", { name: "输入候选" });
    expect(within(listbox).getByText("/compact")).toBeInTheDocument();
    await user.click(within(listbox).getByRole("option", { name: /\/compact/ }));
    expect(await screen.findByText("已压缩上下文；占用标记为待更新，累计 Token 保留")).toBeInTheDocument();
    expect(screen.getByLabelText("消息输入")).toHaveValue("");

    // `/skills` opens the enabled-skill list and inserts the chosen skill.
    await user.type(screen.getByLabelText("消息输入"), "/skills");
    await user.click(within(await screen.findByRole("listbox", { name: "输入候选" })).getByRole("option", { name: /\/skills/ }));
    const skills = await screen.findByRole("dialog", { name: "可用技能" });
    await user.click(within(skills).getAllByRole("button", { name: "插入对话" })[0]!);
    expect(await screen.findByText(/已把技能 .* 插入当前会话/)).toBeInTheDocument();
    // The modal records the same provenance as the `$` picker: the capability
    // id plus the resource path, not just a bare label.
    const inserted = useDraftStore.getState().drafts[sessionKeyOf("release", "main")]!.references.find((reference) => reference.kind === "skill")!;
    expect(inserted).toMatchObject({ sourceId: "cap-1", resourcePath: "skills/code-review/SKILL.md" });

    // `@` lists task files and directories; `$` lists enabled skills.
    await user.type(screen.getByLabelText("消息输入"), "@");
    const at = await screen.findByRole("listbox", { name: "输入候选" });
    await user.click(within(at).getAllByRole("option")[0]!);
    expect((await screen.findAllByText(/^引用 · /)).length).toBeGreaterThan(0);

    await user.type(screen.getByLabelText("消息输入"), "$");
    const dollar = await screen.findByRole("listbox", { name: "输入候选" });
    await user.click(within(dollar).getAllByRole("option")[0]!);
    expect((await screen.findAllByText(/code-review|tdd|diagnosing-bugs/)).length).toBeGreaterThan(0);
  });
});

describe("delivery review", () => {
  it("reviews repositories and keeps the commit step explicit", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });

    await user.click(screen.getByRole("button", { name: "审阅与交付" }));
    const dialog = await screen.findByRole("dialog", { name: "审阅与交付" });
    expect(within(dialog).getByText("front-monorepo")).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("提交说明"), "修复对账字段");
    await user.click(within(dialog).getByRole("button", { name: "查看提交面板示意" }));

    const commit = await screen.findByRole("dialog", { name: "提交变更" });
    expect(within(commit).getByText(/修复对账字段/)).toBeInTheDocument();
    await user.click(within(commit).getByRole("button", { name: "确认提交草稿" }));
    expect(await screen.findByText(/此原型不连接 Git，未提交任何变更/)).toBeInTheDocument();
  });
});

describe("machine-local repository binding", () => {
  it("validates and saves local checkout paths", async () => {
    const user = userEvent.setup();
    renderApp("/settings");
    await screen.findByRole("heading", { name: "本机设置" });

    await user.click(screen.getByRole("button", { name: "编辑绑定" }));
    const dialog = await screen.findByRole("dialog", { name: "本机仓库绑定" });
    const field = within(dialog).getByLabelText("apis 本机路径");
    await user.type(field, "relative/path");
    await user.click(within(dialog).getByRole("button", { name: "保存绑定" }));
    expect(await screen.findByText("请填写完整的本机路径")).toBeInTheDocument();

    await user.clear(field);
    await user.type(field, "/Users/name/Workspace/apis");
    await user.click(within(dialog).getByRole("button", { name: "保存绑定" }));
    expect(await screen.findByText(/已保存本机仓库路径/)).toBeInTheDocument();
  });
});

describe("remote access settings", () => {
  it("switches entry modes, shows the device permission defaults and previews the mobile view", async () => {
    const user = userEvent.setup();
    renderApp("/remote");
    await screen.findByRole("heading", { name: "远程访问" });

    // The entry the Host reported: a loopback listener, not a public port.
    expect(screen.getByText("127.0.0.1:4318")).toBeInTheDocument();
    expect(screen.getByText(/https:\/\/pidock-host.tailnet.ts.net/)).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Funnel 公网入口" }));
    // Both the hint and the standing risk warning mention public reachability;
    // the warning is the mode specific one.
    expect(screen.getByText(/网络可达不等于通过认证/)).toBeInTheDocument();
    expect(screen.getByText("实验入口")).toBeInTheDocument();
    // Switching the route drops the live Gateway connection instead of reusing it.
    expect(useHostStore.getState().workspace?.remoteEntry.gateway.status).toBe("offline");

    // File and terminal stay off by default; the toggle lives on the device, not
    // in the page: the page only states the default.
    expect(screen.getByText(/查看文件和差异/)).toBeInTheDocument();
    // Every non-default permission says so; manage, files and terminal all ask
    // again per action.
    expect(screen.getAllByText(/默认关闭 · 每次操作再次确认/).length).toBe(3);
    expect(screen.getByText(/高风险 · 默认关闭/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "手机视图" }));
    const preview = await screen.findByRole("dialog", { name: "手机视图预览" });
    expect(within(preview).getByText("最近任务")).toBeInTheDocument();
  });
});

describe("read-only session guard", () => {
  it("blocks service start/stop and dependency switching until the tier changes", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });

    await user.click(screen.getByRole("button", { name: /^选择权限：默认权限$/ }));
    const dialog = await screen.findByRole("dialog", { name: "会话权限" });
    await user.click(within(dialog).getByRole("button", { name: /只读/ }));
    expect(await screen.findByRole("button", { name: /^选择权限：只读$/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "运行" }));
    await user.click(screen.getAllByRole("button", { name: /^(启动|停止)$/ })[0]!);
    expect(await screen.findByText("当前是只读会话，请先调整会话权限")).toBeInTheDocument();

    // Switching dependency target is allowed once the session leaves read-only.
    await user.click(screen.getByRole("button", { name: /^选择权限：只读$/ }));
    const reopen = await screen.findByRole("dialog", { name: "会话权限" });
    await user.click(within(reopen).getByRole("button", { name: /默认权限/ }));
    await user.click(await screen.findByRole("button", { name: /^切换 saas-web 依赖去向$/ }));
    expect(await screen.findByText("依赖去向已模拟重新解析")).toBeInTheDocument();
  });
});

describe("composer attachments", () => {
  it("adds and removes file attachments", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });

    const picker = screen.getByLabelText("附件选择") as HTMLInputElement;
    await user.upload(picker, new File(["hello"], "notes.txt", { type: "text/plain" }));
    const attachments = await screen.findByTestId("composer-attachments");
    expect(within(attachments).getByText("notes.txt")).toBeInTheDocument();

    await user.click(within(attachments).getByRole("button", { name: "移除附件 notes.txt" }));
    await waitFor(() => expect(screen.queryByTestId("composer-attachments")).not.toBeInTheDocument());
  });

  it("keeps the attachment on the sent message", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });

    await user.upload(screen.getByLabelText("附件选择") as HTMLInputElement, new File(["hello"], "spec.md", { type: "text/markdown" }));
    await user.type(screen.getByLabelText("消息输入"), "看下附件");
    await user.click(screen.getByRole("button", { name: "发送消息" }));

    const conversation = await screen.findByLabelText("会话消息");
    expect(await within(conversation).findByText("引用 · spec.md")).toBeInTheDocument();
  });

  it("blocks sending an image when the selected model declares no image input", async () => {
    vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:mock" });
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });

    // Claude Haiku declares no image support.
    await user.click(screen.getByRole("button", { name: /^选择模型：Claude Sonnet$/ }));
    const modelDialog = await screen.findByRole("dialog", { name: "选择 Provider 与模型" });
    await user.click(within(modelDialog).getByRole("button", { name: "模型 Claude Haiku" }));

    await user.upload(screen.getByLabelText("附件选择") as HTMLInputElement, new File(["x"], "shot.png", { type: "image/png" }));
    expect(await screen.findByText(/当前模型未启用图片输入/)).toBeInTheDocument();
    await user.type(screen.getByLabelText("消息输入"), "看图");
    expect(screen.getByRole("button", { name: "发送消息" })).toBeDisabled();
    vi.unstubAllGlobals();
  });
});

describe("scheduled task creation", () => {
  it("creates a scheduled task with cadence, model and prompt", async () => {
    const user = userEvent.setup();
    renderApp("/schedules");
    await screen.findByRole("heading", { name: "定时任务" });

    await user.click(screen.getByRole("button", { name: "新建定时任务" }));
    const dialog = await screen.findByRole("dialog", { name: "新建任务" });
    await user.click(within(dialog).getByLabelText("定时任务"));
    const name = within(dialog).getByLabelText("任务名称");
    await user.clear(name);
    await user.type(name, "每日巡检");
    await user.type(within(dialog).getByLabelText("执行周期"), "每日 08:00");
    await user.type(within(dialog).getByLabelText("定时任务提示词"), "检查昨日错误");
    // [PiDock 02] P1-1/P1-3: creation pins the remote baseline first.
    await user.type(within(dialog).getByLabelText("远程基线分支"), "origin/main");
    await user.type(within(dialog).getByLabelText("基线提交"), "9acb5b6");
    await user.click(within(dialog).getByRole("button", { name: "创建任务" }));

    expect(await screen.findByText("已创建定时任务；每次触发新建独立会话")).toBeInTheDocument();
    // The new task page shows the placeholder session until the first trigger.
    expect(await screen.findByText("等待首次执行")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "定时任务" }));
    await screen.findByRole("heading", { name: "定时任务" });
    expect(await screen.findByText(/每日 08:00/)).toBeInTheDocument();
  });
});

describe("subagent sidebar", () => {
  it("shows the session's child agents, opens the read-only panel, and resets per session", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });

    const list = await screen.findByLabelText("当前会话启动的 Subagent");
    expect(within(list).getByText("查询链路分析")).toBeInTheDocument();
    expect(within(list).getByText("前端字段检查")).toBeInTheDocument();

    await user.click(within(list).getByText("查询链路分析"));
    const sidebar = await screen.findByTestId("subagent-sidebar");
    expect(within(sidebar).getByText(/梳理对账单详情查询链路/)).toBeInTheDocument();
    expect(within(sidebar).getByText(/只读分析/)).toBeInTheDocument();

    // Switching to a session with no child records hides the list and panel.
    await user.click(screen.getByRole("button", { name: /部署审查/ }));
    await waitFor(() => expect(screen.queryByLabelText("当前会话启动的 Subagent")).not.toBeInTheDocument());
    expect(screen.queryByTestId("subagent-sidebar")).not.toBeInTheDocument();
  });
});
