import { Badge, Button, Panel } from "../components/ui";
import { useHostStore } from "../stores/host";
import { useUiStore } from "../stores/ui";

export function ProvidersPage() {
  const workspace = useHostStore((state) => state.workspace);
  const providers = workspace?.providers ?? [];
  const openModal = useUiStore((state) => state.openModal);
  const removeProvider = useHostStore((state) => state.removeProvider);
  const pushToast = useUiStore((state) => state.pushToast);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-base font-medium text-ink">Provider 与上下文</h1>
          <p className="mt-1 text-xs text-muted">
            同一供应商可以保存多个独立配置；会话选择其中一个配置及其模型，上下文占用与 Token 消耗分开记录。
          </p>
        </div>
        <Button size="sm" variant="primary" onClick={() => openModal({ type: "provider-edit" })}>
          添加 Provider
        </Button>
      </header>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {providers.map((provider) => (
          <Panel
            key={provider.id}
            title={provider.name}
            actions={
              <div className="flex items-center gap-1.5">
                <Badge tone={provider.enabled ? "accent" : "neutral"}>{provider.enabled ? "已启用" : "已停用"}</Badge>
                <Badge>{provider.protocol}</Badge>
              </div>
            }
          >
            <p className="font-mono text-[11px] text-muted">{provider.baseUrl}</p>
            <table className="mt-3 w-full text-xs">
              <thead className="text-left text-muted">
                <tr>
                  <th className="pb-1.5">模型</th>
                  <th className="pb-1.5">上下文窗口</th>
                  <th className="pb-1.5">状态</th>
                </tr>
              </thead>
              <tbody>
                {provider.models.map((model) => (
                  <tr key={model.id} className="border-t border-line">
                    <td className="py-1.5">
                      {model.name ?? model.id}
                      {model.name ? <small className="ml-1.5 text-muted">{model.id}</small> : null}
                    </td>
                    <td className="py-1.5">{model.contextWindow}k</td>
                    <td className="py-1.5 text-muted">{model.contextWindow >= 100 ? "可切换" : "上下文不足时置灰"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" onClick={() => openModal({ type: "provider-edit", providerId: provider.id })}>
                编辑
              </Button>
              <Button size="sm" onClick={() => pushToast("已同步模型列表（示例候选，未调用真实发现接口）")}>
                同步模型列表
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  void removeProvider(provider.id);
                  pushToast("已移除 Provider（内存模拟）；引用它的会话回退到其他 Provider");
                }}
              >
                删除
              </Button>
              <Button size="sm" variant="ghost" onClick={() => pushToast("凭据引用保存在本机私有配置，不写入共享模板")}>
                查看凭据引用
              </Button>
            </div>
          </Panel>
        ))}
      </div>

      <Panel title="上下文与压缩规则">
        <ul className="flex list-disc flex-col gap-1.5 pl-4 text-xs text-muted">
          <li>上下文超过目标模型窗口时禁止切换，候选置灰并说明原因。</li>
          <li>上下文压缩或切换模型不清零已有 Token 消耗，只改变后续请求占用。</li>
          <li>推理档位跟随模型配置；当前模型未接入时不会虚构可选档位。</li>
        </ul>
      </Panel>
    </div>
  );
}
