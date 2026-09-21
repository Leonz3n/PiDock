import { Badge, Button, EmptyState, Panel, Segmented } from "../components/ui";
import { attentionKindLabel } from "./runState";
import { useHostStore } from "../stores/host";
import { useNavigationStore } from "../stores/navigation";
import { useUiStore } from "../stores/ui";

const filters = [
  { value: "all", label: "全部" },
  { value: "approval", label: attentionKindLabel("approval") },
  { value: "failed", label: attentionKindLabel("failed") },
  { value: "expired", label: attentionKindLabel("expired") },
  { value: "completed-unread", label: attentionKindLabel("completed-unread") },
] as const;

export function AttentionPage() {
  const attention = useHostStore((state) => state.attention);
  const filter = useUiStore((state) => state.attentionFilter);
  const setFilter = useUiStore((state) => state.setAttentionFilter);
  const navigate = useNavigationStore((state) => state.navigate);
  const items = attention.filter((item) => filter === "all" || item.kind === filter);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-base font-medium text-ink">需要处理</h1>
          <p className="mt-1 text-xs text-muted">
            汇总所有项目的待确认、失败、过期与完成未读，可直接定位原任务与会话。查看完成结果会清除未读；失败与待确认须处理后移除。
          </p>
        </div>
        <Segmented ariaLabel="按类型过滤" value={filter} onChange={setFilter} options={[...filters]} />
      </header>

      {items.length === 0 ? (
        <EmptyState>当前没有需要处理的事项。</EmptyState>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((item) => (
            <li key={item.id}>
              <Panel>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <Badge tone={item.kind === "approval" ? "warn" : item.kind === "failed" ? "warn" : "accent"}>{attentionKindLabel(item.kind)}</Badge>
                      <span className="text-sm text-ink">{item.label}</span>
                    </div>
                    <p className="mt-1 text-xs text-muted">{item.detail}</p>
                  </div>
                  <Button
                    size="sm"
                    onClick={() => navigate({ view: "task", projectId: item.projectId, taskId: item.taskId, sessionId: item.sessionId })}
                  >
                    定位会话
                  </Button>
                </div>
              </Panel>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
