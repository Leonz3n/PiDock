import { useRef, type KeyboardEvent } from "react";
import { Icon, type IconName } from "./Icon";
import { IconButton } from "./ui";

/** Shared ARIA tab strip for the demo workbench and the production desktop dock. */
export function ToolTabBar<T extends string>({
  panels,
  activePanel,
  labelFor,
  iconFor,
  onSelectPanel,
  onClosePanel,
  onCollapse,
  idPrefix = "tool",
  rowTestId = "tool-tabs-row",
  tabsTestId = "tool-tabs",
  collapseTestId = "collapse-tools",
  ariaLabel = "已打开的工具",
}: {
  panels: readonly T[];
  activePanel: T;
  labelFor: (panel: T) => string;
  iconFor: (panel: T) => IconName;
  onSelectPanel: (panel: T) => void;
  onClosePanel: (panel: T) => void;
  onCollapse: () => void;
  idPrefix?: string;
  rowTestId?: string;
  tabsTestId?: string;
  collapseTestId?: string;
  ariaLabel?: string;
}) {
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const moveSelection = (panel: T, step: number | "first" | "last") => {
    const from = panels.indexOf(panel);
    const target = step === "first"
      ? panels[0]
      : step === "last"
        ? panels[panels.length - 1]
        : panels[(from + step + panels.length) % panels.length];
    if (target === undefined) return;
    onSelectPanel(target);
    tabRefs.current[target]?.focus();
  };
  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, panel: T) => {
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      moveSelection(panel, event.key === "ArrowRight" ? 1 : -1);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      moveSelection(panel, event.key === "Home" ? "first" : "last");
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelectPanel(panel);
    }
  };

  return (
    <div data-testid={rowTestId} className="flex h-11 min-h-11 items-center gap-1.5 border-b border-line bg-paper px-4">
      <div
        role="tablist"
        aria-label={ariaLabel}
        data-testid={tabsTestId}
        className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto"
      >
        {panels.map((panel) => {
          const active = panel === activePanel;
          const label = labelFor(panel);
          const tabId = `${idPrefix}-tab-${panel}`;
          return (
            <div
              key={panel}
              data-testid={`${idPrefix}-tab-item-${panel}`}
              className={`flex shrink-0 items-center border-b-2 ${active ? "border-accent" : "border-transparent"}`}
            >
              <button
                type="button"
                role="tab"
                id={tabId}
                aria-selected={active}
                aria-controls={`${idPrefix}-panel`}
                tabIndex={active ? 0 : -1}
                ref={(node) => {
                  tabRefs.current[panel] = node;
                }}
                onKeyDown={(event) => onTabKeyDown(event, panel)}
                data-testid={`${idPrefix}-tab-${panel}`}
                onClick={() => onSelectPanel(panel)}
                className={`flex items-center gap-1.5 whitespace-nowrap py-2.5 pl-1.5 pr-0.5 text-[11px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${active ? "font-medium text-accent" : "text-muted hover:text-ink"}`}
              >
                <Icon name={iconFor(panel)} className="h-3.5 w-3.5" />
                {label}
              </button>
              <button
                type="button"
                data-testid={`${idPrefix}-tab-close-${panel}`}
                aria-label={`关闭${label}`}
                title={`关闭${label}`}
                onClick={() => onClosePanel(panel)}
                className="mr-1 grid h-5 w-5 place-items-center rounded text-[#9ba4b2] hover:bg-soft hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                <Icon name="close" className="h-3 w-3" />
              </button>
            </div>
          );
        })}
      </div>
      {/* Keep collapse outside tablist: it is an action, not a selectable tab. */}
      <IconButton
        icon="close"
        label="收起工具区"
        className="ml-auto shrink-0"
        data-testid={collapseTestId}
        onClick={onCollapse}
      />
    </div>
  );
}
