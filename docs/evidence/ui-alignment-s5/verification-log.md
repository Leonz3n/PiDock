# S5 右侧工具面板 — 验证记录（[UI 对齐 04] #28）

提交：见 `git log -1`（本地，未 push）。基线 `3b04919`；本轮为评审修复轮（P2-1…P2-6），落在 `63711d5` 之上。

## 1. 验收矩阵

| # | 验收项 | 结论 | 证据 |
| --- | --- | --- | --- |
| 1 | 工具区结构：顶部标签条（每个已打开工具一个标签 + 独立关闭按钮 `aria-label="关闭<名称>"`），同一时刻只渲染激活面板；标签键盘可操作、激活态有可断言语义 | COVERED | `components/ToolPanels.tsx` `ToolWorkbench`（`role="tablist"`/`role="tab"`/`aria-selected`/`aria-controls="tool-panel"`/roving `tabindex`）；「收起工具区」在 tablist **之外**（`tool-rail.json` 三档 `collapseInsideTablist=false`，修复轮 P2-4）；`tool-rail.json` 三档 `tabs` 明细（如 `1440x900-tabs`：3 标签，激活 `文件`，另两个 `tabIndex=-1`）；用例 `taskToolRailFlow.test.tsx` ①⑤ |
| 2 | 右上角「收起工具区」一键关闭全部已打开工具 | COVERED | `ToolWorkbench` `collapse-tools`（`aria-label="收起工具区"`）；用例④（关闭后 `task-rail` 消失、工具条 `aria-pressed` 全部回 false）；原型 `.collapse-tools` 同名 |
| 3 | 无已打开工具时工具区不渲染，对话占满 | COVERED | `tool-rail.json` 各档 `-closed`：`railPresent=false`，对话列宽 1146/986/764（= 该档任务体全宽）；用例④；`responsiveLayout`/`workspaceFilesFlow` 既有断言保留 |
| 4 | 关闭标签不停止服务、不销毁浏览器状态、不结束终端 | COVERED | 用例③：先启动全部本地服务、启动终端实例、接管浏览器并打开三个标签，再关掉终端标签；断言 `task("release").services` 运行态逐项相同（且仍有 `:true`）、`browserPages` JSON 相同、`terminalState("release")` JSON 相同、`browserTakeover["release"]` 相同 |
| 5 | 头部图标工具条与标签激活态三向同步 | COVERED | 用例②：头部打开→`aria-pressed=true`；标签关闭→回 `false` 且 rail 消失；再开两个面板后切标签，两个工具条按钮都保持 `true` |
| 6 | 服务行按原型：状态点 + 名称 + 端点 + 本地/远程切换 + 启停；分组标题「本地运行」「远程依赖」；`routebox` 请求去向链 | COVERED | `tool-rail.json` `1440x900-runtime.serviceGroups`：local=5 / remote=2，routeBox = `请求去向 · 测试环境 saas-web → saas-bff → invoice-service ⇄ shipment-service · 远程 account-service、Redis / PostgreSQL`（原型 `.routebox` 形态；环境名用显示名而非环境 id，修复轮 P2-1）；行文案 `127.0.0.1:5173 · 运行中` / `测试环境 · 共享` / `准备步骤 · 本机命令`；用例⑥ |
| 7 | 修 #27 评审 P2-A：≤1180/≤960 档不得名称溢出贴合徽标、地址被压到 0 宽且无兜底；截断时完整信息可经 `title` 取得；1280/1024 截图必须看到端点（有断言） | COVERED | 端点 span 不收缩（`shrink-0`）、实例地址换行后 `truncate`；`tool-rail.json` 三档 `-runtime` 均 **endpointsVisible = 7/7**（含 1024 档 rail 310px），每行 `title` 含 `名称 · 端点 · 实例地址`（如 `saas-web · 127.0.0.1:5173 · 运行中 · release/release-service-1@5173`）；截图 `renderer/{1440,1280,1024}-runtime.png`；**类名契约断言**（修复轮 P2-2，见 §2.1）在 `taskToolRailFlow.test.tsx` ⑥（`service-endpoint-*` 含 `shrink-0`、`service-instance-*` 含 `truncate`）与 `serviceTopologyFlow.test.tsx`（端点文本 + `title` 含实例地址） |
| 8 | 浏览器面板按原型：所有权行 + 接管/交还；只读禁用并提示；验证记录 与 snapshot | COVERED | `tool-rail.json` `*-browser.browser`：`ownerText="Agent 可控制 · 当前空闲 接管浏览器"`（与原型逐字一致）、`validationHeading=["验证记录"]`、`snapshot` 含页面 URL + 任务 + 桥路由说明；`browserPanel.test.tsx` 断言接管后 `你正在操作 · Agent 已暂停` + `交还 Agent`，只读下按钮 `disabled` + `title` 说明 |
| 9 | 工具区宽度保持原型 43% / min 350px，S0 的 1180/960/720 降级档不变 | COVERED | `railClass` 未改（`responsiveLayout.test.tsx` 与 `taskHeaderFlow.test.tsx` 的 43%/min350/`below-*` 断言全绿）；实测 493 / 424 / 310（1440/1280/1024），原型同为 43% 但基于 `.main` 内宽（522），差异为 S0 既有几何（记录见 §3） |
| 10 | 新增用例覆盖标签开/关/切换、收起、关闭不副作用、切标签保留面板内状态、服务行分组与模式切换、浏览器接管/交还、只读禁用 | COVERED | 新增 `test/taskToolRailFlow.test.tsx`（7 例，含修复轮新增的「keeps panel-local state when the active tab is swapped」）、`test/toolRail.test.ts`（2 例）、`serviceTopology.test.ts` 追加 `serviceRouteView` 1 例；另更新既有 4 处选择器（见 §2） |
| 11 | 证据提交进 `docs/evidence/ui-alignment-s5/`（1440/1280/1024 截图 + 几何 JSON + 本日志） | COVERED | 本目录：`renderer/{1440,1280,1024}-{tabs,runtime,browser,closed}.png`（12 张）、`prototype/1440-prototype-A-rail.png`、`prototype/1440-prototype-A-browser.png`、`tool-rail.json`、`capture-tool-rail.mjs`（输出写回本目录，可重跑） |
| 12 | 既有用例零回归；`pnpm turbo run typecheck test build lint --force` 全绿 | COVERED | renderer **48 文件 / 405 例**（切片前 46/395；`63711d5` 为 48/404，修复轮新增 1 例）；shell 54/801；turbo 8/8（见 §2） |

## 2. 门禁与既有用例改动

```
pnpm turbo run typecheck test build lint --force
@pidock/shell:test:   54 files / 801 tests passed
@pidock/renderer:test: 48 files / 404 tests passed
Tasks: 8 successful, 8 total
```

构建体积：renderer `index` chunk 613.75 kB（gzip 186.04）。Vite 的 >500 kB 提示为**既有**现象——同一命令在基线 `3b04919` 上实测 `index` chunk 606.46 kB，本切片 +7.3 kB。

既有用例的 4 处选择器随**原型文案/结构**更新（断言强度不变或更强）：

| 文件 | 改动 | 原因 |
| --- | --- | --- |
| `serviceTopologyFlow.test.tsx` | `{ name: "停止" }` → `{ name: "停止 saas-web" }`；新增断言行含 `127.0.0.1:5173 · 运行中` 与 `title` 含实例地址 | 启停改为原型的图标按钮（可访问名带服务名），并顺带锁定 P2-A 的两条要求 |
| `restoredFlows.test.tsx` | `/^(启动\|停止)$/` → `/^(启动\|停止) /` | 同上 |
| `workspaceFilesFlow.test.tsx` | `{ name: "收起" }` → `{ name: "收起工具区" }`，并新增「关闭最后一个标签后 rail 消失」断言 | 每个面板各自的「收起」被原型的单一「收起工具区」取代 |
| `browserPanel.test.tsx` / `shellNavigation.test.tsx` | `人工接管` → `接管浏览器`；只读用例新增 disabled + `title` 断言 | 原型 `browser-owner` 文案 |

`test/helpers.tsx` 的 store 复位新增 `activePanel: {}`（新状态字段），修复轮再加 `toolPanelState: {}`。

## 2.1 评审修复轮（P2-1…P2-6，[#28](https://github.com/Leonz3n/PiDock/issues/28) 评审）

| 评审项 | 修法 | 文件 | 证据 |
| --- | --- | --- | --- |
| **P2-1** routebox 打印环境 id | 运行面板改收 `environments` 并由 `environmentLabel` 取显示名（与仓库既有约定一致），同时用于 fallback 投影与 `serviceRouteView` | `components/ToolPanels.tsx`（`RuntimePanel`）、`pages/TaskPage.tsx`（`environments` 选择器） | `tool-rail.json` 三档 `routeBox` 首段 = 「请求去向 · 测试环境」；断言 `taskToolRailFlow.test.tsx` ⑥ |
| **P2-2** P2-A 只有 out-of-band 护栏 | 补类名契约断言（jsdom 无布局 → 断类名，仓库既有做法） | `test/taskToolRailFlow.test.tsx` ⑥ | `service-endpoint-*` 含 `shrink-0`、`service-instance-*` 含 `truncate` |
| **P2-3** 切标签卸载面板 → 面板内局部状态丢失 | 新增 `stores/ui.ts` `toolPanelState`（按 taskId 合并 patch，`data/toolRail.ts` 提供类型与 `mergeToolPanelState`）；浏览器面板的页码/标记/标注/证据/提示、终端面板的回显/输入、运行面板的选中服务都改为读写该 store（原型把这类状态放在全局 `state`） | `data/toolRail.ts`、`stores/ui.ts`、`components/ToolPanels.tsx`、`pages/TaskPage.tsx` | 新用例「keeps panel-local state when the active tab is swapped」：浏览器切到第 2 页 + 标注文字、终端输入 `pnpm test`、运行面板选中 `saas-bff` → 三次切标签后各自状态仍在。**反向验证**：把 `pageId`/终端 `value` 临时改回 `useState` 后该用例失败（`1 failed | 6 passed`），改回 store 后通过 |
| **P2-4** tablist 内含非 tab 子元素 | 「收起工具区」移出 `role="tablist"`（外套一层 flex 行，视觉位置不变） | `components/ToolPanels.tsx` | `tool-rail.json` 三档 `collapseInsideTablist=false`；断言 `within(tool-tabs).queryByTestId("collapse-tools")` 为 null + `closest('[role="tablist"]')` 为 null |
| **P2-6** 过期测试标题 | 标题改为「expands the request route box from the declared call graph and names the remote units」 | `test/serviceTopology.test.ts` | 与同处注释/断言一致 |
| **P2-5** 监督方补跑 | 本环境已跑 `pnpm --filter @pidock/renderer test`（48/405）与 `pnpm turbo run typecheck test build lint --force`（8/8；shell 54/801） | — | 见 §2；`git show --stat` 提交清单见提交信息 |

`capture-tool-rail.mjs` 增加 `collapseInsideTablist` 字段，使 P2-4 也进入可重跑的几何证据。

## 3. 未测 / 未做（不得当作已完成）

1. **未在 Electron 打包运行时验证**：几何与截图全部来自 4335 dev server + headless Chromium；本环境 GUI 重启被 OS 级模态对话框挡住（同 S2 记录）。
2. **键盘路径只在 jsdom 验证**：方向键/Home/End/Enter/Space 的断言在 vitest；`capture-tool-rail.mjs` 未做真实按键录制。
3. **子代理面板仍与工具区共享同一栏**：`SubagentPanel` 不是工具标签之一（原型的 `.subagent-sidebar` 亦独立）；其标签化/溢出属 S3（会话与执行状态）。
4. **协议工具**：原型 `toolItems` 无「协议」，本仓多一个工具标签（既有能力，未删除）。
5. **宽度几何差异**：本仓 rail = 任务体内宽 43%（1440 下 493px），原型 = `.main` 宽 43%（522px）。属 S0 已交付的既有几何，本切片按验收要求未改比例。
6. **服务行信息**：≤1180 档实例地址换行后截断（端点始终完整可见），完整身份在行 `title` 中；未做「点击展开完整地址」交互。
7. **浏览器 snapshot 不声明 Cookie/本地存储归属**：仅列页面实例 URL、任务与桥路由说明；原型的「Cookie / 本地存储：仅属于 …」在渲染层没有可引用的事实来源，未照抄。
8. 工具面板内容（文件/终端/日志/协议面板内部）沿用既有实现，仅结构位置改为「一次一个」；面板内部改版不属本切片。
9. **仍按面板局部状态放置的项**（修复轮 P2-3 未提升的）：`DirectoryTerminalPanel`/`DirectoryFilesPanel` 的目录选择 `localId`（受控场景下由 `TaskPage` 的 `activeDirectoryId` 驱动，不受影响）；终端面板的 `seed` 仅在 store 尚无回显时生效（用户执行过命令后以 store 为准）。
10. **原型 `services()` 顶部「代码工作副本 + 配置」块未实现**（#28 验收未列此块；仓库文件面板另处已提供仓库/工作目录信息）——如需逐字对齐原型可开后续工单。
11. **修复轮的 4 条 ARIA/文案断言只在 jsdom 验证**，几何侧只覆盖 `collapseInsideTablist`（真实按键与 AT 播报未测）。

## 4. 复跑

```bash
export PATH="/private/tmp/pidock-pnpm/node_modules/.bin:$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
# 需要 4335（renderer dev）与 4319（原型 A）
node docs/evidence/ui-alignment-s5/capture-tool-rail.mjs
pnpm --filter @pidock/renderer test
pnpm turbo run typecheck test build lint --force
```
