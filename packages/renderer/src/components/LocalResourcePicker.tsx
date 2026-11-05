import { useEffect, useRef, useState } from "react";
import { shellBridge, type PidockBridge } from "../data/shellBridge";
import { Button } from "./ui/button";

/** Native selection changes a draft only; the owning form still saves explicitly. */
export function LocalResourcePicker({ kind, label, onSelect, disabled = false, bridge, onBusy }: {
  kind: "directory" | "executable";
  label: string;
  onSelect: (path: string) => void;
  disabled?: boolean;
  bridge?: PidockBridge;
  onBusy?: (busy: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const pending = useRef(false);
  const restoreFocus = useRef(false);
  const button = useRef<HTMLButtonElement>(null);
  const reportBusy = useRef(onBusy);
  reportBusy.current = onBusy;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; if (pending.current) reportBusy.current?.(false); }; }, []);
  // Native dialogs can temporarily hide the document. Restore after React
  // re-enables the owner fieldset; hidden documents need no animation frame.
  useEffect(() => {
    if (busy || disabled || !restoreFocus.current) return;
    const target = button.current;
    if (target?.isConnected && !target.matches(":disabled")) { target.focus(); restoreFocus.current = false; }
  }, [busy, disabled]);
  const select = async () => {
    if (pending.current || disabled) return;
    pending.current = true;
    setBusy(true); onBusy?.(true); setError("");
    // Capture the row/form owner at invocation. Unmount discards late replies.
    const apply = onSelect;
    try {
      const api = bridge ?? shellBridge();
      if (!api?.pickLocalResource) throw Error("当前桌面资源选择接口不可用，请重启应用");
      const result = await api.pickLocalResource({ kind });
      if (!mounted.current) return;
      if (!result?.ok) throw Error(result?.error ?? "资源选择失败，请重试");
      if (result.payload?.canceled === true) return;
      const path = result.payload?.path;
      if (result.payload?.canceled !== false || typeof path !== "string" || !/^(?:\/|[A-Za-z]:[\\/])/.test(path)) throw Error("资源选择返回异常，请重试");
      apply(path);
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : "资源选择失败，请重试");
    } finally {
      pending.current = false;
      if (mounted.current) { restoreFocus.current = true; setBusy(false); onBusy?.(false); }
    }
  };
  return <span className="inline-flex flex-wrap items-center gap-1">
    <Button type="button" size="sm" variant="outline" ref={button} disabled={disabled || busy} onClick={() => void select()} aria-label={label} aria-busy={busy}>{busy ? "选择中…" : label}</Button>
    {error ? <span role="alert" className="text-xs text-destructive">{error}</span> : null}
  </span>;
}
