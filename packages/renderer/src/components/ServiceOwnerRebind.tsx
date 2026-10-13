import { useRef, useState } from "react";
import { rebindTaskServiceOwnerThroughShell } from "../data/taskServices";
import type { ServiceOwnerRebindView } from "../data/serviceCatalog";
import { Button } from "./ui/button";

/**
 * The way back from a task whose service control was revoked ([PiDock 04] #7
 * slice). A shared-template adoption, a binding change or a project
 * re-association moves the task's execution snapshot, and main then fences the
 * task's service owner: the Host refuses start/stop with
 * `service-owner-inventory-unconfirmed` until the task's owner binding is
 * replaced at the new revision.
 *
 * Two steps, like the catalog writes: the first click only asks main what it
 * really observes (`state`, plus the named services whose owner contract
 * changes), and only the confirmed click replaces the fenced binding. The
 * control never claims a restart: re-binding replaces ownership only, so a
 * running service process keeps running the revision it was started with and
 * nothing is started, stopped or restarted by either step. A refusal (for
 * example `service-owner-rebind-blocked:<ids>`, a durable owner state main will
 * not silently drop) is shown verbatim and the panel stays on the review, so
 * the previous state remains diagnosable instead of half-torn-down.
 */
export function ServiceOwnerRebind({ projectId, taskId, surfacedBy, onRebound, onDismiss }: {
  projectId: string;
  taskId: string;
  /** The refusal (or write consequence) that surfaced this control, shown verbatim. */
  surfacedBy?: string;
  onRebound?: () => void;
  /** Called when the user closes a finished control, so the host panel can drop it. */
  onDismiss?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<ServiceOwnerRebindView | null>(null);
  const [done, setDone] = useState<ServiceOwnerRebindView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const epoch = useRef(0);

  const request = async (confirm: boolean) => {
    const token = ++epoch.current;
    setBusy(true); setError(null);
    const result = await rebindTaskServiceOwnerThroughShell({ projectId, taskId, confirm });
    if (epoch.current !== token) return;
    setBusy(false);
    if (!result.ok) { setError(result.error); return; }
    // A confirmed request may only be read as "control is back" when main's own
    // re-observation says so. A re-bind that replaced nothing, or one after which
    // main still reports the task fenced (a retired owner message can re-fence the
    // replacement), is shown as what it is instead of a recovered channel.
    if (confirm && (!result.view.rebound || result.view.state !== "current")) {
      setReview(null); setDone(result.view);
      setError(!result.view.rebound
        ? "主进程报告该任务的所有者绑定已是最新，未做替换；若启停仍被拒绝，请刷新后重试"
        : "主进程报告已替换所有者绑定，但重新核对后该任务仍被隔离；启停通道可能尚未恢复，请刷新后重试");
      return;
    }
    if (confirm) {
      setDone(result.view); setReview(null);
      onRebound?.();
      return;
    }
    setDone(null);
    setReview(result.view);
  };

  return <div className="mt-2 border border-line bg-soft px-2 py-2 text-xs" data-testid="service-owner-rebind">
    {done === null && <p className="break-words text-muted" role="status">该任务的启停通道已被撤销：宿主持有的服务所有者绑定与当前目录不一致（配方变更、绑定变更、项目归属变更，或所有者消息无法核对），在重新绑定该任务的服务所有者之前会拒绝启停（<code>service-owner-inventory-unconfirmed</code>）。{surfacedBy && surfacedBy.length > 0 ? `宿主原文：${surfacedBy}` : ""}</p>}
    {review === null && done === null && <div className="mt-2 flex flex-wrap items-center gap-2">
      <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void request(false)}>核对重新绑定</Button>
      <span className="break-words text-muted">核对不会改动任何绑定；重新绑定只替换该任务的服务所有者绑定与租约，不启动、停止或重启任何进程。</span>
    </div>}
    {error && <p role="alert" className="mt-2 break-words text-[#ad4545]">{error}</p>}
    {review && <div className="mt-2">
      <div role="status">
        {review.state === "fenced"
          ? <p>待重新绑定：该任务的服务所有者绑定与当前目录不一致，重新绑定后启停通道恢复（正在运行的服务进程继续运行启动时的版本，需要新版本请在运行面板重新启动）。</p>
          : <p>当前无需重新绑定：主进程报告该任务{review.state === "absent" ? "尚未派生宿主（下次启动会直接使用当前版本）" : "的所有者绑定已是最新"}。</p>}
        {review.state === "fenced" && (review.changes.length > 0
          ? <ul className="mt-1 list-disc pl-4">{review.changes.map((row) => <li key={row.serviceId} className="break-words">本次重新绑定影响 {row.name}：{row.was === null ? `新增绑定 v${String(row.now)}` : row.now === null ? `不再绑定（原 v${String(row.was)}）` : row.was === row.now ? `绑定 v${String(row.now)}（版本未变，但本机程序、环境或目录等运行材料已变化）` : `绑定 v${row.was} → v${row.now}`}</li>)}</ul>
          : <p className="mt-1 text-muted">未发现服务版本变化：差异可能来自本机程序、环境或项目归属；重新绑定仍会按当前目录重建所有者绑定。</p>)}
        <p className="mt-1 text-muted">重新绑定不停止、不重启任何进程，也不改写共享模板或本机路径。</p>
      </div>
      <div className="mt-2 flex flex-wrap justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setReview(null)}>取消</Button>
        {review.state === "fenced" && <Button type="button" size="sm" disabled={busy} onClick={() => void request(true)}>确认重新绑定</Button>}
      </div>
    </div>}
    {done && <div className="mt-2">
      <p role="status" className="break-words">{done.rebound && done.state === "current"
        ? "已重新绑定该任务的服务所有者：启停通道已恢复，可以在运行面板重新启停；本次没有启动、停止或重启任何进程。"
        : done.rebound
          ? "主进程已替换该任务的服务所有者，但重新核对后仍报告该任务被隔离；启停通道尚未确认恢复。"
          : "主进程未做替换：该任务没有可重新绑定的派生宿主或所有者绑定已是最新。"}</p>
      <div className="mt-2 flex justify-end gap-2"><Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => { setDone(null); setError(null); onDismiss?.(); }}>关闭</Button></div>
    </div>}
  </div>;
}
