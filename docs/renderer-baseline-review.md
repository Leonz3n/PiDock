# 渲染层基线评审（#3 / 原 20）

2026-09-22（复核修订：2026-09-22）。本记录覆盖渲染层基线（`packages/renderer`，`@pidock/renderer`）与静态草稿 `prototypes/pidock-ui/`（variant A 对话优先）的逐页对照、组件与许可证、状态职责边界、密集列表实测、锚点跟随验证与未测边界。

对照截图证据：[`docs/evidence/renderer-baseline-2026-09-22/`](evidence/renderer-baseline-2026-09-22/)（renderer 13 张 + prototype 9 张 + `measurements.json` + `anchor-follow-verification.json`）。原型只读保留，未修改。

> **上一版勘误。** 上一版把「本机设置」页面写成**有意收敛**（「渲染层去掉原型用于布局探索的重复/临时入口（如「本机设置」…）」）。这是**错误**：原型「本机设置」是 2026-09-20 经用户确认的页面，渲染层此前用一段静态 `<p>` 取代它属于**回退**，不是取舍。已按原型草稿复原该页面并接回导航，本节与下方对照表均已更正。

## 与草稿的逐页对照

渲染层 13 个可截图页面 vs 原型 9 张页面截图。下表逐一给出映射关系；原型侧没有独立页面的渲染层页面，均记明「有意新增」及理由，不存在把疏漏当作取舍的情况。

| # | 渲染层页面（路由） | 原型对照 | 结论与差异理由 |
| --- | --- | --- | --- |
| 1 | 需要处理 `/attention` | 无独立页；原型为「需要处理」模态（`prototypes/pidock-ui/closure.js` 的 `attentionDialog()`，经侧栏按钮注入） | **有意升级为独立页面**。收口规则要求跨项目汇总，作为可深链、可过滤的一等页面比一次性模态更适合持续处理；过滤器（全部/待确认/失败/过期/完成未读）为新增，理由是把原型中分散的判定集中在同一视图。 |
| 2 | 项目总览 `/projects/atlas` | `prototype/project.png` | **逐页对齐**。Hero、统计卡、继续工作任务卡与草稿一致；差异仅在于按渲染层栅格做了密度收紧，为有意为之。 |
| 3 | 任务页·主会话 `/projects/atlas/tasks/release?session=main` | `prototype/task-main.png` | **逐页对齐**。A 对话优先布局：任务导航常驻、对话占主区、工具面板按需打开。 |
| 4 | 任务页·部署审批会话（`?session=deploy`） | 原型同一任务页的会话切换态（草稿固定数量演示，未单独截图） | **有意拆为可截图状态**。用 `session` 查询参数把「执行状态与审批」收口规则固化为可复现路由，便于验收；属于证据粒度细化，不是新增产品行为。 |
| 5 | 任务页·失败现场（`?session=failed`） | 原型同一任务页的失败态 | **有意拆为可截图状态**。理由同上：把「失败保留草稿」收口规则做成可深链、可重复截图的证据。 |
| 6 | 环境与服务 `/env` | `prototype/env.png` | **逐页对齐**。共享模板 / 本机私有 / 任务覆盖的分层与生效来源展示一致。KEY/VALUE/来源表已抽成共享 `ConfigTable`，与运行面板同源。 |
| 7 | Provider 与上下文 `/providers` | `prototype/providers.png` | **逐页对齐**。同一供应商多配置、模型与上下文占用分开记录保持一致。 |
| 8 | Token 用量 `/usage` | `prototype/usage.png` | **逐页对齐并有意加强**。筛选与明细列对齐草稿；明细改用虚拟滚动（见下「密集场景实测」），理由是把原型的固定条数改为可扩展实现。 |
| 9 | 定时任务 `/schedules` | `prototype/schedules.png` | **逐页对齐并有意加强**。「执行记录」由普通 `<ul>` 改为虚拟滚动，并把固定 3 条改为 47 条密集数据（见下），理由同 Token 明细；结果标签修复为「完成/跳过/失败」。 |
| 10 | 能力管理 `/capabilities` | `prototype/capabilities.png` | **逐页对齐**。按 Skills / Extensions / Packages / MCP Servers 分类一致。 |
| 11 | 远程访问 `/remote` | `prototype/remote.png` | **逐页对齐**。主机主动连接、每设备独立撤销保持一致。 |
| 12 | 归档与清理 `/archive` | `prototype/archive.png` | **逐页对齐**。归档停止执行、恢复不自动启动、清理仅面向归档任务保持一致。 |
| 13 | 本机设置 `/settings` | 原型 `app.js` 的 `workspaceSettingsDialog()`（「本机设置」模态，经侧栏 folder 图标打开，2026-09-20 用户确认） | **逐页对齐（本轮复原）**。展示默认应用配置目录 `~/.pi/dock` 与配置文件 `~/.pi/dock/config.json`；可编辑默认任务根目录 `workspaceRoot`，保存提示「已有任务不迁移」。数据经 `HostAdapter.getLocalSettings/setWorkspaceRoot` 提供，属本机设置、不进入共享模板。原型为模态，渲染层为可深链页面——粒度细化，内容与决策点一致。 |

### 全局导航差异（更正）

- 渲染层侧栏（`packages/renderer/src/components/Shell.tsx`）现列出**九个**一级入口：需要处理 / 环境与服务 / Provider 与上下文 / Token 用量 / 定时任务 / 能力管理 / 远程访问 / 归档与清理 / **本机设置**。
- 原型侧栏标签另有「项目总览 / 任务列表 / 已归档 / 模型与 Provider」等入口，部分用于布局探索。「任务列表」在渲染层并入「项目与任务」分组与项目页；**「本机设置」不再属于被收敛项，已复原为一级入口**（上一版把它列为有意收敛是错误的）。
- 「需要处理」在原型是模态、在渲染层是页面（见上表 #1），故其入口从原型的一次性按钮变为常驻一级导航并带未读计数。

## 组件与库选择（含许可证）

运行时依赖（`packages/renderer/package.json`）：

| 组件 / 库 | 版本 | 许可证 | 用途 |
| --- | --- | --- | --- |
| React / React DOM | 19.3.0 | MIT | 渲染层视图框架 |
| Zustand | 5.0.15 | MIT | 界面状态与模拟 Host 投影缓存 |
| TanStack Virtual（`@tanstack/react-virtual`） | 3.14.13 | MIT | 长列表虚拟滚动 |
| Shiki | 4.4.3 | MIT | 代码片段高亮 |

构建与工具链：

| 组件 / 库 | 版本 | 许可证 | 用途 |
| --- | --- | --- | --- |
| Vite | 7.3.6 | MIT | 开发服务器与构建 |
| Tailwind CSS（含 `@tailwindcss/vite`） | 4.3.3 | MIT | 样式与设计令牌 |
| TypeScript | 5.9.3 | Apache-2.0 | 类型检查 |
| Vitest | 3.2.7 | MIT | 单元/组件测试 |
| jsdom | 27.4.0 | MIT | 测试 DOM 环境 |
| Testing Library（`@testing-library/react`、`jest-dom`、`user-event`） | 16.3.3 / 7.0.1 / 14.6.7 | MIT | 组件测试 |
| ESLint | 9.39.5 | MIT | 静态检查 |
| typescript-eslint / `@eslint/js` / `eslint-plugin-react-hooks` / `globals` | 8.70.1 / 9.39.5 / 7.1.1 / 17.12.0 | MIT | ESLint flat config 规则 |
| Turborepo | 2.11.2 | MPL-2.0 | 工作区任务编排 |
| pnpm | 11.22.0 | MIT | 包管理 |
| playwright-core（仅证据脚本，不进入产物） | 1.63.0 | Apache-2.0 | 截图、密集场景实测与锚点验证脚本，复用本机 Chrome，不下载浏览器 |

许可证复核方式：以上均为 package.json 声明中被 OSI 认可的开源许可；Turborepo 为 MPL-2.0（仅工具链，不进入产物代码路径）。除 TanStack Virtual 外未引入额外第三方 UI 组件库（按钮、徽章、面板、模态、分段控件均为本仓库自写组件），减少许可证与视觉耦合面。所有依赖社区活跃、持续维护，符合工单「优先社区活跃、可长期维护」的要求。

## 状态职责边界

| 层 | 位置 | 职责 |
| --- | --- | --- |
| Zustand | `packages/renderer/src/stores/`（`host` / `events` / `navigation` / `drafts` / `ui`） | 界面状态与模拟 Host 展示投影缓存。`host` 缓存适配层的最新投影（工作区、本地设置、审批、注意力、用量）；`events` 订阅适配层事件流（在 store 内取 `adapter`，组件不直接访问适配器）；`navigation` 解析/驱动 URL 路由；`drafts` 保存输入草稿；`ui` 承载模态、Toast、过滤器与面板开关。 |
| HostAdapter | `packages/renderer/src/data/hostAdapter.ts` + `memoryHost.ts` | 执行、审批、权限、调度、归档、本机设置、任务文件/浏览器页/终端等业务语义与**模拟数据**全部在适配层之后；组件只经 store 读取投影或发起意图，不内联 mock 数据。适配器可替换，渲染层不预设与真实 Host 的协议。 |
| TanStack Virtual | `packages/renderer/src/components/VirtualList.tsx` | 仅用于长列表（Token 用量明细、全部会话列表、定时任务执行记录）。读 `data-total-rows` / `data-virtualized` 暴露数据行数与虚拟化开关；最多四个会话标签等小集合不强制虚拟化。 |
| Shiki | `packages/renderer/src/components/CodeBlock.tsx` | 仅代码高亮。惰性加载 core + bash/json/ts/tsx 语法与 github-light 主题；加载失败回退到 `<pre>`，不阻断对话渲染。 |

补充说明：

- TanStack 仅引入 `@tanstack/react-virtual`，未默认加入 Router / Query / Table / Form / Store；渲染层路由由 `navigation` store 直接读写 `history` 实现。
- 数据全部来自内存模拟 Host（`memoryHost.ts`），不连接 Host、不发网络请求、不读写真实文件；`HostAdapter` 为唯一替换接缝，真实协议留待 02 定义。
- 单一真相：会话标识形如 `taskId:sessionId`，统一由 `data/sessionKey.ts` 的 `SessionKey` 类型 + `sessionKeyOf()` 生成（草稿、live 消息、运行记录复用）；工具面板名由 `stores/ui.ts` 的 `TOOL_PANELS` 单一来源提供；半径统一用 `--radius-panel` 令牌（`rounded-panel`）。组件不再直接 `getState().adapter`，全部经 store。

## 密集场景实测

数据来源：模拟 Host（`packages/renderer/src/data/memoryHost.ts`）。`makeUsage(240)` 生成 240 条 Token 记录；`release` 任务含 4 个基础会话 + 52 条历史会话（40 未归档 / 12 已归档），共 56 个会话；`seedScheduledRuns()` 生成 47 条执行记录。

测量方法：在运行中的开发服务器上用 `playwright-core` 复用本机 Chrome 打开页面，读取目标容器上的 `data-total-rows` 与 `data-virtualized`，并统计带 `translateY` 内联样式的行元素数量作为**实际渲染行数**。脚本：`packages/renderer/scripts/measure-baseline.mjs`。

| 场景 | 数据行数 | 视图行数 | 实际渲染行数 | 虚拟化 |
| --- | --- | --- | --- | --- |
| Token 用量明细（`/usage`，`data-testid="usage-table"`） | 240 | 240（全部 Provider / 全部任务） | 17 | true |
| 全部会话列表（`/projects/atlas/tasks/release?session=main` → 全部会话模态，默认「未归档」过滤，`data-testid="session-list"`） | 56（未归档过滤后 43） | 43 | 11 | true |
| 定时任务执行记录（`/schedules`，`data-testid="run-history"`） | 47 | 47 | 13 | true |
| 会话标签（任务页顶部，小集合豁免） | 56 | 4 | 4 | 否（有意不虚拟化） |

- 视图行数为 43 而实际渲染 11 行，证明会话列表真正窗口化（渲染行数 ≈ 视口 + overscan，与总数无关）；执行记录同理由 47 → 13。
- 「最多四个会话标签」是可记录的小集合豁免：渲染层固定只取前 4 个会话（`sessionTabs`），不虚拟化，实测渲染 4 行。
- 上一版把会话列表记为「数据行数 4、视图 3、渲染 3」——那是**固定数量演示，不是容量证据**；本轮已改为密集数据并给出渲染行数。

实测输出（2026-09-22，dev server 端口 4335）：

```json
{
  "tokens": {
    "accent": "#233c78",
    "bg": "#f6f7f8",
    "ink": "#252b30",
    "radiusPanel": "10px",
    "bodyBackground": "rgba(0, 0, 0, 0)",
    "shellBackground": "rgb(246, 247, 248)",
    "headingText": "需要处理",
    "headingColor": "rgb(37, 43, 48)"
  },
  "usage": { "total": 240, "virtualized": "true", "rendered": 17 },
  "sessions": { "total": 43, "virtualized": "true", "rendered": 11 },
  "sessionTabs": 4,
  "runHistory": { "total": 47, "virtualized": "true", "rendered": 13 },
  "settings": { "heading": "本机设置", "workspaceRoot": "~/PiDockTasks", "showsConfigDir": true },
  "errors": []
}
```

说明：`body` 背景为透明（`rgba(0, 0, 0, 0)`），实色背景由 Shell 根容器提供（`rgb(246, 247, 248)`，即 `--color-bg` #f6f7f8）；h1 文本「需要处理」，其前景色 `rgb(37, 43, 48)` 与 `--color-ink` #252b30 一致。`--radius-panel` 实测为 `10px`，对应 `rounded-panel`。

## 设计令牌与「无绿色」的程序化证据

`packages/renderer/src/test/tokens.test.ts` 现覆盖两层，均先红后绿：

1. **令牌层**：解析 `src/styles/tokens.css` 的颜色令牌，转 HSL 后拒绝绿色相区间（色相 75°–165°、饱和度 ≥ 0.12），断言 `--color-accent` 落在蓝色带（色相 200°–260°）且 CSS 不含 green/lime/emerald 等关键字。
2. **组件源码层（本轮新增）**：用 `import.meta.glob(..., { query: "?raw" })` 扫描 `components/`、`pages/`、`stores/`、`data/` 与根部 TSX/TS（**排除测试目录**），拒绝 Tailwind 绿色工具类（`text-green-*`、`bg-green-*` 等）、绿色关键字，以及落在绿色带内的十六进制字面量。自检用例先对 `text-green-500` 断言命中，再断言真实源码为空集。

实测令牌值：`--color-accent` #233c78（蓝）、`--color-bg` #f6f7f8、`--color-ink` #252b30；`--radius-panel` 10px；body 背景透明，Shell 根容器实测 `rgb(246, 247, 248)`；页面 h1 文本「需要处理」，颜色 `rgb(37, 43, 48)`。全量令牌（`--color-bg/paper/ink/muted/line/accent/soft/sidebar/orange`）均不在绿色带内；组件源码无绿色工具类、关键字或绿色十六进制。

## 收口规则的可演示位置

工单要求七条收口规则全部可演示。下表给出每条规则的入口与自动化证据：

| 收口规则 | 演示入口 | 证据 |
| --- | --- | --- |
| 会话执行状态与审批 | 任务页 `/projects/atlas/tasks/release?session=deploy` | `adapter.test.ts`「only executes an explicitly approved request」；`app.test.tsx`「reviews a concrete approval payload and expires it without executing」 |
| 失败保留草稿 | 任务页失败会话 + 失败后重试 | `stores.test.ts`「keeps the draft and references in the draft store after a failed run」；`app.test.tsx`「retains a draft and references when a run fails」 |
| 确认过期 | 任务页过期确认态（`pages/runState.ts`） | `adapter.test.ts`「expires pending approvals and stops services when a task is archived」 |
| 跨项目「需要处理」 | `/attention` 独立页面（按类型过滤，标签来自 `attentionKindLabel`） | `adapter.test.ts`「keeps cross-project attention items pointing at their task and session」 |
| 会话搜索与归档 | 任务页「全部会话」模态：搜索框 + 未归档/已归档分组 | `Modals.tsx` 会话列表（虚拟化）与过滤选项；`app.test.tsx`「virtualizes the long all-sessions list with real row counts」 |
| 按服务查看生效配置来源 | `/env` 服务表「来源」列 | `EnvPage.tsx` 与运行面板共用 `ConfigTable` |
| 归档任务清理清单预览 | `/archive` → 「预览清理清单」模态 | `adapter.test.ts`「only previews cleanup for archived tasks and retains code conservatively」 |

## 交互与视觉验证

工单要求验证流式文本更新、长列表滚动锚点与代码片段展示：

- **流式文本更新**：适配层按序发出 delta，`events` store 追加到同一条 agent 消息并以 `streaming` 标记，settle 后清除标记。自动化证据：`adapter.test.ts`「streams agent output as ordered deltas before the run settles」。
- **长列表滚动锚点**：对话区在用户停留底部时自动跟随流式输出，用户上滚后不打断（`pages/TaskPage.tsx` 的 `pinned` 判定，距底 < 48px 视为贴底）。**本轮新增 Playwright 真实验证**（`scripts/verify-anchor.mjs`，对 4335 dev server 运行），结果存 `docs/evidence/renderer-baseline-2026-09-22/anchor-follow-verification.json`：
  - `log-overflows`：对话容器 `scrollHeight 2471 > clientHeight 588`，确有独立滚动区；
  - `pinned-to-bottom-on-load`：加载即贴底（distance 0）；
  - `detached-after-scroll-up`：上滚到顶后不再贴底（distance 1883）；
  - `stays-detached-while-scrolled-up`：上滚状态下发送新消息、流式更新后仍保持不贴底（distance 2192）；
  - `repins-at-bottom` / `follows-streaming-while-pinned`：手动回到底部后恢复跟随，新消息后 distance 0；
  - `no-page-errors`：全程无页面错误。
  - **本轮由该验证发现并修复一个真实布局缺陷**：Shell 根容器此前是 `min-h-screen`，页面整体随内容增高，对话区自身从不滚动，`onScroll`/`pinned` 实际不会触发（锚点跟随形同虚设）。已改为 `h-screen overflow-hidden` + 主内容区 `overflow-auto`，使对话区成为独立滚动容器；修复后上述断言全部通过。这是「人工走查会漏、真实断言能抓」的例子。
- **代码片段展示**：`CodeBlock.tsx` 惰性加载 Shiki core + bash/json/ts/tsx + github-light，失败回退 `<pre>`。自动化证据：`codeblock.test.tsx`「highlights a snippet in-process without Node built-ins」；`FilesPanel` 的片段预览改由适配层 `Task.files[].preview` 提供。

**π 标记居中**：Shell 侧栏品牌标记用 `grid h-9 w-9 place-items-center rounded-full` 包裹 `π` 字形，按栅格居中而非文字基线；截图中可见（`docs/evidence/renderer-baseline-2026-09-22/renderer/*.png`）。此项为视觉检查，未做像素级自动断言（见下未测边界）。

## 本轮修复的评审项（两轴复核）

**A 规格关键项**

1. 复原「本机设置」页面并接回导航（`pages/SettingsPage.tsx`、`stores/navigation.ts`、`components/Shell.tsx`、`HostAdapter.getLocalSettings/setWorkspaceRoot`）；更正本文档上一版的错误「有意收敛」表述。
2. 剩余密集场景：会话列表与执行记录改为真实密集数据 + 虚拟滚动，附行数实测（见上表）；会话标签小集合豁免并记录实测行数。
3. 锚点跟随：新增 Playwright 断言并据此修复布局缺陷（见上）。
4. 绿色令牌断言扩展到 TSX/TS 组件源码（Tailwind 绿色工具类、关键字、绿色十六进制）。
5. 修复重命名任务/会话共用 `draftValue` 的跨模态残留：拆为各自受控子组件（`RenameTaskModal` / `RenameSessionModal`），并有回归测试 `test/modals.test.tsx`。
6. 组件选择与许可证记录补齐（见上表）。

**B 标准关键项**

7. 把硬编码 mock 数据移入适配层：任务文件、浏览器页、终端输出与「引用文件」参考改由 `HostAdapter` 提供（`Task.files/browserPages/terminalSeed` + `createFileReference` / `runTerminalCommand`）。
8. 组件不再直接访问适配器：`Modals.tsx` 删除无意义的 `getState().adapter.getRemoteDevices()` 死调用；`App.tsx` 改为 `events.attach()`（store 内自行取 `adapter`）。`stores/events.ts` 不再暴露 `sessionKey`。
9. 半径单一真相：`--radius-panel` 生效，`ui.tsx` / `TaskPage.tsx` 的 `rounded-[10px]` 改为 `rounded-panel`。

**C 标准警告项（已修）**

10. 删除死代码/未用表面：`stores/host.ts` 的 `HostSelectors/selectWorkspace/runRecordFor`、`hostAdapter.ts:kind`、`stores/events.ts:sessionKey`、`stores/ui.ts:activeTab/closePanel/sessionSearch/setSessionSearch`、`stores/host.ts:cleanupPreview`、`navigation.ts:openTask`、`memoryHost.ts:getTickMs` 与重复的 `export type { RunState }`。
11. 抽取 `SessionKey` 类型 + `sessionKeyOf()`（`data/sessionKey.ts`），替换 6 处 `` `${taskId}:${sessionId}` ``。
12. 标签修正：定时任务 `failed` 不再显示为「跳过」（改用 `scheduledRunResultLabel`）；`Modals.tsx` 不再打印原始 `runState`（改用 `runStateLabel`）；`AttentionPage` 过滤器与徽章共用 `attentionKindLabel`。
13. 抽取共享 `ConfigTable`，`ToolPanels` 与 `EnvPage` 三处 KEY/VALUE/来源表统一；`capture.mjs` 两个近似函数合并为 `captureScreens`，Chrome 路径、renderer 基址、原型基址、证据目录均改为环境变量可覆盖（与 `measure-baseline.mjs` 一致）。
14. 删除 `pages/taskTypes.ts`，类型回归 `data/types.ts`，工具面板名统一为 `stores/ui.ts` 的 `TOOL_PANELS`。

**保留的判断项（说明理由）**

- 未按模态拆分 `Modals.tsx`（361 行）：本轮只把两个重命名模态拆为独立受控子组件（为修复草稿残留），其余模态共享同一份 `useState`（清理预览、会话过滤），继续拆分收益低于 churn；留待后续按需重构。
- 未把 `memoryHost.ts`（877 行）的种子数据拆出：`seed*` 已在文件顶部以函数/常量组织，`MemoryHost` 只保留模拟执行；真正该拆的时机是 02 接入真实 Host 时用真实实现替换 `MemoryHost`，此时再按模块切分更自然，提前拆分只会增加迁移成本。
- 未消除 `stores/host.ts` 中约 15 个 `await adapter.X(); await refresh()` 包装：这是「意图 → 适配层 → 重新投影」的最小契约，抽象成泛型 `mutate()` 会隐藏每个方法的返回类型与错误语义。若后续有明确重复痛点再收敛。

## 未测边界（诚实清单）

以下**未在本轮验证**，不按通过理解：

1. **桌面环境 / 跨平台**：仅在本机 Chrome + Vite dev server 验证，未跑 Electron 44、utilityProcess、Windows。属 21 / 02 / 15 范围。
2. **真实 Host 数据**：全部数据为内存模拟；未连接 Pi AgentSession、未发网络请求、未读写真实文件。
3. **视觉尺寸**：截图与实测固定 1440×900；窄栏 / 375px / 窄窗、字体差异、中文输入法组合输入、键盘与焦点、浮层遮挡未做自动化断言。
4. **小集合豁免**：会话标签（≤4）未虚拟化，仅记录渲染行数；若未来会话标签数上限变化需重新评估。
5. **终端**：仅模拟命令回显，未接入 PTY / xterm.js；`runTerminalCommand` 不含真实执行。
6. **锚点跟随**：已在真实浏览器断言贴底/离底/回贴三种路径；未覆盖触控、程序化滚动抖动、超长单条消息等边界。
7. **π 居中**：为截图目视确认，无像素级自动断言。
8. **并发 / 断线 / 时钟**：未验证多会话并发、断线重连、定时时钟补跑；适配层为内存单实例。
9. **代码高亮**：Shiki 在 jsdom 与 dev server 验证，未在 Electron 沙箱渲染进程中验证。

## 工具链

ESLint 工具链与 flat config 位于工作区根 `eslint.config.mjs`，依赖在根 `devDependencies`。根 `pnpm lint` 经 Turbo 执行渲染层 `eslint . --max-warnings 0`，非空跑且真实规则生效（含 react-hooks、`@typescript-eslint/no-unused-vars`）；`turbo.json` 的 lint inputs 已纳入根 `eslint.config.mjs`。

## 实际运行过的确切命令

以下命令均在仓库根 `/Users/leonz3n/Workspace/github/pi-agent-ui` 执行，Node 版本经 PATH 显式固定为 24.21.0：

```bash
export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"

# 四道检查
pnpm typecheck
pnpm test
pnpm build
pnpm lint

# 渲染层 dev server（端口 4335；4318 被本机 Docker 占用，勿改回）
pnpm --filter @pidock/renderer dev

# 单文件测试（TDD 时反复执行）
pnpm --filter @pidock/renderer exec vitest run src/test/tokens.test.ts

# 截图证据（需 dev server 在 4335、原型在 4319）
node packages/renderer/scripts/capture.mjs

# 密集列表与令牌实测（需 dev server 在 4335）
node packages/renderer/scripts/measure-baseline.mjs

# 锚点跟随真实验证（需 dev server 在 4335）
node packages/renderer/scripts/verify-anchor.mjs

# 原型只读对照服务（仅截图时启动，未修改 prototypes/）
python3 -m http.server 4319 --bind 127.0.0.1   # URL: http://127.0.0.1:4319/?variant=A
```

浏览器自动化一律使用 `playwright-core` + 本机 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`（脚本内可用 `CHROME_PATH` 覆盖），未下载任何浏览器。
