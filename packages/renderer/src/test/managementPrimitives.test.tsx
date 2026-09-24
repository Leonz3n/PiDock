import { render, screen } from "@testing-library/react";
import { Button } from "../components/ui";
import {
  Card,
  CardGrid,
  CardStack,
  CheckRow,
  InlineNotice,
  ManagementList,
  ManagementRow,
  Note,
  PageEmpty,
  PageIntro,
  PreviewNote,
  StatCard,
  Table,
  TableWrap,
  TabRow,
  Td,
  Th,
  ViewLabel,
} from "../components/Management";

/**
 * The management-page primitives are a geometry contract against prototype A
 * (`prototypes/pidock-ui/style.css`). jsdom has no layout, so the contract is
 * asserted on the Tailwind classes that carry the prototype's numbers: a class
 * that drifts (or is dropped) fails here, and the same class list is what the
 * headless-Chromium evidence measures at real viewport widths
 * (`docs/evidence/ui-alignment-s7a/capture-management.mjs`).
 *
 * The tier classes are the prototype's own boundaries — `below-wide` is
 * `(max-width:1180px)`, `below-mid` is `(max-width:960px)`, `below-stack` is
 * `(max-width:720px)` — never Tailwind's default 640/768/1024/1280 scale.
 */
describe("management page primitives", () => {
  it("carries the prototype's view label and page intro type", () => {
    render(
      <>
        <ViewLabel>PROJECT</ViewLabel>
        <PageIntro>在项目中组织仓库、任务与运行环境。</PageIntro>
      </>,
    );
    const label = screen.getByText("PROJECT");
    // `.view-label{font-size:10px;color:#95979c;text-transform:uppercase;letter-spacing:1.8px;margin-bottom:6px}`
    expect(label.className).toContain("text-[10px]");
    expect(label.className).toContain("tracking-[1.8px]");
    expect(label.className).toContain("uppercase");
    expect(label.className).toContain("text-[#95979c]");
    expect(label.className).toContain("mb-1.5");
    // `.page-intro{margin:6px 0 26px;color:#8a8c92;font-size:12px}`
    const intro = screen.getByText("在项目中组织仓库、任务与运行环境。");
    expect(intro.className).toContain("mt-1.5");
    expect(intro.className).toContain("mb-[26px]");
    expect(intro.className).toContain("text-[12px]");
    expect(intro.className).toContain("text-[#8a8c92]");
  });

  it("keeps the prototype card box and its 16px stacking rhythm", () => {
    render(
      <CardStack>
        <Card>第一张</Card>
        <Card>第二张</Card>
      </CardStack>,
    );
    // `.card{background:white;border:1px solid var(--line);border-radius:10px;padding:20px}`
    const card = screen.getByText("第一张");
    expect(card.className).toContain("p-5");
    expect(card.className).toContain("rounded-panel");
    expect(card.className).toContain("bg-paper");
    expect(card.className).toContain("border-line");
    // `.card+.card{margin-top:16px}`
    expect(card.parentElement!.className).toContain("gap-4");
  });

  it("degrades the card grids at the prototype's tiers", () => {
    const { unmount } = render(
      <>
        <CardGrid cols={2}>g2</CardGrid>
        <CardGrid cols={3}>g3</CardGrid>
        <CardGrid cols={4}>g4</CardGrid>
      </>,
    );
    // `.grid2{1fr 1fr}` → `≤720 1fr`
    expect(screen.getByText("g2").className).toContain("grid-cols-2");
    expect(screen.getByText("g2").className).toContain("below-stack:grid-cols-1");
    // `.grid3{repeat(3,1fr)}` → `≤960 1fr`
    expect(screen.getByText("g3").className).toContain("grid-cols-3");
    expect(screen.getByText("g3").className).toContain("below-mid:grid-cols-1");
    // `.grid4{repeat(4,1fr)}` → `≤1180 repeat(2,1fr)`
    expect(screen.getByText("g4").className).toContain("grid-cols-4");
    expect(screen.getByText("g4").className).toContain("below-wide:grid-cols-2");
    for (const text of ["g2", "g3", "g4"]) expect(screen.getByText(text).className).toContain("gap-4");
    unmount();
  });

  it("renders the stat card with the prototype's 28px figure", () => {
    render(<StatCard label="进行中的任务" value={3} />);
    const figure = screen.getByText("3");
    // `.stat{font-size:28px;font-weight:550;letter-spacing:-1px;margin-top:9px}`
    expect(figure.className).toContain("text-[28px]");
    expect(figure.className).toContain("tracking-[-1px]");
    expect(figure.className).toContain("mt-[9px]");
    expect(screen.getByText("进行中的任务").className).toContain("text-[11px]");
  });

  it("renders the notice, preview note and page-empty block with prototype spacing", () => {
    render(
      <>
        <InlineNotice>还有 2 个关联任务</InlineNotice>
        <PreviewNote>此操作仅演示删除范围</PreviewNote>
        <PageEmpty title="创建第一个项目" actions={<button type="button">新建项目</button>}>
          项目用于组织仓库、任务与运行环境。
        </PageEmpty>
        <Note>只有已保存的配置参与解析</Note>
      </>,
    );
    // `.inline-notice{border:1px solid #e7e2d5;background:#fbf9f2;color:#948257;padding:10px 13px;border-radius:7px;font-size:11px;margin-bottom:19px}`
    const notice = screen.getByText("还有 2 个关联任务").className;
    expect(notice).toContain("border-[#e7e2d5]");
    expect(notice).toContain("bg-[#fbf9f2]");
    expect(notice).toContain("text-[#948257]");
    expect(notice).toContain("px-[13px]");
    expect(notice).toContain("rounded-[7px]");
    expect(notice).toContain("mb-[19px]");
    // `.preview-note{padding:12px;background:#f4f5f7;border-radius:8px;font-size:11px;color:#7f8288;margin-top:15px}`
    const preview = screen.getByText("此操作仅演示删除范围").className;
    expect(preview).toContain("bg-[#f4f5f7]");
    expect(preview).toContain("p-3");
    expect(preview).toContain("rounded-lg");
    expect(preview).toContain("mt-[15px]");
    // `.empty{padding:40px;text-align:center;color:#8d8f95;font-size:12px}`
    const empty = screen.getByText("创建第一个项目").parentElement!.className;
    expect(empty).toContain("py-10");
    expect(empty).toContain("text-center");
    expect(empty).toContain("text-[#8d8f95]");
    expect(screen.getByText("项目用于组织仓库、任务与运行环境。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新建项目" })).toBeInTheDocument();
    // `.note{font-size:10px;color:#939c9f;line-height:1.9;margin-top:11px}`
    const note = screen.getByText("只有已保存的配置参与解析").className;
    expect(note).toContain("text-[10px]");
    expect(note).toContain("text-[#939c9f]");
    expect(note).toContain("mt-[11px]");
  });

  it("renders the prototype's check row and management list rows", () => {
    render(
      <>
        <CheckRow icon="folder" title="invoice-service" detail="本机已注册 · 基线 main" />
        <ManagementList>
          <ManagementRow>
            <span>Atlas Web</span>
            <span>操作</span>
          </ManagementRow>
        </ManagementList>
      </>,
    );
    // `.check-row{display:flex;gap:10px;align-items:center;padding:11px 0;border-bottom:1px solid var(--line);font-size:12px}`
    const row = screen.getByText("invoice-service").parentElement!;
    expect(row.className).toContain("py-[11px]");
    expect(row.className).toContain("border-b");
    expect(row.className).toContain("gap-2.5");
    expect(row.className).toContain("text-xs");
    // `.check-row>span{flex:1}`
    expect(screen.getByText("invoice-service").className).toContain("flex-1");
    // `.management-list{display:grid;gap:10px}` / `.management-row{…;gap:14px;padding:13px 0;border-bottom}`
    expect(screen.getByText("Atlas Web").parentElement!.className).toContain("gap-3.5");
    expect(screen.getByText("Atlas Web").parentElement!.className).toContain("py-[13px]");
    expect(screen.getByText("Atlas Web").parentElement!.parentElement!.className).toContain("gap-2.5");
  });

  it("renders the prototype's tab row and data table", () => {
    render(
      <>
        <TabRow
          ariaLabel="配置作用范围"
          value="shared"
          onChange={() => {}}
          items={[
            { value: "shared", label: "共享模板" },
            { value: "private", label: "本机私有配置" },
          ]}
        />
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <Th>KEY</Th>
                <Th>最终值</Th>
                <Th>来源</Th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <Td>PORT</Td>
                <Td>5173</Td>
                <Td>运行时端口绑定</Td>
              </tr>
            </tbody>
          </Table>
        </TableWrap>
      </>,
    );
    // `.tabs{display:flex;gap:20px;border-bottom:1px solid var(--line);margin-bottom:24px}`
    const tabs = screen.getByRole("tablist", { name: "配置作用范围" });
    expect(tabs.className).toContain("gap-5");
    expect(tabs.className).toContain("mb-6");
    const active = screen.getByRole("tab", { name: "共享模板" });
    expect(active.getAttribute("aria-selected")).toBe("true");
    expect(active.className).toContain("border-accent");
    // `.table-wrap{border:1px solid var(--line);border-radius:9px;overflow:auto;background:white}`
    const tableWrap = screen.getByText("KEY").closest("div")!;
    expect(tableWrap.className).toContain("rounded-[9px]");
    expect(tableWrap.className).toContain("border-line");
    expect(tableWrap.className).toContain("overflow-auto");
    // `.table th{font-size:10px;padding:11px 13px;background:#fafbfc}` / `td{padding:13px;border-bottom:1px solid #f0f0f1}`
    const th = screen.getByText("KEY");
    expect(th.className).toContain("text-[10px]");
    expect(th.className).toContain("px-[13px]");
    expect(th.className).toContain("bg-[#fafbfc]");
    const td = screen.getByText("5173");
    expect(td.className).toContain("px-[13px]");
    expect(td.className).toContain("border-[#f0f0f1]");
  });

  it("gives the destructive management entry the prototype's danger styling", () => {
    render(<Button variant="danger">删除</Button>);
    // `.btn.danger{color:#ad4545;border-color:#ead0d0}`
    const button = screen.getByRole("button", { name: "删除" });
    expect(button.className).toContain("text-[#ad4545]");
    expect(button.className).toContain("border-[#ead0d0]");
  });
});
