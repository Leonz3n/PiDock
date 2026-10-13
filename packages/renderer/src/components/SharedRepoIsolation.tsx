/**
 * [PiDock 03] (#6 盒子 6) 同一项目仓库被两个任务使用时，各自的路径、工作分支与变化.
 *
 * The desktop Project page is where two tasks of ONE project are already
 * visible together, so this is where the readout that keeps them apart lives:
 * one row per (task, root), grouped by the root id. A root id is the project
 * repository's own `repo-<id8>` folder name (`main/multi-repo-provision.ts`
 * `buildRepoChildName`) or the project directory's `dir-<id8>` link name, so
 * two tasks really using the same project repository (or the same linked
 * directory) land in the same group — that grouping is what makes the shared
 * case visible instead of two identical-looking panels.
 *
 * Every fact in a row is the Host's OWN answer, never the record's:
 * - `task/fileRoots` reports the worktree's observed working branch
 *   (`workingBranch`), its observed uncommitted state (`dirty`) and the pinned
 *   baseline branch (`baselineBranch`) as three separate fields;
 * - `task/fileDiff` (the bounded, masked whole-worktree diff against the pinned
 *   baseline) reports the change, and an untouched worktree reads clean only
 *   from that observed empty diff.
 * A read that failed keeps its named unknown: this surface never fills an
 * unread branch with the baseline and never fills an unread change with 干净.
 *
 * The plain-directory link is the honest exception, not a second kind of copy:
 * it is a view of the ORIGINAL directory, so every one of its rows says
 * 共享原目录，文件未隔离 and shows the Host's named refusal
 * (`plain-dir-no-diff`) where a Git view would be. A write through it lands in
 * the original target, which is exactly why the worktree isolation below does
 * not apply to it.
 *
 * [PiDock 03] (#6 box 12) the link's TARGET shape is read here too, through the
 * one existing link op (`task/probeLink` → `probeLinkThroughShell`). The Host
 * answers with its own observation, so 失效/嵌套/循环 are three DIFFERENT named
 * states (never "a directory"), a shape it could not read is NAMED unknown, and
 * the row carries the Host's per-platform link-capability record (this machine's
 * platform exercised, `win32` unverified by name) plus the named boundary that
 * this is a Host observation and NOT a real pi/model verification.
 */
import { useEffect, useRef, useState } from "react";
import { fileDiffThroughShell, fileRootsThroughShell, probeLinkThroughShell } from "../data/shellBridge";
import { shellFailure } from "../data/taskServices";
import {
  hostText,
  observedText,
  workspaceDiffFromHost,
  workspaceLinkTargetFromHost,
  workspaceRootsFromHost,
  type WorkspaceLinkTargetView,
  type WorkspaceRootView,
} from "../data/workspaceFiles";
import { Icon } from "./Icon";
import { Button } from "./ui/button";

/** One (task, root) row. */
type RootRow = { taskId: string; taskName: string; root: WorkspaceRootView };

/** One read of a row's change: the Host's bounded diff, or its named refusal. */
type ChangeRead = { state: "observed"; diff: string; truncated: boolean } | { state: "unknown"; reason: string };

/** One read of a link's target shape: the Host's observation, or a named unknown. */
type LinkRead = { state: "observed"; link: WorkspaceLinkTargetView } | { state: "unknown"; reason: string };

/**
 * The Host's observed shape as words. Each NAMED shape keeps its OWN name, so 失效
 * (目标不存在), 嵌套 (来源是软链接，不是原目录) and 循环 (链回到已跟随过的链接) can never
 * be read as the same "a directory", and `unknown` never silently becomes healthy.
 *
 * The 嵌套 label is deliberately not broader than the observation: a one-hop link
 * to a directory and a link→link chain are both 嵌套, and the Host's own detail
 * (shown beside this label) says which of the two was seen.
 *
 * Only the four NAMED shapes live in this map: `unknown` is not a fifth shape but
 * the Host's own "none of the four named" answer, produced by four different
 * walks (see `unknownShapeLabel`).
 */
const LINK_SHAPE_LABEL: Record<Exclude<WorkspaceLinkTargetView["shape"], "unknown">, string> = {
  directory: "真实目录（Host 实测）",
  dangling: "失效：链接目标已不存在（Host 实测）",
  "nested-link": "嵌套：来源是软链接，指向的不是原目录本身（Host 实测）",
  "cyclic-link": "循环：链接链回到已跟随过的链接（Host 实测）",
};

/**
 * The Host's `unknown` shape, as words. It is NOT one branch: `observeLinkChain`
 * (`host/task-host.ts:279-316`) yields it when the 16-hop budget stopped the
 * crawl (links had been followed), when an `lstat` failed, when a `readlink`
 * failed, and when the chain ended at something that is not a directory - a real
 * probe ran in every one of them. So a row may not claim 形状未实测 ("the shape was
 * never measured"): this label names the one fact all four branches share (the
 * probe named none of the four shapes) and carries the Host's own per-branch
 * detail verbatim, which is the only per-branch evidence this surface has.
 */
function unknownShapeLabel(detail: string): string {
  return `未确定：探测没有给出已命名的形状；Host 读到的情况：${detail}`;
}

/** The plan-time lexical pre-check, labelled apart from the observation. */
const LINK_LEXICAL_LABEL: Record<WorkspaceLinkTargetView["lexical"], string> = {
  ok: "路径不嵌套、不在任务目录内",
  nested: "来源位于另一个来源内（视图重叠，合法）",
  "loop-risk": "来源在任务目录内，创建链接可能回环（风险，不是已观测的循环）",
};

/** The shape read as words: the reading, what the Host really saw, and the pre-check. */
function linkShapeSummary(link: LinkRead | undefined): string {
  if (link === undefined) return "未实测：尚未读取";
  if (link.state === "unknown") return `未确定：${link.reason}`;
  const { shape, detail } = link.link;
  // `str()` keeps `""`, so the Host's own empty `detail` is named ONCE here and
  // both branches below carry the named absence: a bare `Host 观测：` would read
  // as a detail that was dropped rather than one the Host never gave.
  const detailText = hostText(detail, "Host 未给出观测细节");
  const label = shape === "unknown" ? unknownShapeLabel(detailText) : `${LINK_SHAPE_LABEL[shape]} · Host 观测：${detailText}`;
  return `${label} · 词法预检：${LINK_LEXICAL_LABEL[link.link.lexical]}`;
}

/** One task whose roots could not be read at all; named, so it is never dropped silently. */
type TaskReadFailure = { taskName: string; reason: string };

function rowKey(row: RootRow): string {
  return `${row.taskId}\u0000${row.root.id}`;
}

/** The Host's own refusal name for a link's Git view (`main/workspace-files.ts`). */
const PLAIN_DIR_NO_DIFF = "plain-dir-no-diff:";

/**
 * The pinned baseline the change reading compares against, as one row can name
 * it. Without a recorded commit the phrase stays honest about that instead of
 * inventing a base.
 */
function baselinePhrase(root: WorkspaceRootView): string {
  return root.baseCommit ? `与基线 ${root.baseCommit.slice(0, 7)} 的差异` : "与固定基线的差异（任务记录未给出基线提交）";
}

/**
 * One row's change as words. The three inputs are kept apart on purpose: the
 * diff against the pinned baseline cannot see UNTRACKED files, so an empty diff
 * on its own would turn a new file into 无改动 — the uncommitted reading is
 * required for a clean verdict, and any unread input keeps the row from
 * claiming one.
 */
export function changeSummary(root: WorkspaceRootView, change: ChangeRead | undefined): string {
  const baseline = baselinePhrase(root);
  const dirty = root.dirty;
  const uncommitted =
    dirty === undefined
      ? "未提交或未跟踪状态未实测（Host 未上报）"
      : dirty.state === "observed"
        ? dirty.value
          ? "有未提交或未跟踪文件（实测）"
          : "无未提交或未跟踪文件（实测）"
        : `未提交或未跟踪状态未实测（${hostText(dirty.reason, "Host 未给出未读原因")}）`;
  if (change === undefined) return `未实测：尚未读取；${uncommitted}`;
  if (change.state === "unknown") return `未实测：${baseline}未读取（${change.reason}）；${uncommitted}`;
  if (change.diff.length > 0) {
    // Trailing newlines are not lines of their own.
    const lines = change.diff.replace(/\n+$/, "").split("\n").length;
    return `有改动（实测：${baseline} ${lines} 行${change.truncated ? "，已按上限截断" : ""}；${uncommitted}）`;
  }
  if (dirty?.state === "observed" && dirty.value) {
    return `有改动（实测：${uncommitted}，未进入${baseline}）`;
  }
  if (dirty?.state === "observed") {
    return `无改动（实测：${baseline}为空，且无未提交或未跟踪文件）`;
  }
  return `部分未实测：${baseline}为空，但${uncommitted}`;
}

/** A link root has no Git view at all: it shows the Host's named refusal. */
function linkGitSummary(change: ChangeRead | undefined): string {
  if (change === undefined) return "未实测：尚未读取";
  if (change.state === "observed") return "未实测：Host 对该链接返回了差异，未给出具名拒绝";
  return change.reason.startsWith(PLAIN_DIR_NO_DIFF)
    ? `无 Git 视图（Host 具名拒绝）${change.reason}`
    : `未实测：${change.reason}`;
}

function WorktreeRow({ row, change }: { row: RootRow; change: ChangeRead | undefined }) {
  const root = row.root;
  return (
    <div className="mt-2 rounded-[7px] border border-line bg-paper px-3 py-2" data-testid="worktree-row" data-task={row.taskId} data-root={root.id}>
      <p className="text-xs font-semibold text-ink">任务 {row.taskName}</p>
      <dl className="mt-1 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-[11px]">
        <dt className="text-muted">工作副本路径</dt>
        <dd className="min-w-0 break-all font-mono">{hostText(root.path, "Host 未上报工作副本路径")}</dd>
        <dt className="text-muted">工作分支</dt>
        <dd className="min-w-0 break-all font-mono" data-testid={`row-working-branch-${row.taskId}`}>
          {observedText(root.workingBranch, (name) => hostText(name, "Host 未上报工作分支名"), "Host 未上报工作分支观察")}
        </dd>
        <dt className="text-muted">远程基线分支</dt>
        <dd className="min-w-0 break-all font-mono" data-testid={`row-baseline-branch-${row.taskId}`}>
          {root.baselineBranch || "Host 未提供"}（固定）
        </dd>
        <dt className="text-muted">变化</dt>
        <dd className="min-w-0 break-words" data-testid={`row-change-${row.taskId}`}>{changeSummary(root, change)}</dd>
      </dl>
      {change?.state === "observed" && change.diff.length > 0 && (
        <pre className="mt-1.5 max-h-[200px] overflow-auto border border-line bg-soft/40 p-2 text-[10px] leading-relaxed" data-testid={`row-diff-${row.taskId}`}>
          {change.diff}
        </pre>
      )}
    </div>
  );
}

function LinkRow({ row, change, link }: { row: RootRow; change: ChangeRead | undefined; link: LinkRead | undefined }) {
  const root = row.root;
  return (
    <div className="mt-2 rounded-[7px] border border-line bg-paper px-3 py-2" data-testid="shared-dir-row" data-task={row.taskId} data-root={root.id}>
      <p className="text-xs font-semibold text-ink">任务 {row.taskName}</p>
      <dl className="mt-1 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-[11px]">
        <dt className="text-muted">任务内链接</dt>
        <dd className="min-w-0 break-all font-mono">{hostText(root.path, "Host 未上报任务内链接路径")}</dd>
        <dt className="text-muted">指向原目录</dt>
        <dd className="min-w-0 break-all font-mono">{root.sourcePath || "Host 未提供"}</dd>
        <dt className="text-muted">文件隔离</dt>
        <dd className="min-w-0 break-words" data-testid={`row-link-isolation-${row.taskId}`}>
          共享原目录，文件未隔离（写入会落到原目录，不是独立副本）
        </dd>
        {/* [PiDock 03] (#6 box 12) the Host's OWN shape reading of this link's
            target: 失效/嵌套/循环 stay three named states, and a shape that could
            not be read is a named unknown. */}
        <dt className="text-muted">链接目标形状</dt>
        <dd className="min-w-0 break-words" data-testid={`row-link-shape-${row.taskId}`} data-shape={link?.state === "observed" ? link.link.shape : "unread"}>
          {linkShapeSummary(link)}
        </dd>
        <dt className="text-muted">链接能力（按平台）</dt>
        <dd className="min-w-0 break-words" data-testid={`row-link-platforms-${row.taskId}`}>
          {link?.state === "observed" ? (
            <ul className="flex flex-col gap-y-0.5">
              {link.link.platforms.map((platform) => (
                <li key={platform.platform} data-platform={platform.platform} data-exercised={platform.exercised ? "true" : "false"}>
                  <span className="font-mono">{hostText(platform.platform, "Host 未上报平台标识")}</span>：{platform.exercised ? "已实测" : "未实测"} · {hostText(platform.note, "Host 未上报该平台的说明")}
                </li>
              ))}
            </ul>
          ) : (
            /* No probe result: the platform record was never read, and this row
               says so instead of leaving an empty area that could be taken for
               "no platform problem". */
            "本次未取得 Host 链接探测记录：未记录任何平台实测，也未声明真实 pi 边界。"
          )}
        </dd>
        {link?.state === "observed" && (
          <>
            <dt className="text-muted">记录边界</dt>
            <dd className="min-w-0 break-words" data-testid={`row-link-model-boundary-${row.taskId}`}>{hostText(link.link.modelBoundary, "Host 未上报记录边界")}</dd>
          </>
        )}
        <dt className="text-muted">Git 视图</dt>
        <dd className="min-w-0 break-words" data-testid={`row-link-git-${row.taskId}`}>{linkGitSummary(change)}</dd>
      </dl>
    </div>
  );
}

/**
 * One root id, with every task of this project that has it. A group with more
 * than one task is the shared case this panel exists for, and its note states
 * which sharing it is: two independent worktrees, or one original directory.
 */
function RootGroup({ rootId, rows, changes, links }: { rootId: string; rows: readonly RootRow[]; changes: Record<string, ChangeRead>; links: Record<string, LinkRead> }) {
  const root = rows[0]!.root;
  const shared = rows.length > 1;
  return (
    <div className="mt-3" data-testid={root.kind === "shared-dir" ? "shared-dir-group" : "worktree-group"} data-root={rootId}>
      <h3 className="text-[12px] font-semibold text-ink">
        {root.kind === "shared-dir" ? "普通目录链接" : "仓库"} <span className="font-mono">{hostText(rootId, "Host 未上报根标识")}</span>
      </h3>
      {shared && root.kind === "worktree" && (
        <p className="mt-1 text-[11px] text-muted" data-testid={`worktree-group-note-${rootId}`}>
          同一项目仓库的 {rows.length} 个任务各有独立工作副本（Git worktree）：在一个工作副本里写入不会到达另一个，也不会到达共享的原仓库。
        </p>
      )}
      {shared && root.kind === "shared-dir" && (
        <p className="mt-1 text-[11px] text-[#9a6032]" data-testid={`shared-dir-group-note-${rootId}`}>
          本项目 {rows.length} 个任务指向同一原目录：共享原目录，文件未隔离，写入会互相影响。
        </p>
      )}
      {rows.map((row) =>
        root.kind === "shared-dir" ? (
          <LinkRow key={row.taskId} row={row} change={changes[rowKey(row)]} link={links[rowKey(row)]} />
        ) : (
          <WorktreeRow key={row.taskId} row={row} change={changes[rowKey(row)]} />
        ),
      )}
    </div>
  );
}

export function SharedRepoIsolation({ tasks }: { tasks: readonly { taskId: string; name: string }[] }) {
  const [rows, setRows] = useState<RootRow[] | null>(null);
  const [changes, setChanges] = useState<Record<string, ChangeRead>>({});
  const [links, setLinks] = useState<Record<string, LinkRead>>({});
  const [failures, setFailures] = useState<TaskReadFailure[]>([]);
  const [revision, setRevision] = useState(0);
  // The task list is rebuilt on every render of the page, so the effect keys on
  // the task identity signature and reads the current names through this ref
  // (the same "latest value" ref the sibling panels use).
  const signature = tasks.map((task) => task.taskId).join("\n");
  const latest = useRef(tasks);
  latest.current = tasks;

  useEffect(() => {
    let live = true;
    void (async () => {
      setRows(null);
      setChanges({});
      setLinks({});
      setFailures([]);
      const collected: RootRow[] = [];
      const unread: TaskReadFailure[] = [];
      // One Host read at a time: a project with several tasks must not turn its
      // overview into a burst of Host ops (each root read spawns real git).
      for (const task of latest.current) {
        const result = await fileRootsThroughShell(task.taskId);
        if (!live) return;
        const parsed = result.ok ? workspaceRootsFromHost(result.payload) : undefined;
        if (!parsed) {
          unread.push({ taskName: task.name, reason: result.ok ? "Host 文件根响应无法解析" : shellFailure(result, "读取任务文件根失败") });
          continue;
        }
        for (const root of parsed.roots) collected.push({ taskId: task.taskId, taskName: task.name, root });
      }
      if (!live) return;
      setRows(collected);
      setFailures(unread);
      const read: Record<string, ChangeRead> = {};
      for (const row of collected) {
        const result = await fileDiffThroughShell({ taskId: row.taskId, rootId: row.root.id });
        if (!live) return;
        if (!result.ok) {
          read[rowKey(row)] = { state: "unknown", reason: shellFailure(result, "读取改动失败") };
          continue;
        }
        const view = workspaceDiffFromHost(result.payload);
        read[rowKey(row)] = view
          ? { state: "observed", diff: view.diff, truncated: view.truncated }
          : { state: "unknown", reason: "Host 改动响应无法解析" };
      }
      if (!live) return;
      setChanges(read);
      // The link's OWN shape read, through the one existing link op. A plain
      // directory the Host reported without a source path cannot be probed at
      // all, and that stays a named unknown rather than a healthy directory.
      const probed: Record<string, LinkRead> = {};
      for (const row of collected) {
        if (row.root.kind !== "shared-dir") continue;
        const sourcePath = row.root.sourcePath;
        if (sourcePath === undefined) {
          probed[rowKey(row)] = { state: "unknown", reason: "Host 未上报该链接的源路径，无法探测目标形状" };
          continue;
        }
        const result = await probeLinkThroughShell({ taskId: row.taskId, sourcePath });
        if (!live) return;
        if (!result.ok) {
          probed[rowKey(row)] = { state: "unknown", reason: shellFailure(result, "读取链接目标形状失败") };
          continue;
        }
        const view = workspaceLinkTargetFromHost(result.payload);
        probed[rowKey(row)] = view
          ? { state: "observed", link: view }
          : { state: "unknown", reason: "Host 链接探测响应无法解析" };
      }
      if (!live) return;
      setLinks(probed);
    })();
    return () => {
      live = false;
    };
  }, [signature, revision]);

  const groups = new Map<string, RootRow[]>();
  for (const row of rows ?? []) {
    const list = groups.get(row.root.id);
    if (list) list.push(row);
    else groups.set(row.root.id, [row]);
  }

  return (
    <section className="mt-8" aria-label="共享仓库的多任务隔离" data-testid="shared-repo-isolation">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">共享仓库的多任务隔离</h2>
        <Button type="button" size="sm" variant="outline" onClick={() => setRevision((value) => value + 1)}>
          <Icon name="refresh" />重新读取
        </Button>
      </div>
      <p className="mt-1 text-xs text-muted">
        每行都是本机 Host 的实测结果：工作分支与变化来自该任务自己的工作副本，远程基线分支是固定记录。普通目录链接共享原目录，文件未隔离，写入会落到原目录；它的目标形状（真实目录 / 失效 / 嵌套 / 循环 / 未确定）与按平台的链接能力记录来自同一次 Host 探测，不是真实 pi 运行。
      </p>
      {rows === null && <p className="mt-3 text-xs text-muted" role="status">正在读取各任务的真实工作副本…</p>}
      {failures.map((failure) => (
        <p key={failure.taskName} role="alert" className="mt-2 text-xs text-[#ad4545]" data-testid="shared-repo-read-failure">
          任务 {failure.taskName} 的工作副本未读取：{failure.reason}
        </p>
      ))}
      {rows !== null && groups.size === 0 && failures.length === 0 && (
        <p className="mt-3 text-xs text-muted" data-testid="shared-repo-empty">本项目还没有可读取的仓库或普通目录链接。</p>
      )}
      {[...groups.entries()].map(([rootId, group]) => (
        <RootGroup key={rootId} rootId={rootId} rows={group} changes={changes} links={links} />
      ))}
    </section>
  );
}
