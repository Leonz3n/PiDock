import { Icon } from "./Icon";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

interface Project { id: string; name: string }

/** Prototype-A layout with only authoritative Project context; no environment model is exposed by Host yet. */
export function DesktopEnvironmentPage({ projects, projectId, taskCount, onSelectProject }: {
  projects: readonly Project[];
  projectId: string | null;
  taskCount: number;
  onSelectProject: (id: string) => void;
}) {
  return <div data-testid="desktop-environment-page" className="px-[34px] py-[30px] below-narrow:px-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0"><p className="text-[10px] uppercase tracking-[1.8px] text-[#95979c]">Environments</p><h1 className="mt-1.5 text-[26px] font-semibold text-ink">环境与服务</h1></div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" disabled title="Host 尚无项目环境管理接口">管理环境</Button>
        <Button type="button" disabled title="Host 尚无项目环境创建接口"><Icon name="plus" />新增环境</Button>
      </div>
    </div>
    <p className="mt-1.5 text-xs text-muted">继续使用仓库默认配置，通过环境变量调整服务运行方式。配置与服务状态必须以真实 Host 为准。</p>
    <div className="mt-6 flex flex-wrap items-center gap-2">
      <label htmlFor="desktop-env-project" className="text-xs text-muted">项目</label>
      <select id="desktop-env-project" className="min-h-8 max-w-full rounded-[4px] border border-line bg-paper px-2 text-xs text-ink" value={projectId ?? ""} disabled={!projects.length} onChange={(event) => onSelectProject(event.target.value)}>
        {!projects.length && <option value="">尚无项目</option>}
        {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
      </select>
      <span className="text-[11px] text-muted">{projectId ? `关联任务 ${taskCount}` : "尚无项目上下文"}</span>
    </div>
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <label className="text-xs text-muted">环境</label>
      <select aria-label="环境" disabled value="unwired" className="min-h-8 max-w-full rounded-[4px] border border-line bg-paper px-2 text-xs text-muted"><option value="unwired">环境清单未接线</option></select>
      <Badge variant="soft">模板版本 · 未接线</Badge>
    </div>
    <div className="mt-5 flex flex-wrap gap-1 border-b border-line pb-2" role="group" aria-label="配置作用范围">
      {(["任务覆盖", "共享模板", "本机私有配置"] as const).map((scope) => <Button key={scope} type="button" variant="ghost" size="sm" disabled title={`${scope}的生产数据未接线`}>{scope}</Button>)}
    </div>
    <section className="mt-5" aria-label="环境变量">
      <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-semibold">环境变量 <Badge variant="soft" className="ml-1">未接线</Badge></h2><Button type="button" size="sm" disabled title="缺少真实配置及变更预览">保存更改</Button></div>
      <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[320px] text-left text-xs"><thead className="border-b border-line text-muted"><tr><th className="py-2 font-medium">KEY</th><th className="py-2 font-medium">VALUE</th><th className="py-2 font-medium">生效来源</th></tr></thead><tbody><tr className="border-b border-line"><td colSpan={3} className="py-5 text-muted">Host 尚未提供项目环境、任务覆盖与敏感值遮蔽后的生效配置。这里不展示示例 KEY 或 VALUE。</td></tr></tbody></table></div>
    </section>
    <section className="mt-8" aria-label="服务启动配方">
      <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-semibold">服务启动配方 <Badge variant="soft" className="ml-1">未接线</Badge></h2><Button type="button" size="sm" variant="outline" disabled title="Host 尚无项目服务配方清单"><Icon name="plus" />添加服务</Button></div>
      <p className="mt-3 border-t border-line py-5 text-xs text-muted">Host 尚未提供该环境的服务配方或本任务服务清单；运行记录不能代表当前可启动的服务。</p>
    </section>
  </div>;
}
