import type { ReactNode } from "react";
import type { ResolvedConfigEntry } from "../data/types";

/**
 * Shared read-only KEY / VALUE / 来源 table used by the environment page and
 * the runtime tool panel, so both views of the effective config stay identical.
 * The 来源 column is what makes each row report which layer it came from.
 */
export function ConfigTable({
  rows,
  valueHeader = "VALUE",
}: {
  rows: ResolvedConfigEntry[];
  valueHeader?: ReactNode;
}) {
  return (
    <table className="w-full text-xs">
      <thead className="text-left text-muted">
        <tr>
          <th className="pb-1.5">KEY</th>
          <th className="pb-1.5">{valueHeader}</th>
          <th className="pb-1.5">来源</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key} className="border-t border-line">
            <td className="py-1.5 pr-2 font-mono text-[11px]">{row.key}</td>
            <td className="py-1.5 pr-2">{row.secret ? "••••••••" : row.value}</td>
            <td className="py-1.5 text-muted">{row.source}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
