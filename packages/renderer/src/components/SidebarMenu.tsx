import { useRef, type ReactNode } from "react";
import { ContextMenu, ContextMenuContent, ContextMenuGroup, ContextMenuItem, ContextMenuTrigger } from "./ui/context-menu";

export type SidebarAction = { taskId: string; sessionId?: string; action: "new" | "rename" | "stop" | "archive" | "restore" | "delete" | "archive-task" | "cleanup-task"; token: number };
export type SidebarMenuItem = { label: string; run?: () => void; reason?: string };

/** Each trigger retains the stable row identity; opening a menu never selects it. */
export function SidebarMenu({ children, label, items }: { children: ReactNode; label: string; items: SidebarMenuItem[] }) {
  const trigger = useRef<HTMLSpanElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const keyboardEntry = useRef(false);
  const pendingAction = useRef<(() => void) | null>(null);
  return <ContextMenu onOpenChange={(open) => { if (open) pendingAction.current = null; else keyboardEntry.current = false; }}><ContextMenuTrigger asChild><span ref={trigger} className="contents" onKeyDown={(event) => {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    event.preventDefault();
    keyboardEntry.current = true;
    const target = event.target as HTMLElement;
    const rect = target.getBoundingClientRect();
    target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 }));
  }}>{children}</span></ContextMenuTrigger><ContextMenuContent ref={content} aria-label={label} onOpenAutoFocus={(event) => {
    // Let the mounted Radix focus scope own keyboard entry. A pre-mount
    // animation frame can race its automatic focus and leave focus on the menu.
    if (!keyboardEntry.current) return;
    event.preventDefault();
    content.current?.querySelector<HTMLElement>('[role="menuitem"]:not([data-disabled])')?.focus({ preventScroll: true });
  }} onCloseAutoFocus={(event) => {
    // The span uses display:contents; return to the row's actual navigation button.
    event.preventDefault();
    trigger.current?.querySelector<HTMLButtonElement>("button[data-row-select]")?.focus({ preventScroll: true });
    const action = pendingAction.current;
    pendingAction.current = null;
    // Let the menu's modal focus scope release before opening another Dialog.
    if (action) setTimeout(action, 0);
  }}><ContextMenuGroup>{items.map((item) => <ContextMenuItem key={item.label} disabled={!item.run} onSelect={() => { pendingAction.current = item.run ?? null; }} title={item.reason}>{item.label}{item.reason && <span className="ml-2 text-[10px]">{item.reason}</span>}</ContextMenuItem>)}</ContextMenuGroup></ContextMenuContent></ContextMenu>;
}
