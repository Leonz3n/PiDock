import { Badge, Button, EmptyState, Panel, Segmented } from "../components/ui";
import { attentionKindLabel } from "./runState";
import { attentionClearsOnRead, groupAttentionItems } from "../data/attentionRules";
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
  const markAttentionRead = useHostStore((state) => state.markAttentionRead);
  const filter = useUiStore((state) => state.attentionFilter);
  const setFilter = useUiStore((state) => state.setAttentionFilter);
  const pushToast = useUiStore((state) => state.pushToast);
  const navigate = useNavigationStore((state) => state.navigate);
  const filtered = attention.filter((item) => filter === "all" || item.kind === filter);
  const groups = groupAttentionItems(filtered);
  // 盒子 5: 待处理 (待确认/失败/过期) and 完成未读 are the two groups the list shows.
  const sections =
    filter === "completed-unread"
      ? [{ key: "unread", title: "完成未读", items: groups.unread }]
      : filter === "all"
        ? [
            { key: "pending", title: "待处理", items: groups.pending },
            { key: "unread", title: "完成未读", items: groups.unread },
          ]
        : [{ key: filter, title: attentionKindLabel(filter), items: filtered }];

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

      {filtered.length === 0 ? (
        <EmptyState>当前没有需要处理的事项。</EmptyState>
      ) : (
        sections
          .filter((section) => section.items.length > 0)
          .map((section) => (
            <section key={section.key} className="flex flex-col gap-2">
              <h2 className="text-xs font-medium text-muted">{section.title}</h2>
              <ul className="flex flex-col gap-2">
                {section.items.map((item) => (
                  <li key={item.id}>
                    <Panel>
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <div className="flex items-center gap-2">
                            <Badge tone={item.kind === "approval" ? "warn" : item.kind === "failed" ? "warn" : "accent"}>
                              {attentionKindLabel(item.kind)}
                            </Badge>
                            <span className="text-sm text-ink">{item.label}</span>
                          </div>
                          <p className="mt-1 text-xs text-muted">{item.detail}</p>
                        </div>
                        <Button
                          size="sm"
                          onClick={() => {
                            navigate({ view: "task", projectId: item.projectId, taskId: item.taskId, sessionId: item.sessionId });
                            // 读取完成清除未读: locating a completed result reads it, so
                            // the unread mark clears. A 待处理 item must be handled
                            // instead (the Host keeps it and the toast says so).
                            if (!attentionClearsOnRead(item.kind)) return;
                            void markAttentionRead(item.taskId, [item.id]).then((result) => {
                              if (result.cleared.length > 0) pushToast("已读取完成结果，未读标记已清除");
                              else if (result.kept.length > 0) pushToast("该项需处理后才会移除");
                            });
                          }}
                        >
                          定位会话
                        </Button>
                      </div>
                    </Panel>
                  </li>
                ))}
              </ul>
            </section>
          ))
      )}
    </div>
  );
}
