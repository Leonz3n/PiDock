import { useCallback, useEffect, useState } from "react";
import { Icon } from "./Icon";
import { desktopMode, importDesktopTaskRoot, listDesktopTasks, type DesktopTaskInventory } from "../data/desktopInventory";

export { desktopMode };

type InventoryState = { kind: "loading" | "error" | "ready"; inventory: DesktopTaskInventory; error?: string };
const empty: DesktopTaskInventory = { tasks: [], roots: [] };

export function DesktopInventory() {
  const [state, setState] = useState<InventoryState>({ kind: "loading", inventory: empty });
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setState({ kind: "loading", inventory: empty });
    try {
      const inventory = await listDesktopTasks(window.pidock ?? {});
      setState({ kind: "ready", inventory });
    } catch (error) {
      setState({ kind: "error", inventory: empty, error: error instanceof Error ? error.message : "任务记录读取失败" });
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const importRoot = async () => {
    setImporting(true);
    setImportError(null);
    try {
      if (await importDesktopTaskRoot(window.pidock ?? {})) await load();
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "任务根导入失败");
    } finally { setImporting(false); }
  };

  return (
    <main className="min-h-screen bg-bg text-ink" data-testid="desktop-inventory">
      <header className="border-b border-line bg-paper px-6 py-4 text-sm font-semibold">PiDock <span className="ml-3 text-xs font-normal text-muted">本机任务</span></header>
      <div className="mx-auto w-full max-w-[980px] px-5 py-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold">任务工作区</h1>
          <button type="button" className="inline-flex items-center gap-2 border border-line bg-paper px-3 py-1.5 text-sm disabled:opacity-50" disabled={importing} onClick={() => void importRoot()}><Icon name="folder" />找回其他位置的任务</button>
        </div>
        {importError ? <p className="mt-4 text-sm text-[#ad4545]" role="alert">{importError}</p> : null}
        {state.kind === "loading" ? <p className="mt-6 text-sm text-muted" role="status">正在读取本机任务</p> : null}
        {state.kind === "error" ? (
          <div className="mt-6 border border-line bg-paper p-5" role="alert">
            <p className="text-sm">{state.error}</p>
            <button type="button" className="mt-4 border border-line bg-paper px-3 py-1.5 text-sm" onClick={() => void load()}>重试</button>
          </div>
        ) : null}
        {state.kind === "ready" ? (
          <>
            {state.inventory.roots.filter((root) => root.state === "error").map((root) => <p key={root.label} className="mt-4 text-sm text-[#ad4545]" role="alert">{root.label}：{root.message}</p>)}
            {state.inventory.tasks.length === 0 ? <p className="mt-6 text-sm text-muted">已检查的任务根暂无可读取的任务</p> : (
              <ul className="mt-6 divide-y divide-line border-y border-line">
                {state.inventory.tasks.map((task) => (
                  <li className="grid gap-2 py-4 text-sm sm:grid-cols-[minmax(0,1fr)_auto]" key={task.taskId}>
                    <div className="min-w-0"><strong className="block truncate font-medium">{task.name}</strong><span className="text-xs text-muted">{task.taskId} · {task.branch}</span></div>
                    <span className="text-xs text-muted">{task.repoCount} 个仓库 · {task.updatedAt}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-6 text-xs text-muted">仅列出默认任务根及已登记的其他任务根；未知位置的既有任务需明确选择目录找回。项目映射尚未建立；创建任务、对话和管理操作尚未接入真实数据源。</p>
          </>
        ) : null}
      </div>
    </main>
  );
}
