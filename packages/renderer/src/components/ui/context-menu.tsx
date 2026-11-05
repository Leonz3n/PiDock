import * as React from "react";
import * as Menu from "@radix-ui/react-context-menu";
import { cn } from "../../lib/utils";

// shadcn ContextMenu composition with the application's existing Radix base.
export const ContextMenu = Menu.Root;
export const ContextMenuGroup = Menu.Group;
export const ContextMenuTrigger = Menu.Trigger;
export function ContextMenuContent({ className, ...props }: React.ComponentProps<typeof Menu.Content>) {
  return <Menu.Portal><Menu.Content className={cn("min-w-44 rounded-md border border-line bg-paper p-1 text-xs text-ink shadow-lg outline-none", className)} {...props} /></Menu.Portal>;
}
export function ContextMenuItem({ className, ...props }: React.ComponentProps<typeof Menu.Item>) {
  return <Menu.Item className={cn("relative flex cursor-default select-none items-center rounded-sm px-2 py-1.5 outline-none data-[highlighted]:bg-soft data-[highlighted]:text-accent data-[disabled]:pointer-events-none data-[disabled]:text-muted", className)} {...props} />;
}
