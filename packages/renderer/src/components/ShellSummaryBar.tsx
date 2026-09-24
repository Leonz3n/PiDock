/**
 * Bottom summary bar ([UI 对齐 01] #25).
 *
 * The prototype keeps a floating strip at this position for its layout
 * switcher; the product renders the same position as a read-only summary of
 * the current task, its services and who holds the task browser — no A/B/C
 * variant switching (that existed for prototype comparison only).
 */

import { summarySegments } from "../data/shellNav";
import { useHostStore } from "../stores/host";
import { useNavigationStore } from "../stores/navigation";
import { useUiStore } from "../stores/ui";

export function ShellSummaryBar() {
  const route = useNavigationStore((state) => state.route);
  const workspace = useHostStore((state) => state.workspace);
  const takeoverPaused = useUiStore((state) =>
    route.view === "task" ? (state.browserTakeover[route.taskId] ?? false) : false,
  );

  const task = route.view === "task" ? workspace?.tasks.find((item) => item.id === route.taskId) : undefined;
  const currentProject =
    route.view === "project" || route.view === "task"
      ? workspace?.projects.find((item) => item.id === route.projectId)
      : workspace?.projects[0];
  const segments = summarySegments({ task, workspaceName: currentProject?.name, takeoverPaused });

  return (
    <section
      aria-label="当前任务摘要"
      data-testid="shell-summary"
      className="fixed bottom-[10px] left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-[10px] border border-[#3b465c] bg-[#293142] px-[10px] py-1.5 text-[10px] whitespace-nowrap text-[#b5bfd4] shadow-[0_4px_15px_#151a2522] below-stack:gap-0.5 below-stack:px-1.5 below-stack:py-1"
    >
      {segments.map((segment, index) => (
        <span
          key={segment.key}
          data-summary-segment={segment.key}
          title={segment.title}
          className={`flex items-center gap-2 ${
            // Prototype `.switcher`: below 960px the long state text is dropped
            // and below 720px the strip tightens; the bar keeps only the pieces
            // that still fit at the current tier ([UI 对齐 03] #27).
            segment.key === "browser" ? "below-mid:hidden" : segment.key === "services" ? "below-stack:hidden" : ""
          }`}
        >
          {index > 0 ? (
            <span aria-hidden className="text-[#5b657c]">
              ·
            </span>
          ) : null}
          {segment.label}
        </span>
      ))}
    </section>
  );
}
