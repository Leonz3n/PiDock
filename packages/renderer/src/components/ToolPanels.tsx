import { useState } from "react";
import { Badge, Button, EmptyState, Panel } from "./ui";
import { CodeBlock } from "./CodeBlock";
import { ConfigTable } from "./ConfigTable";
import type { BrowserPage, Service, Task, WorkspaceFile } from "../data/types";
import { useHostStore } from "../stores/host";

export function RuntimePanel({
  task,
  onToggleService,
}: {
  task: Task;
  onToggleService: (serviceId: string, running: boolean) => void;
}) {
  const [selected, setSelected] = useState<string | undefined>(task.services[0]?.id);
  const service: Service | undefined = task.services.find((item) => item.id === selected) ?? task.services[0];
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-1.5">
        {task.services.map((item) => (
          <li key={item.id} className="flex items-center justify-between gap-2 rounded-md border border-line px-2.5 py-2 text-xs">
            <button type="button" className="text-left" onClick={() => setSelected(item.id)}>
              <span className="text-ink">{item.name}</span>
              <span className="ml-2 text-muted">
                {item.mode === "local" ? `本地 :${item.port}` : "远程"}
                {item.repo ? ` · ${item.repo}` : ""}
              </span>
            </button>
            <div className="flex items-center gap-2">
              <Badge tone={item.running ? "accent" : "neutral"}>{item.running ? "运行中" : item.mode === "remote" ? "远程" : "已停止"}</Badge>
              {item.mode === "local" ? (
                <Button size="sm" onClick={() => onToggleService(item.id, !item.running)}>
                  {item.running ? "停止" : "启动"}
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {service ? (
        <Panel title={`生效配置 · ${service.name}`}>
          <ConfigTable rows={service.resolved} />
          <p className="mt-2 text-[11px] text-muted">
            敏感值遮蔽；未保存草稿不参与解析。共享模板版本 {service.templateVersion}。
          </p>
        </Panel>
      ) : null}
    </div>
  );
}

export function BrowserPanel({ pages }: { pages: BrowserPage[] }) {
  const [takenOver, setTakenOver] = useState(false);
  const [marks, setMarks] = useState<{ id: string; label: string }[]>([]);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[11px] text-muted">
        任务页面与 PiDock 自有界面分属不同信任范围；Agent 与用户操作同一页面实例。
      </p>
      <ul className="flex flex-col gap-1.5">
        {pages.map((page) => (
          <li key={page.id} className="rounded-md border border-line px-2.5 py-2 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="text-ink">{page.title}</span>
              <Badge>{page.id === pages[0]?.id ? "当前页面" : "标签页"}</Badge>
            </div>
            <p className="mt-1 font-mono text-[11px] text-muted">{page.url}</p>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => setTakenOver((value) => !value)}>
          {takenOver ? "交还控制" : "人工接管"}
        </Button>
        <Button
          size="sm"
          onClick={() => setMarks((items) => [...items, { id: `mark-${items.length + 1}`, label: `标记 ${items.length + 1} · #checkout-total` }])}
        >
          框选元素标记
        </Button>
        <Badge tone={takenOver ? "warn" : "neutral"}>{takenOver ? "人工接管中：自动化已暂停" : "Agent 控制中"}</Badge>
      </div>
      {marks.length > 0 ? (
        <ul className="flex flex-col gap-1.5 text-xs">
          {marks.map((mark) => (
            <li key={mark.id} className="rounded-md border border-line px-2.5 py-2">
              {mark.label} · 页面快照与元素信息随说明发送
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState>还没有标记。页面刷新后旧标记会失效，需要重新定位。</EmptyState>
      )}
    </div>
  );
}

export function FilesPanel({ files }: { files: WorkspaceFile[] }) {
  const preview = files.find((file) => file.preview)?.preview;
  const previewPath = files.find((file) => file.preview)?.path;
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-1 text-xs">
        {files.map((file) => (
          <li key={file.path} className="flex items-center justify-between gap-2 rounded border border-line px-2.5 py-1.5">
            <span className="font-mono text-[11px] text-ink">{file.path}</span>
            <Badge tone={file.status === "added" ? "accent" : "warn"}>
              {file.status === "added" ? "新增" : file.status === "deleted" ? "已删除" : "已修改"}
            </Badge>
          </li>
        ))}
      </ul>
      {preview ? <CodeBlock label={previewPath} language={preview.language} code={preview.source} /> : null}
    </div>
  );
}

export function TerminalPanel({ taskId, seed }: { taskId: string; seed: string[] }) {
  const runTerminalCommand = useHostStore((state) => state.runTerminalCommand);
  const [lines, setLines] = useState<string[]>(seed);
  const [value, setValue] = useState("");
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[11px] text-muted">终端输出与输入由本面板渲染，PTY 属于受管执行侧；当前为内存模拟。</p>
      <div className="h-56 overflow-auto rounded-md border border-line bg-ink/95 p-3 font-mono text-[11px] leading-5 text-white/90">
        {lines.map((line, index) => (
          <div key={`${line}-${index}`}>{line}</div>
        ))}
      </div>
      <form
        className="flex gap-2"
        onSubmit={async (event) => {
          event.preventDefault();
          const command = value.trim();
          if (!command) return;
          setValue("");
          const output = await runTerminalCommand(taskId, command);
          setLines((items) => [...items, ...output]);
        }}
      >
        <input
          aria-label="终端输入"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          className="flex-1 rounded-md border border-line bg-paper px-2.5 py-1.5 font-mono text-xs"
          placeholder="输入命令"
        />
        <Button size="sm" type="submit">
          执行
        </Button>
      </form>
    </div>
  );
}
