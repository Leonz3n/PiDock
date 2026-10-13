/**
 * Production bottom summary bar content ([UI 对齐 S8a] #47).
 *
 * Prototype A's strip carries the current task, its running service count and
 * who holds the task browser (`prototypes/pidock-ui/app.js:79`), and the demo
 * path renders all three from the workspace snapshot
 * (`components/ShellSummaryBar.tsx` over `data/shellNav.ts summarySegments`).
 * The production shell can source the first of those for real and none of the
 * rest: a task's services are only readable inside that task's own tool dock
 * (`task/serviceRunRecords` + `serviceCatalogOp {op:"taskBindings"}` in
 * `data/taskServices.ts`), and the browser owner only from the live page main
 * owns (`task/browserAction`). The shell holds neither, so it does not guess:
 * a segment is produced ONLY from a value the shell already holds, and a
 * prototype element with no such source is absent from the bar instead of
 * rendering `0 服务`/`—`. `0 服务` is the fiction this bar exists to avoid —
 * it reads "nothing runs" where the truth is "nobody read".
 */

export type DesktopSummaryKey = "scope" | "tasks" | "roots";

export interface DesktopSummarySegment {
  key: DesktopSummaryKey;
  /** The strip is `whitespace-nowrap`, so this stays one short line. */
  label: string;
  /** Hover wording that says what was read, and what is only declared. */
  title: string;
}

export function desktopSummarySegments(input: {
  /** The task or Project the shell shows, named as the Host reported it. */
  scope?: { kind: "task" | "project"; name: string };
  /**
   * Tasks the lifecycle read verified as not archived, or `null` while that
   * read is outstanding or incomplete. An unverified lifecycle is never a
   * count: `0` would claim every task is archived.
   */
  activeTaskCount: number | null;
  /** The task roots the shell read; `[]` is no root readout at all. */
  roots: readonly { state: "ready" | "error" }[];
}): DesktopSummarySegment[] {
  const segments: DesktopSummarySegment[] = [];

  if (input.scope) {
    const what = input.scope.kind === "task" ? "当前任务" : "当前项目";
    segments.push({ key: "scope", label: input.scope.name, title: `${what} · ${input.scope.name}` });
  }

  segments.push(
    input.activeTaskCount === null
      ? { key: "tasks", label: "进行中的任务 · 未核验", title: "任务归档状态尚未核验完整，此处不给出计数" }
      : { key: "tasks", label: `进行中的任务 ${input.activeTaskCount}`, title: `已核验为未归档的任务 · ${input.activeTaskCount}` },
  );

  const broken = input.roots.filter((root) => root.state === "error").length;
  if (input.roots.length > 0) {
    segments.push(
      broken === 0
        ? { key: "roots", label: `任务根 ${input.roots.length}/${input.roots.length} 就绪`, title: `已读取全部 ${input.roots.length} 个任务根` }
        : { key: "roots", label: `${broken} 个任务根不可用`, title: `${broken} 个任务根读取失败，可在页头重试` },
    );
  }

  return segments;
}
