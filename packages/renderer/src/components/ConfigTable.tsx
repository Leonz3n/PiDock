import type { ReactNode } from "react";
import type { ResolvedConfigEntry } from "../data/types";
import { Table, TableWrap, Td, Th } from "./Management";

/**
 * Shared read-only KEY / VALUE / 来源 table used by the environment page's
 * 查看生效配置 dialog ([UI 对齐 08] #32) and the runtime tool panel, so both
 * views of the effective config stay identical. The 来源 column is what makes
 * each row report which layer it came from.
 *
 * The box and the cell padding are the prototype's `.table-wrap` / `.table`
 * (`prototypes/pidock-ui/style.css`), which is why it draws on the management
 * page primitives rather than carrying its own copy of those numbers.
 */
export function ConfigTable({
  rows,
  valueHeader = "VALUE",
}: {
  rows: ResolvedConfigEntry[];
  valueHeader?: ReactNode;
}) {
  return (
    <TableWrap>
      <Table>
        <thead>
          <tr>
            <Th>KEY</Th>
            <Th>{valueHeader}</Th>
            <Th>来源</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <Td className="font-mono text-[10px]">{row.key}</Td>
              <Td>{row.secret ? "••••••••" : row.value}</Td>
              <Td className="text-muted">{row.source}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </TableWrap>
  );
}
