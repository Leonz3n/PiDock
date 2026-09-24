import { Badge, Button } from "../components/ui";
import { CardGrid, CheckRow, Note, PageEmpty, PageIntro, PageTitle, SectionHeader, StatCard, ViewLabel } from "../components/Management";
import { useHostStore } from "../stores/host";
import { useNavigationStore } from "../stores/navigation";
import { useUiStore } from "../stores/ui";

/**
 * 项目总览 ([UI 对齐 08] #32), the prototype's `managementProjectPage()`
 * (`prototypes/pidock-ui/management.js`): view label + project name, the two
 * header entries (项目管理 / 新建任务), three stat cards (进行中的任务 /
 * 已绑定仓库 / 运行环境), the 继续工作 task cards and the bound repositories.
 *
 * Two deliberate additions to the prototype's markup, both required by the
 * slice's acceptance: the 普通目录 block (the prototype only lists ordinary
 * directories in its directory-project variant, and this page owns the
 * `project-directories` entry) and real repository data (the prototype prints
 * `本机已注册（示例）`; a repository's actual base branch is what this app
 * knows).
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

  return (
    <div data-testid="project-overview">
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

      <SectionHeader title="继续工作" className="mt-4 mb-4" />
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
            <h3 className="text-[13px] font-[650] text-ink">{task.name}</h3>
            <PageIntro>
              {task.repos.map(repositoryName).join(" · ") || "普通目录任务"}
            </PageIntro>
            <Badge>{environmentName(task.environmentId)}</Badge>
          </button>
        ))}
        {activeTasks.length === 0 ? <PageEmpty title="还没有任务">还没有任务，先绑定仓库并创建环境。</PageEmpty> : null}
      </CardGrid>

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
