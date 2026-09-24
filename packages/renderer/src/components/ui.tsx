import { useEffect, useRef, type ButtonHTMLAttributes, type ComponentPropsWithRef, type ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  // `danger` is the prototype's `.btn.danger{color:#ad4545;border-color:#ead0d0}`
  // — the destructive entry in the management dialogs ([UI 对齐 08] #32).
  variant?: "default" | "primary" | "ghost" | "danger";
  size?: "md" | "sm";
};

export function Button({ variant = "default", size = "md", className = "", ...rest }: ButtonProps) {
  const classes = [
    "inline-flex items-center gap-1.5 rounded-md border transition-colors",
    size === "sm" ? "px-2.5 py-1 text-xs" : "px-3.5 py-1.5 text-sm",
    variant === "primary"
      ? "border-accent bg-accent text-white hover:bg-accent/90"
      : variant === "ghost"
        ? "border-transparent text-muted hover:bg-soft hover:text-ink"
        : variant === "danger"
          ? "border-[#ead0d0] bg-paper text-[#ad4545] hover:bg-[#fdf3f3]"
          : "border-line bg-paper text-ink hover:border-accent/40 hover:bg-soft",
    // A disabled button must look disabled: the task header keeps the
    // prototype's `toggle-run` visible when a task has no local service, and a
    // primary-looking button that ignores clicks reads as broken (#27 review
    // note). Same wording as the local `disabled:` styles elsewhere.
    "disabled:cursor-not-allowed disabled:opacity-50",
    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
    className,
  ].join(" ");
  return <button type="button" className={classes} {...rest} />;
}

/**
 * Square icon action ([UI 对齐 03] #27): the prototype's `.iconbtn`
 * (`28px`, `place-items:center`, `6px` radius, hover `#e9eded`, `.selected`
 * uses the soft accent). `aria-label` is the accessible name; `title` carries
 * the longer action wording when the two differ. `ref` arrives as a plain prop
 * (React 19) and is spread onto the button, so callers can manage focus.
 * `aria-pressed` is emitted only when the caller passes `selected`: a toggle
 * (tool launcher, Subagent rail) needs it, while a menu trigger must not
 * announce itself as a toggle next to `aria-haspopup` ([UI 对齐 03] #27 review
 * note).
 */
export function IconButton({
  icon,
  label,
  title,
  selected,
  className = "",
  ...rest
}: ComponentPropsWithRef<"button"> & {
  icon: IconName;
  label: string;
  title?: string;
  selected?: boolean;
}) {
  const classes = [
    "inline-grid h-7 w-7 shrink-0 place-items-center rounded-md transition-colors",
    selected ? "bg-accent/10 text-accent" : "text-[#7c879b] hover:bg-soft hover:text-ink",
    // A disabled icon button has to look disabled instead of hoverable; the
    // composer's `+` is disabled in a read-only session ([UI 对齐 06] #30).
    "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent",
    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
    className,
  ].join(" ");
  return (
    <button
      type="button"
      aria-label={label}
      title={title ?? label}
      {...(selected === undefined ? {} : { "aria-pressed": selected })}
      className={classes}
      {...rest}
    >
      <Icon name={icon} />
    </button>
  );
}

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "accent" | "warn" }) {
  const tones = {
    neutral: "border-line bg-soft text-muted",
    accent: "border-accent/25 bg-accent/10 text-accent",
    warn: "border-orange/35 bg-orange/10 text-orange",
  } as const;
  return (
    // `whitespace-nowrap`: a squeezed tab strip must not wrap a CJK badge onto a
    // second line and grow the 32px session row ([UI 对齐 03] #27 review note).
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] leading-4 whitespace-nowrap ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function Panel({
  title,
  actions,
  children,
  className = "",
}: {
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-panel border border-line bg-paper ${className}`}>
      {title ? (
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
          <h2 className="text-sm font-medium text-ink">{title}</h2>
          {actions}
        </header>
      ) : null}
      <div className="px-4 py-3.5">{children}</div>
    </section>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="flex flex-col gap-1.5 text-xs text-muted">
      <span>{label}</span>
      {children}
      {hint ? <span className="text-[11px] text-muted/80">{hint}</span> : null}
    </label>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  return (
    <div role="tablist" aria-label={ariaLabel} className="inline-flex rounded-md border border-line bg-soft p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={value === option.value}
          onClick={() => onChange(option.value)}
          className={`rounded px-2.5 py-1 text-xs ${
            value === option.value ? "bg-paper text-ink shadow-sm" : "text-muted hover:text-ink"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Modal({
  title,
  children,
  footer,
  onClose,
}: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
}) {
  // Esc closes the dialog (the backdrop click already does); the handler lives
  // on the document so it also works while a picker input has focus. The
  // control that opened the dialog takes focus back when it closes ([UI 对齐 06]
  // #30): the composer popovers are opened from the button row, and a dialog
  // that drops focus on the floor loses the keyboard user's place.
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      const element = opener.current;
      if (element && document.contains(element)) element.focus();
    };
  }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-ink/25 p-4" role="presentation" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        // Prototype `.modal{width:min(660px,100%);border-radius:13px}`
        // ([UI 对齐 08] #32): every management dialog is that wide, so the
        // resolved-config table and the project list have room to line up.
        className="w-full max-w-[660px] rounded-panel border border-line bg-paper shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 className="text-sm font-medium">{title}</h2>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="关闭">
            关闭
          </Button>
        </header>
        <div className="max-h-[70vh] overflow-auto px-5 py-4 text-sm">{children}</div>
        {footer ? <footer className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</footer> : null}
      </div>
    </div>
  );
}

export function ToastStack({ toasts, onDismiss }: { toasts: { id: string; text: string }[]; onDismiss: (id: string) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div className="fixed bottom-5 left-1/2 z-40 flex -translate-x-1/2 flex-col gap-2" role="status">
      {toasts.map((toast) => (
        <button
          key={toast.id}
          type="button"
          onClick={() => onDismiss(toast.id)}
          className="rounded-md border border-line bg-paper px-4 py-2 text-xs text-ink shadow-lg"
        >
          {toast.text}
        </button>
      ))}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="rounded-md border border-dashed border-line px-4 py-6 text-center text-xs text-muted">{children}</p>;
}

/**
 * The product's brand mark. One spelling for the concept: the sidebar and the
 * conversation's agent row both render it, at the two sizes the prototype uses
 * (`style.css` `.brand .brandmark` 29px, `.message-head .brandmark` 22px).
 */
export function BrandMark({ size = "md" }: { size?: "md" | "sm" }) {
  // Prototype `.message-head .brandmark{width:22px;height:22px;font-size:18px;border-radius:6px}`.
  const box = size === "sm" ? "h-[22px] w-[22px] rounded-md text-[18px]" : "h-9 w-9 rounded-full text-base";
  return (
    <span
      aria-hidden
      data-testid={size === "sm" ? "message-brandmark" : "brand-mark"}
      className={`grid shrink-0 place-items-center border border-line bg-paper text-accent ${box}`}
    >
      π
    </span>
  );
}

/**
 * Local-user avatar (the prototype's `.avatar`). This app has no account name:
 * the identity it does have is the local workspace, so the mark spells that out
 * in one character instead of inventing initials.
 */
export function LocalUserAvatar() {
  return (
    <span
      aria-hidden
      data-testid="message-avatar"
      title="本机工作区"
      className="grid h-[25px] w-[25px] shrink-0 place-items-center rounded-full bg-[#e3e4e5] text-[10px] text-accent"
    >
      本
    </span>
  );
}

export function KeyValue({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[minmax(90px,auto)_1fr] gap-x-4 gap-y-2 text-xs">
      {rows.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="text-muted">{key}</dt>
          <dd className="text-ink">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
