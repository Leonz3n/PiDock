import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "./helpers";

/**
 * 项目总览 ([UI 对齐 08] #32) against prototype A's `managementProjectPage()`:
 * the view label, the three stat cards, the 继续工作 task cards, the bound
 * repositories and the ordinary-directory block, plus the project-management
 * dialog's 当前项目 label and its destructive entry.
 */
describe("project overview", () => {
  it("renders the prototype's project header, stats and sections", async () => {
    renderApp("/projects/atlas");
    expect(await screen.findByRole("heading", { name: "Atlas Web", level: 1 })).toBeInTheDocument();
    // `.view-label">PROJECT<`
    const page = within(screen.getByTestId("project-overview"));
    expect(page.getByText("PROJECT")).toBeInTheDocument();
    // The page intro is the project description; the sidebar card repeats it, so
    // the assertion is scoped to the page.
    expect(page.getByText("微服务开发工作台")).toBeInTheDocument();
    // The three prototype stat cards.
    // 进行中的任务 (the sidebar repeats this label; the stat card is the page's).
    expect(page.getByText("进行中的任务").parentElement).toHaveTextContent(/[1-9]/);
    expect(page.getByText("已绑定仓库").parentElement).toHaveTextContent("4");
    expect(page.getByText("运行环境").parentElement).toHaveTextContent(/[1-9]/);
    // Entries: 项目管理 / 新建任务 (header), 管理环境 (stat card), 管理仓库 / 管理目录 (sections).
    for (const name of ["项目管理", "新建任务", "管理环境", "管理仓库", "管理目录"]) {
      expect(page.getByRole("button", { name })).toBeInTheDocument();
    }
    // 继续工作 task cards carry the task name, its repositories and its environment.
    expect(page.getByRole("heading", { name: "继续工作", level: 2 })).toBeInTheDocument();
    expect(page.getByTestId("project-task-release")).toHaveTextContent("发布前检查");
    expect(page.getByTestId("project-task-release")).toHaveTextContent("front-monorepo");
    expect(page.getByTestId("project-task-release")).toHaveTextContent("测试环境");
    // 项目仓库 lists each bound repository with its real base branch.
    expect(page.getByRole("heading", { name: "项目仓库", level: 2 })).toBeInTheDocument();
    expect(page.getByText("shipment-service")).toBeInTheDocument();
    expect(page.getByText("本机已注册 · 基线 release/2026.09")).toBeInTheDocument();
    // 普通目录 block keeps the directory entry and its task-shared warning.
    expect(page.getByRole("heading", { name: "普通目录", level: 2 })).toBeInTheDocument();
    expect(page.getByText(/通过软链接加入任务目录/)).toBeInTheDocument();
    expect(page.getByText("Atlas 设计资料")).toBeInTheDocument();
  });

  it("opens the task workspace from a 继续工作 card", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas");
    await screen.findByRole("heading", { name: "Atlas Web", level: 1 });
    await user.click(screen.getByTestId("project-task-release"));
    expect(await screen.findByRole("heading", { name: "发布前检查", level: 1 })).toBeInTheDocument();
  });

  it("labels the current project in the management dialog and keeps 切换 for the others", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas");
    await screen.findByRole("heading", { name: "Atlas Web", level: 1 });
    await user.click(screen.getByRole("button", { name: "项目管理" }));
    const dialog = await screen.findByRole("dialog", { name: "项目管理" });
    // Prototype `projectsDialog()`: the row you are on reads 当前项目, the rest 切换.
    expect(within(dialog).getByRole("button", { name: "当前项目" })).toHaveAttribute("aria-current", "true");
    expect(within(dialog).getByRole("button", { name: "切换" })).toBeInTheDocument();
    const atlasRow = within(dialog).getByText("Atlas Web").closest("div")!.parentElement!;
    expect(within(atlasRow).getByRole("button", { name: "当前项目" })).toBeInTheDocument();
    const orbitRow = within(dialog).getByText("Orbit API").closest("div")!.parentElement!;
    expect(within(orbitRow).getByRole("button", { name: "切换" })).toBeInTheDocument();
    // `.btn.danger` styling on the destructive entry.
    const remove = within(dialog).getAllByRole("button", { name: "删除" })[0];
    expect(remove.className).toContain("text-[#ad4545]");
    expect(within(dialog).getByText(/微服务开发工作台 · \d+ 个任务/)).toBeInTheDocument();
  });

  it("offers 切换 for a second project and switches to it", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas");
    await screen.findByRole("heading", { name: "Atlas Web", level: 1 });
    await user.click(screen.getByRole("button", { name: "项目管理" }));
    const dialog = await screen.findByRole("dialog", { name: "项目管理" });
    await user.click(within(dialog).getByRole("button", { name: "切换" }));
    expect(await screen.findByRole("heading", { name: "Orbit API", level: 1 })).toBeInTheDocument();
    expect(within(screen.getByTestId("project-overview")).getByText("延迟与用量排查")).toBeInTheDocument();
  });

  it("renders the 创建第一个项目 empty page when the route names a missing project", async () => {
    renderApp("/projects/missing-project");
    expect(await screen.findByRole("heading", { name: "项目", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "创建第一个项目" })).toBeInTheDocument();
    expect(screen.getByText("项目用于组织仓库、任务与运行环境。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新建项目" })).toBeInTheDocument();
    // No stray "missing" line and no project-specific sections.
    expect(screen.queryByRole("heading", { name: "继续工作" })).not.toBeInTheDocument();
  });

  it("keeps the project form's name validation visible", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas");
    await screen.findByRole("heading", { name: "Atlas Web", level: 1 });
    await user.click(screen.getByRole("button", { name: "项目管理" }));
    const dialog = await screen.findByRole("dialog", { name: "项目管理" });
    await user.click(within(dialog).getByRole("button", { name: "新建项目" }));
    const editor = await screen.findByRole("dialog", { name: "新建项目" });
    await user.type(within(editor).getByLabelText("项目名称"), "Atlas Web");
    await user.click(within(editor).getByRole("button", { name: "创建项目" }));
    // Duplicate names are refused with a readable message, and the dialog stays.
    expect(await screen.findByText("已有同名项目，请使用其他名称")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "新建项目" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Atlas Web", level: 1 })).toBeInTheDocument());
  });
});
