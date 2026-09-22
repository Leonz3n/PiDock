import { useState } from "react";
import { Badge, Button, EmptyState, Panel } from "./ui";
import { CodeBlock } from "./CodeBlock";
import { ConfigTable } from "./ConfigTable";
import type { BrowserPage, Service, Task, TaskDirectory, WorkspaceFile } from "../data/types";
import { directoryLinkPath } from "../data/directories";
import { useDraftStore } from "../stores/drafts";
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

/**
 * Directory root chooser shared by the ordinary-directory file and terminal
 * panels. The prototype's `directoryRootChoices()` lists the Git worktrees and
 * the ordinary directories so a mixed task can switch back to its worktree
 * view; the renderer shows one combined worktree entry because its file panel
 * already merges the task's repositories.
 */
export function DirectoryRootChoices({ task, selected, onSelect }: { task: Task; selected?: TaskDirectory; onSelect: (id: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {task.repos.length > 0 ? (
        <Button size="sm" variant={selected ? "default" : "primary"} onClick={() => onSelect("")}>
          仓库工作副本
        </Button>
      ) : null}
      {task.directories.map((directory) => (
        <Button
          key={directory.id}
          size="sm"
          variant={selected?.id === directory.id ? "primary" : "default"}
          onClick={() => onSelect(directory.id)}
        >
          {directory.name}
        </Button>
      ))}
    </div>
  );
}

/**
 * File panel for an ordinary directory. It shows the in-task symlink path and
 * the original path, and deliberately offers no Git diff / branch / commit
 * entry points. Editing through the link affects the original directory.
 *
 * Selection is controlled when a mixed task shares one active directory across
 * its file and terminal panels; the directory-only task keeps local state.
 */
export function DirectoryFilesPanel({
  task,
  selectedId: controlledId,
  onSelect,
}: {
  task: Task;
  selectedId?: string;
  onSelect?: (id: string) => void;
}) {
  const [localId, setLocalId] = useState(task.directories[0]?.id ?? "");
  const selectedId = controlledId ?? localId;
  const select = (id: string) => {
    setLocalId(id);
    onSelect?.(id);
  };
  const directory = task.directories.find((item) => item.id === selectedId) ?? task.directories[0];
  const createDirectoryFileReference = useHostStore((state) => state.createDirectoryFileReference);
  const addReference = useDraftStore((state) => state.addReference);
  if (!directory) return <EmptyState>这个任务还没有普通目录。</EmptyState>;
  const linkPath = directoryLinkPath(task.workspaceRoot, task.workspaceKey, directory);
  return (
    <div className="flex flex-col gap-3">
      <DirectoryRootChoices task={task} selected={directory} onSelect={select} />
      <div className="rounded-md border border-line bg-soft/40 px-3 py-2 text-xs">
        <div className="flex items-center gap-2">
          <strong className="text-ink">{directory.name}</strong>
          <Badge>软链接</Badge>
        </div>
        <p className="mt-1 text-[11px] text-muted">任务内软链接</p>
        <p className="font-mono text-[11px] text-ink" data-testid="directory-link-path">
          {linkPath}
        </p>
        <p className="mt-1 font-mono text-[11px] text-muted" data-testid="directory-original-path">
          指向原目录：{directory.path}
        </p>
        <p className="mt-1 text-[11px] text-muted">修改会影响原目录 · 文件未隔离</p>
      </div>
      <div className="rounded-md border border-line px-2.5 py-2 text-xs">
        <p className="font-mono text-[11px] text-ink">▾ {directory.linkName} → {directory.name}</p>
        <p className="mt-1 font-mono text-[11px] text-muted">{"  README.md（示例）"}</p>
      </div>
      <CodeBlock label={`${directory.linkName}/README.md`} language="markdown" code={"# 项目资料\n\n在这里整理说明与待办。"} />
      <Button
        size="sm"
        onClick={async () => addReference(task.id, task.activeSessionId, await createDirectoryFileReference(task.id, directory.id))}
      >
        引用示例文件
      </Button>
      <p className="text-[11px] text-muted">未读取真实目录。此目录不提供 Git 差异、分支或提交操作。</p>
    </div>
  );
}

/** Terminal panel that opens in the in-task symlink directory and shows the intended cwd. */
export function DirectoryTerminalPanel({
  task,
  selectedId: controlledId,
  onSelect,
}: {
  task: Task;
  selectedId?: string;
  onSelect?: (id: string) => void;
}) {
  const [localId, setLocalId] = useState(task.directories[0]?.id ?? "");
  const selectedId = controlledId ?? localId;
  const select = (id: string) => {
    setLocalId(id);
    onSelect?.(id);
  };
  const directory = task.directories.find((item) => item.id === selectedId) ?? task.directories[0];
  const runTerminalCommand = useHostStore((state) => state.runTerminalCommand);
  const [lines, setLines] = useState<string[]>([]);
  const [value, setValue] = useState("");
  if (!directory) return <EmptyState>这个任务还没有普通目录。</EmptyState>;
  const cwd = directoryLinkPath(task.workspaceRoot, task.workspaceKey, directory);
  return (
    <div className="flex flex-col gap-2">
      <DirectoryRootChoices task={task} selected={directory} onSelect={select} />
      <p className="text-[11px] text-muted">拟用工作目录</p>
      <p className="font-mono text-[11px] text-ink" data-testid="directory-terminal-cwd">
        {cwd}
      </p>
      <p className="font-mono text-[11px] text-muted">指向原目录：{directory.path}</p>
      <p className="text-[11px] text-muted">原型终端：拟从以上链接位置打开，仅回显，不执行命令。</p>
      <div className="h-48 overflow-auto rounded-md border border-line bg-ink/95 p-3 font-mono text-[11px] leading-5 text-white/90">
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
          const output = await runTerminalCommand(task.id, command);
          setLines((items) => [...items, ...output]);
        }}
      >
        <input
          aria-label="终端输入"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          className="flex-1 rounded-md border border-line bg-paper px-2.5 py-1.5 font-mono text-xs"
          placeholder="输入示例命令"
        />
        <Button size="sm" type="submit">
          执行
        </Button>
      </form>
    </div>
  );
}
