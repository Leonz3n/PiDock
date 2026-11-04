import { useCallback, useEffect, useRef, type KeyboardEvent, type RefObject } from "react";

const FOCUSABLE = "button:not(:disabled), [href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex='-1'])";

/** Keep modal focus owned while open, using live component-specific targets. */
export function useDialogFocus(open: boolean, dialogRef: RefObject<HTMLDivElement | null>, preferredFocus: () => HTMLElement | null | undefined) {
  const preferredRef = useRef(preferredFocus);
  preferredRef.current = preferredFocus;
  const focusInside = useCallback(() => {
    const dialog = dialogRef.current;
    const preferred = preferredRef.current();
    const target = preferred?.isConnected && dialog?.contains(preferred) && !preferred.matches(":disabled") ? preferred : dialog;
    target?.focus();
  }, [dialogRef]);
  const focusRef = useRef(focusInside);
  focusRef.current = focusInside;
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    focusRef.current();
    const containFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialogRef.current?.contains(event.target)) focusRef.current();
    };
    document.addEventListener("focusin", containFocus);
    return () => {
      document.removeEventListener("focusin", containFocus);
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [open, dialogRef]);

  const trap = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
    if (!focusable?.length) { event.preventDefault(); dialogRef.current?.focus(); return; }
    const first = focusable[0]!, last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  return { focusInside, trap };
}
