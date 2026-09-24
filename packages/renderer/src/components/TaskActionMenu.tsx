/**
 * `···` task action menu ([UI 对齐 03] #27).
 *
 * Prototype A keeps the task header to one compact actionset and moves the
 * secondary/destructive task actions behind the `任务操作` icon button
 * (`app.js` header + `navigation.js` `navigationMenu('task', …)`): a
 * `role="menu"` popover whose first item takes focus, `ArrowUp`/`ArrowDown`
 * cycle, `Escape` closes and returns focus to the trigger, and a pointer
 * press outside closes it. Entries that are not available for the current task
 * (审阅与交付 for ordinary-directory or archived tasks, Subagent 列表 without
 * child agents) are omitted by the caller, so the menu cannot offer a dead end.
 */

import { useEffect, useRef, useState } from "react";
import { IconButton } from "./ui";

export interface TaskActionMenuItem {
  id: string;
  label: string;
  /** Extra wording shown in the item's `title`; never replaces the label. */
  detail?: string;
  onSelect: () => void;
}

export function TaskActionMenu({ items, label = "任务操作" }: { items: TaskActionMenuItem[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const close = (focusTrigger: boolean) => {
    setOpen(false);
    if (focusTrigger) trigger.current?.focus();
  };

  const move = (delta: 1 | -1 | "first" | "last") => {
    const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
    if (buttons.length === 0) return;
    const current = buttons.findIndex((button) => button === document.activeElement);
    const next =
      delta === "first"
        ? 0
        : delta === "last"
          ? buttons.length - 1
          : (current + delta + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  return (
    <div ref={wrap} className="relative">
      <IconButton
        ref={trigger}
        icon="more"
        label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        className={open ? "bg-soft text-ink" : ""}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      />
      {open ? (
        <div
          ref={menu}
          role="menu"
          aria-label={label}
          data-testid="task-action-menu"
          className="absolute top-full right-0 z-30 mt-1 flex min-w-[190px] flex-col rounded-lg border border-line bg-paper p-1 shadow-[0_5px_30px_#151a2722]"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              close(true);
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              move(1);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              move(-1);
            } else if (event.key === "Home") {
              event.preventDefault();
              move("first");
            } else if (event.key === "End") {
              event.preventDefault();
              move("last");
            } else if (event.key === "Tab") {
              setOpen(false);
            }
          }}
        >
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              title={item.detail ?? item.label}
              onClick={() => {
                close(true);
                item.onSelect();
              }}
              className="rounded-md px-2.5 py-1.5 text-left text-xs text-ink hover:bg-soft focus-visible:bg-soft focus-visible:outline-none"
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
