import type { ReactNode } from "react";

export type ConfigRow = { key: string; value: string; source: string; secret: boolean };

/**
 * Shared KEY / VALUE / 来源 table used by the environment page and the runtime
 * tool panel, so both read-only views of effective config stay identical.
 */
export function ConfigTable({ rows, valueHeader = "VALUE" }: { rows: ConfigRow[]; valueHeader?: ReactNode }) {
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
