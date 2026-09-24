import type { ReactNode } from "react";
import { Badge, Button } from "../components/ui";
import {
  CardGrid,
  CheckRow,
  ManagementList,
  ManagementRow,
  ManagementRowText,
  Note,
  PageEmpty,
  PageIntro,
  PageTitle,
  SectionHeader,
  StatCard,
  ViewLabel,
} from "../components/Management";
import { useHostStore } from "../stores/host";
import { useNavigationStore } from "../stores/navigation";
import { useUiStore } from "../stores/ui";

/**
 * 项目总览 ([UI 对齐 08] #32). The prototype picks its shape from the project
 * itself — `managementProjectPage()` renders `directoryProjectPage()` as soon
 * as `projectDirectories().length > 0` — so both variants live here:
 *
 *   repository project (`management.js managementProjectPage()`): view label +
 *   name, 项目管理 / 新建任务, the three stat cards (进行中的任务 / 已绑定仓库 /
 *   运行环境), 继续工作 task cards carrying repos + environment badge, and the
 *   bound repositories as `check-row`s with their real base branch.
 *
 *   directory project (`directories.js directoryProjectPage()`): view label +
 *   name, 项目管理 / 新建任务, one 项目目录 list that mixes Git repositories
 *   and ordinary directories with a badge each, and 继续工作 cards that count
 *   both kinds instead of naming repositories.
 *
 * Two deliberate additions, both required by the slice's acceptance: the
 * 普通目录 entry (the prototype only ever opens it from 管理目录 in the
 * directory variant; this page owns the standalone `project-directories`
 * dialog) and real repository data (the prototype prints `本机已注册（示例）`;
 * a repository's actual base branch is what this app knows).
 *
 * Both 普通目录 entries are labelled 管理目录 in the prototype and here.
 */
export function ProjectPage({ projectId }: { projectId: string }) {
  const project = useHostStore((state) => state.workspace?.projects.find((item) => item.id === projectId));
  const workspace = useHostStore((state) => state.workspace);
  const navigate = useNavigationStore((state) => state.navigate);
  const openModal = useUiStore((state) => state.openModal);

  // Prototype `managementProjectPage()`: with no project it renders 项目 plus
  // the 创建第一个项目 empty block instead of a stray "missing" line. The
  // sidebar disables 项目总览 while no project exists ([UI 对齐 01] #25), so
  // this branch is reached when a project was removed underneath the route.
  if (!project) {
    return (
      <div data-testid="project-overview">
        <PageTitle>项目</PageTitle>
        <PageEmpty
          title="创建第一个项目"
          actions={
            <Button size="sm" variant="primary" onClick={() => openModal({ type: "project-edit" })}>
              新建项目
            </Button>
          }
        >
          项目用于组织仓库、任务与运行环境。
        </PageEmpty>
      </div>
    );
  }

  const repositories = workspace?.repositories ?? [];
  const environments = (workspace?.environments ?? []).filter((environment) => environment.projectId === project.id);
  const tasks = (workspace?.tasks ?? []).filter((task) => task.projectId === project.id);
  const activeTasks = tasks.filter((task) => !task.archived);
  const repositoryName = (id: string) => repositories.find((repository) => repository.id === id)?.name ?? id;
  const environmentName = (id: string) => environments.find((environment) => environment.id === id)?.name ?? id;

  const header = (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <ViewLabel>PROJECT</ViewLabel>
        <PageTitle>{project.name}</PageTitle>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => openModal({ type: "project-list" })}>
          项目管理
        </Button>
        <Button size="sm" variant="primary" onClick={() => openModal({ type: "new-task", projectId: project.id })}>
          新建任务
        </Button>
      </div>
    </div>
  );

  const taskCards = (emptyText: string, renderCard: (task: (typeof activeTasks)[number]) => ReactNode) => (
    <>
      <SectionHeader title="继续工作" />
      <CardGrid cols={2}>
        {activeTasks.map((task) => (
          <button
            key={task.id}
            type="button"
            data-testid={`project-task-${task.id}`}
            aria-label={task.name}
            onClick={() =>
              navigate({ view: "task", projectId: project.id, taskId: task.id, sessionId: task.activeSessionId })
            }
            className="rounded-panel border border-line bg-paper p-5 text-left hover:border-[#afb6c8]"
          >
            {renderCard(task)}
          </button>
        ))}
        {activeTasks.length === 0 ? <PageEmpty title="还没有任务">{emptyText}</PageEmpty> : null}
      </CardGrid>
    </>
  );

  if (project.directories.length > 0) {
    return (
      <div data-testid="project-overview">
        {header}
        <PageIntro>{project.description || "在项目中组织代码、资料和任务。"}</PageIntro>

        <SectionHeader
          title="项目目录"
          className="mt-0 mb-0"
          actions={
            // The prototype opens `edit-project` from this button; this app has
            // spent a delivered slice ([PiDock 18] and `directoriesFlow`) on a
            // dedicated 管理普通目录 dialog, so the directory entry keeps
            // opening that one and the project editor stays reachable from
            // 项目管理 → 编辑 with the rest of the project fields.
            <Button size="sm" onClick={() => openModal({ type: "project-directories", projectId: project.id })}>
              管理目录
            </Button>
          }
        />
        <ManagementList className="mt-4">
          {project.repositories.map((repository) => (
            <ManagementRow key={repository.id} testId={`project-repo-${repository.id}`}>
              <ManagementRowText title={repositoryName(repository.id)}>
                已注册仓库 · 创建任务时准备独立工作副本
              </ManagementRowText>
              <Badge>Git 仓库</Badge>
            </ManagementRow>
          ))}
          {project.directories.map((directory) => (
            <ManagementRow key={directory.id} testId={`project-directory-${directory.id}`}>
              <ManagementRowText title={directory.name}>
                <span className="font-mono">{directory.path}</span>
              </ManagementRowText>
              <Badge>普通目录 · 软链接接入</Badge>
            </ManagementRow>
          ))}
        </ManagementList>
        <Note>Git 仓库创建独立 worktree；普通目录通过软链接加入任务目录，修改会影响原目录。</Note>

        {taskCards("创建任务时选择本次需要的仓库和目录。", (task) => (
          <>
            <h3 className="text-[13px] font-[650] text-ink">{task.name}</h3>
            <small className="mt-[3px] block text-[11px] text-muted">
              {task.repos.length} 个 Git 仓库 · {task.directories.length} 个普通目录
            </small>
          </>
        ))}
      </div>
    );
  }

  return (
    <div data-testid="project-overview">
      {header}

      <PageIntro>{project.description || "在项目中组织仓库、任务与运行环境。"}</PageIntro>

      <CardGrid cols={3}>
        <StatCard label="进行中的任务" value={activeTasks.length} />
        <StatCard label="已绑定仓库" value={project.repositories.length} />
        <StatCard
          label="运行环境"
          value={environments.length}
          actions={
            <Button size="sm" onClick={() => openModal({ type: "environment-list", projectId: project.id })}>
              管理环境
            </Button>
          }
        />
      </CardGrid>

      {taskCards("还没有任务，先绑定仓库并创建环境。", (task) => (
        <>
          <h3 className="text-[13px] font-[650] text-ink">{task.name}</h3>
          <PageIntro className="mt-1.5 mb-0">
            {task.repos.map(repositoryName).join(" · ") || "普通目录任务"}
          </PageIntro>
          <Badge>{environmentName(task.environmentId)}</Badge>
        </>
      ))}

      <SectionHeader
        title="项目仓库"
        actions={
          <Button size="sm" onClick={() => openModal({ type: "project-edit", projectId: project.id })}>
            管理仓库
          </Button>
        }
      />
      {project.repositories.length === 0 ? (
        <PageIntro className="mt-0 mb-0">尚未绑定仓库。</PageIntro>
      ) : (
        project.repositories.map((repository) => (
          <CheckRow
            key={repository.id}
            testId={`project-repo-${repository.id}`}
            icon="folder"
            title={repository.name}
            detail={`本机已注册 · 基线 ${repository.baseBranch}`}
          />
        ))
      )}

      <SectionHeader
        title="普通目录"
        actions={
          <Button size="sm" onClick={() => openModal({ type: "project-directories", projectId: project.id })}>
            管理目录
          </Button>
        }
      />
      {project.directories.length === 0 ? (
        <PageIntro className="mt-0 mb-0">该项目没有普通目录。普通目录的原始文件在任务之间共享，不承诺隔离。</PageIntro>
      ) : (
        project.directories.map((directory) => (
          <CheckRow
            key={directory.id}
            testId={`project-directory-${directory.id}`}
            icon="folder"
            title={directory.name}
            detail={<span className="font-mono">{directory.path}</span>}
          />
        ))
      )}
      <Note>仓库创建独立 worktree；普通目录通过软链接加入任务目录，修改会影响原目录。</Note>
    </div>
  );
}
