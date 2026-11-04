import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cn } from "@/lib/utils";

// shadcn Dialog composition, using PiDock tokens and the existing Radix base.
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;
export function DialogContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-overlay" />
      <DialogPrimitive.Content
        className={cn(
          "fixed left-[calc(50%+130px)] below-mid:left-[calc(50%+24px)] top-1/2 z-50 flex max-h-[calc(100dvh-32px)] w-[calc(100%-80px)] max-w-[620px] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-[10px] border border-line bg-paper p-6 text-xs shadow-lg outline-none",
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
export function DialogHeader(props: React.ComponentProps<"div">) {
  return <div className="flex flex-col gap-1" {...props} />;
}
export function DialogFooter(props: React.ComponentProps<"div">) {
  return (
    <div
      className="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-3"
      {...props}
    />
  );
}
export function DialogTitle(
  props: React.ComponentProps<typeof DialogPrimitive.Title>,
) {
  return <DialogPrimitive.Title className="text-sm font-semibold" {...props} />;
}
export function DialogDescription(
  props: React.ComponentProps<typeof DialogPrimitive.Description>,
) {
  return (
    <DialogPrimitive.Description
      className="break-words text-xs text-muted"
      {...props}
    />
  );
}
