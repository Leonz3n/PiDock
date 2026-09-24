import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

/**
 * Management-page primitives ([UI 对齐 08] #32). One spelling per prototype
 * class so S7b's remaining pages inherit the same geometry instead of each
 * re-deriving it:
 *
 *   `.view-label`     → `ViewLabel`
 *   `.page-intro`     → `PageIntro`
 *   `.card`           → `Card` / `CardStack` (`+ .card{margin-top:16px}`)
 *   `.grid2/3/4`      → `CardGrid` (with the prototype's tier degradation)
 *   `.card` + `.stat` → `StatCard`
 *   `.inline-notice`  → `InlineNotice`
 *   `.empty`          → `PageEmpty`
 *   `.check-row`      → `CheckRow`
 *   `.tabs`           → `TabRow`
 *   `.table-wrap`/`.table` th/td → `TableWrap` / `Table` / `Th` / `Td`
 *   `.management-list`/`.management-row` → `ManagementList` / `ManagementRow`
 *   `.preview-note`   → `PreviewNote`
 *   `.formfield`      → the existing `Field` in `components/ui.tsx` (one field
 *                       component, not two spellings)
 *   `.toolbar-space`/`.rowgap`/`.note` → `mt-4` / `mb-[15px]` / the `Note`
 *                       helper below; plain Tailwind, no component needed.
 *
 * Page padding is not here: the prototype's `.page{padding:30px 34px}` (25px
 * below 960px, 20px below 720px) already lives on the page container in
 * `components/Shell.tsx`.
 *
 * Note `PageEmpty` is not `EmptyState` from `ui.tsx`: the latter is our dashed
 * inline box, `PageEmpty` is the prototype's `.empty` (40px padding, centered,
 * no border) used for a page or section that has nothing in it yet.
 */
export function ViewLabel({ children }: { children: ReactNode }) {
  return <div className="mb-1.5 text-[10px] tracking-[1.8px] text-[#95979c] uppercase">{children}</div>;
}

export function PageIntro({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <p className={`mt-1.5 mb-[26px] text-[12px] text-[#8a8c92] ${className}`}>{children}</p>;
}

export function Note({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <p className={`mt-[11px] text-[10px] leading-[1.9] text-[#939c9f] ${className}`}>{children}</p>;
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-panel border border-line bg-paper p-5 ${className}`}>{children}</div>;
}

/** The prototype's `.card + .card{margin-top:16px}`. */
export function CardStack({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`flex flex-col gap-4 ${className}`}>{children}</div>;
}

/**
 * `.grid2` stays two columns until 720px, `.grid3` collapses at 960px and
 * `.grid4` at 1180px — the prototype's own tier boundaries
 * (`style.css`), not Tailwind's default scale.
 */
export function CardGrid({ cols, children, className = "" }: { cols: 2 | 3 | 4; children: ReactNode; className?: string }) {
  const columns =
    cols === 2 ? "grid-cols-2 below-stack:grid-cols-1" : cols === 3 ? "grid-cols-3 below-mid:grid-cols-1" : "grid-cols-4 below-wide:grid-cols-2";
  return <div className={`grid gap-4 ${columns} ${className}`}>{children}</div>;
}

export function StatCard({ label, value, actions }: { label: string; value: ReactNode; actions?: ReactNode }) {
  return (
    <Card>
      <small className="text-[11px] text-muted">{label}</small>
      <div className="mt-[9px] text-[28px] font-[550] tracking-[-1px] text-ink">{value}</div>
      {actions ? <div className="mt-2">{actions}</div> : null}
    </Card>
  );
}

export function InlineNotice({ children }: { children: ReactNode }) {
  return (
    <div className="mb-[19px] rounded-[7px] border border-[#e7e2d5] bg-[#fbf9f2] px-[13px] py-2.5 text-[11px] text-[#948257]">
      {children}
    </div>
  );
}

export function PreviewNote({ children }: { children: ReactNode }) {
  return <p className="mt-[15px] rounded-lg bg-[#f4f5f7] p-3 text-[11px] leading-[1.85] text-[#7f8288]">{children}</p>;
}

export function PageEmpty({ title, children, actions }: { title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="px-10 py-10 text-center text-[12px] text-[#8d8f95]">
      <h3 className="text-[13px] font-[650] text-ink">{title}</h3>
      {children ? <p className="mt-1.5">{children}</p> : null}
      {actions ? <div className="mt-3.5 flex justify-center">{actions}</div> : null}
    </div>
  );
}

/** The prototype's `.check-row`: icon + title, muted detail, optional trailing control. */
export function CheckRow({
  icon,
  title,
  detail,
  trailing,
}: {
  icon?: IconName;
  title: ReactNode;
  detail?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2.5 border-b border-line py-[11px] text-xs">
      {icon ? <Icon name={icon} className="text-muted" /> : null}
      <span className="flex-1 min-w-0 truncate text-ink">{title}</span>
      {detail ? <small className="shrink-0 text-[11px] text-muted">{detail}</small> : null}
      {trailing}
    </div>
  );
}

export function TabRow<T extends string>({
  items,
  value,
  onChange,
  ariaLabel,
}: {
  items: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  return (
    <div role="tablist" aria-label={ariaLabel} className="mb-6 flex gap-5 border-b border-line">
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          role="tab"
          aria-selected={value === item.value}
          onClick={() => onChange(item.value)}
          className={`border-b-2 px-0.5 py-3 text-xs ${
            value === item.value ? "border-accent text-accent" : "border-transparent text-[#8c8e93] hover:text-ink"
          }`}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

export function TableWrap({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`overflow-auto rounded-[9px] border border-line bg-paper ${className}`}>{children}</div>;
}

export function Table({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <table className={`w-full border-collapse text-left text-[11px] ${className}`}>{children}</table>;
}

export function Th({ children, className = "" }: { children?: ReactNode; className?: string }) {
  return (
    <th className={`border-b border-line bg-[#fafbfc] px-[13px] py-[11px] text-[10px] font-medium text-[#96999e] ${className}`}>
      {children}
    </th>
  );
}

export function Td({ children, className = "" }: { children?: ReactNode; className?: string }) {
  return <td className={`border-b border-[#f0f0f1] px-[13px] py-[13px] align-middle ${className}`}>{children}</td>;
}

export function ManagementList({ children }: { children: ReactNode }) {
  return <div className="grid gap-2.5">{children}</div>;
}

export function ManagementRow({ children }: { children: ReactNode }) {
  return <div className="flex items-center justify-between gap-3.5 border-b border-line py-[13px]">{children}</div>;
}
