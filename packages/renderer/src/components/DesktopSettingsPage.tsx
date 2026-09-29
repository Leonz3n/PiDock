import { Icon } from "./Icon";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

/** Production settings structure; the current Host exposes no authoritative settings read/write API. */
export function DesktopSettingsPage() {
  return <div data-testid="desktop-settings-page" className="px-[34px] py-[30px] below-narrow:px-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><p className="text-[10px] uppercase tracking-[1.8px] text-[#95979c]">Local Settings</p><h1 className="mt-1.5 text-[26px] font-semibold text-ink">本机设置</h1></div>
      <Badge variant="soft">未接线</Badge>
    </div>
    <div className="mt-6 max-w-[620px] space-y-6">
      <section className="border-t border-line pt-5" aria-label="应用配置目录">
        <h2 className="text-sm font-semibold text-ink">应用配置目录</h2>
        <p className="mt-2 text-xs text-muted">Host 尚未提供权威配置路径。这里不展示原型中的示意路径。</p>
        <div className="mt-3 flex min-h-10 items-center border border-line bg-paper px-3 text-xs text-muted">未接线</div>
      </section>
      <section className="border-t border-line pt-5" aria-label="默认任务根目录">
        <h2 className="text-sm font-semibold text-ink">默认任务根目录</h2>
        <p className="mt-2 text-xs text-muted">此设置仅影响后续创建的任务；已有任务不会迁移。当前 Host 尚未提供该设置的读取、目录校验或保存操作。</p>
        <div className="mt-3 flex flex-wrap gap-2"><input aria-label="默认任务根目录" disabled placeholder="默认任务根目录未接线" className="min-h-9 min-w-0 flex-1 rounded-[4px] border border-line bg-paper px-3 text-xs text-muted disabled:opacity-70" /><Button type="button" variant="outline" disabled title="Host 尚无默认任务根选择接口"><Icon name="folder" />选择目录</Button></div>
      </section>
      <div className="flex justify-end border-t border-line pt-5"><Button type="button" disabled title="Host 尚无本机设置保存接口">保存设置</Button></div>
    </div>
  </div>;
}
