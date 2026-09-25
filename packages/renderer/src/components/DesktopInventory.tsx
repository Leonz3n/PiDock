import { useCallback, useEffect, useState } from "react";
import { desktopMode, listDesktopTasks, type DesktopTaskSummary } from "../data/desktopInventory";

export { desktopMode };

export function DesktopInventory() {
  const [state, setState] = useState<{ kind: "loading" | "error" | "ready"; tasks: DesktopTaskSummary[]; error?: string }>({ kind: "loading", tasks: [] });
  const load = useCallback(async () => {
    setState({ kind: "loading", tasks: [] });
    try {
      const tasks = await listDesktopTasks(window.pidock ?? {});
      setState({ kind: "ready", tasks });
    } catch (error) {
      setState({ kind: "error", tasks: [], error: error instanceof Error ? error.message : "任务记录读取失败" });
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  return (
    <main className="min-h-screen bg-bg text-ink" data-testid="desktop-inventory">
      <header className="border-b border-line bg-paper px-6 py-4 text-sm font-semibold">PiDock <span className="ml-3 text-xs font-normal text-muted">本机任务</span></header>
      <div className="mx-auto w-full max-w-[980px] px-5 py-8">
        <h1 className="text-xl font-semibold">任务工作区</h1>
        {state.kind === "loading" ? <p className="mt-6 text-sm text-muted" role="status">正在读取本机任务</p> : null}
        {state.kind === "error" ? (
          <div className="mt-6 border border-line bg-paper p-5" role="alert">
            <p className="text-sm">{state.error}</p>
            <button type="button" className="mt-4 border border-line bg-paper px-3 py-1.5 text-sm" onClick={() => void load()}>重试</button>
          </div>
        ) : null}
        {state.kind === "ready" ? (
          <>
            {state.tasks.length === 0 ? <p className="mt-6 text-sm text-muted">默认任务根暂无已登记的任务</p> : (
              <ul className="mt-6 divide-y divide-line border-y border-line">
                {state.tasks.map((task) => (
                  <li className="grid gap-2 py-4 text-sm sm:grid-cols-[minmax(0,1fr)_auto]" key={task.taskId}>
                    <div className="min-w-0"><strong className="block truncate font-medium">{task.name}</strong><span className="text-xs text-muted">{task.taskId} · {task.branch}</span></div>
                    <span className="text-xs text-muted">{task.repoCount} 个仓库 · {task.updatedAt}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-6 text-xs text-muted">只显示默认任务根内的任务；其他位置的既有任务尚不能自动发现。项目映射尚未建立；创建任务、对话和管理操作尚未接入真实数据源。</p>
          </>
        ) : null}
      </div>
    </main>
  );
}
