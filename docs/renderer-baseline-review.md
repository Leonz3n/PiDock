# 渲染层基线评审（#3 / 原 20）

2026-09-22（复核修订：2026-09-22）。本记录覆盖渲染层基线（`packages/renderer`，`@pidock/renderer`）与静态草稿 `prototypes/pidock-ui/`（variant A 对话优先）的逐页对照、组件与许可证、状态职责边界、密集列表实测、锚点跟随验证与未测边界。

对照截图证据：[`docs/evidence/renderer-baseline-2026-09-22/`](evidence/renderer-baseline-2026-09-22/)（renderer 16 张 = 15 个页面截图 + 品牌标记裁剪图；prototype 9 张；`measurements.json` + `anchor-follow-verification.json` + `brand-mark-verification.json` + `capture-errors.json` + [`verification-log.md`](evidence/renderer-baseline-2026-09-22/verification-log.md)）。原型只读保留，未修改。

> **第四轮整改（两轴复核第四轮）勘误。** 上一版把「服务启动配方与从 `.vscode` 导入」整块列为**未复原项（明确取舍）**，但原型该块完全在内存实现（表单＋卡片列表＋示例导入），**并非**依赖真实仓库扫描。本轮已在适配层内存中复原该项，未复原项收窄为「真实仓库扫描、向仓库默认配置写入配方与进程启动」。同时修复一处**未披露的功能回退**：任务页此前只在「仅普通目录」任务上渲染目录 UI，使 **Git＋普通目录混合任务**的目录数、添加目录入口与文件／终端目录选择器**不可见且不可选**（原型对所有含目录的任务都提供）；本轮按原型改为任意含目录的任务均可访问（见「第四次整改」A）。`/env` 行的对齐标签据此重新核对（下方 #6），Zustand 状态表补回 `envDrafts`，`memoryHost.ts` 行数更正为当前值。

> **本轮（第二轮整改）勘误。** 上一版把 `/usage` 的 `rendered: 17` 当成容量证据发布，并声称「视觉与交互逐页对齐」。实测 17 行是 **`VirtualList` 高度反馈环**造成的收缩结果（border-box 被测成 content-box，420→418→416…），已按根因修复，`/usage` 实测回到 19 行并加入可回归的单元/组件测试（见「虚拟列表高度反馈环（本轮根因修复）」）。同时更正两处**过度陈述**（环境与服务页面、两条收口规则的证据）并把未复原项单列为**明确取舍**。

> **第三轮整改更正（两条被错误记为取舍的项已复原）。** 上一版把「环境与服务的作用域标签页＋可编辑 KEY/VALUE 表＋真实保存」与「普通目录任务布局」列为**明确取舍**，理由是「需要 Host 契约」。该理由经复核被否决：验收项 8 只要求数据留在内存，`docs/implementation-stack-design.md` 只禁止预设传输协议；原型两项均**完全在内存实现**，`memoryHost.ts` 本就在内存中变更分层数据，且 `docs/ui-prototype-review.md` 记录普通目录为用户确认决定。本轮已在适配层内存中复原两项（见「规格复原（第三轮）」），并从「未复原项（明确取舍）」表中删除。

> **上一版勘误。** 上一版把「本机设置」页面写成**有意收敛**（「渲染层去掉原型用于布局探索的重复/临时入口（如「本机设置」…）」）。这是**错误**：原型「本机设置」是 2026-09-20 经用户确认的页面，渲染层此前用一段静态 `<p>` 取代它属于**回退**，不是取舍。已按原型草稿复原该页面并接回导航，本节与下方对照表均已更正。

## 与草稿的逐页对照

渲染层 15 个可截图页面 vs 原型 9 张页面截图。下表逐一给出映射关系；原型侧没有独立页面的渲染层页面，均记明「有意新增」及理由，不存在把疏漏当作取舍的情况。

| # | 渲染层页面（路由） | 原型对照 | 结论与差异理由 |
| --- | --- | --- | --- |
| 1 | 需要处理 `/attention` | 无独立页；原型为「需要处理」模态（`prototypes/pidock-ui/closure.js` 的 `attentionDialog()`，经侧栏按钮注入） | **有意升级为独立页面**。收口规则要求跨项目汇总，作为可深链、可过滤的一等页面比一次性模态更适合持续处理；过滤器（全部/待确认/失败/过期/完成未读）为新增，理由是把原型中分散的判定集中在同一视图。 |
| 2 | 项目总览 `/projects/atlas` | `prototype/project.png` | **逐页对齐**。Hero、统计卡、继续工作任务卡与草稿一致；差异仅在于按渲染层栅格做了密度收紧，为有意为之。 |
| 3 | 任务页·主会话 `/projects/atlas/tasks/release?session=main` | `prototype/task-main.png` | **逐页对齐**。A 对话优先布局：任务导航常驻、对话占主区、工具面板按需打开。 |
| 4 | 任务页·部署审批会话（`?session=deploy`） | 原型同一任务页的会话切换态（草稿固定数量演示，未单独截图） | **有意拆为可截图状态**。用 `session` 查询参数把「执行状态与审批」收口规则固化为可复现路由，便于验收；属于证据粒度细化，不是新增产品行为。 |
| 5 | 任务页·失败现场（`?session=failed`） | 原型同一任务页的失败态 | **有意拆为可截图状态**。理由同上：把「失败保留草稿」收口规则做成可深链、可重复截图的证据。 |
| 6 | 环境与服务 `/env` | `prototype/env.png` | **部分对齐（第三／四轮复原）**。共享模板／本机私有配置／任务覆盖三个作用域标签页、可编辑 KEY/VALUE 表（新增／修改／删除）、KEY 非空＋格式＋重复校验、VALUE 可为空、草稿按 项目／环境／作用域／任务 隔离、共享模板保存前差异预览（新增／改值／改名＝移除＋新增／删除）与版本递增均已复原，写入经适配层留在内存；`保存` 不再只 toast。「任务覆盖」现按原型只在**所选环境被任务引用**时出现，且任务下拉只列该环境的任务（不再能把覆盖存到不匹配的环境）。本轮又复原**服务启动配方**（`添加服务`＋可编辑卡片，含 name／repo／runtime／启动说明）与 **从 `.vscode` 导入**（内存模拟：按项目已登记仓库生成示例配方并提示）。生效来源分层与「按服务查看生效配置」只读视图一致，KEY/VALUE/来源表仍共用 `ConfigTable`。**未复原**：环境的新增／管理（重命名、删除）界面（`ui-prototype-review.md:146` 记录的已提出需求；渲染层当前仅只读列出环境）；真实仓库扫描／向仓库默认配置写入配方／进程启动见「未复原项」。 |
| 7 | Provider 与上下文 `/providers` | `prototype/providers.png` | **逐页对齐**。同一供应商多配置、模型与上下文占用分开记录保持一致。 |
| 8 | Token 用量 `/usage` | `prototype/usage.png` | **逐页对齐并有意加强**。筛选与明细列对齐草稿；明细改用虚拟滚动（见下「密集场景实测」），理由是把原型的固定条数改为可扩展实现。**本轮修复虚拟列表高度反馈环后，明细视口恢复 420px、实测渲染 19 行**（上一版误记为 17 行）。 |
| 9 | 定时任务 `/schedules` | `prototype/schedules.png` | **逐页对齐并有意加强**。「执行记录」由普通 `<ul>` 改为虚拟滚动，并把固定 3 条改为 47 条密集数据（见下），理由同 Token 明细；结果标签修复为「完成/跳过/失败」。 |
| 10 | 能力管理 `/capabilities` | `prototype/capabilities.png` | **逐页对齐**。按 Skills / Extensions / Packages / MCP Servers 分类一致。 |
| 11 | 远程访问 `/remote` | `prototype/remote.png` | **逐页对齐**。主机主动连接、每设备独立撤销保持一致。 |
| 12 | 归档与清理 `/archive` | `prototype/archive.png` | **逐页对齐**。归档停止执行、恢复不自动启动、清理仅面向归档任务保持一致。 |
| 13 | 本机设置 `/settings` | 原型 `app.js` 的 `workspaceSettingsDialog()`（「本机设置」模态，经侧栏 folder 图标打开，2026-09-20 用户确认） | **逐页对齐（本轮复原）**。展示默认应用配置目录 `~/.pi/dock` 与配置文件 `~/.pi/dock/config.json`；可编辑默认任务根目录 `workspaceRoot`，保存提示「已有任务不迁移」。数据经 `HostAdapter.getLocalSettings/setWorkspaceRoot` 提供，属本机设置、不进入共享模板。原型为模态，渲染层为可深链页面——粒度细化，内容与决策点一致。 |
| 14 | 任务页·普通目录 `/projects/atlas/tasks/design-docs` | 原型 `directories.js` 的 `directoryWorkspace()` / `directoryHeader()`（草稿未单独截图） | **逐页对齐（第三轮复原）**。`TASK · 普通目录` 标题与目录数；无 Git 分支／远程基线／worktree／差异／提交入口。文件面板显示任务内软链接路径＋原始路径、示例文件与引用入口；终端面板显示拟用 cwd；目录面板说明修改影响原目录、不提供 Git 差异／分支／提交。截图见 `evidence/renderer-baseline-2026-09-22/renderer/task-directory.png`。 |
| 15 | 任务页·混合（Git＋普通目录）`/projects/atlas/tasks/release` 打开「文件」面板 | 原型 `app.js` 的 `header()`（非目录分支仍渲染 `添加目录` 与 `N 个普通目录` 徽章）、`filesView()` / `terminalView()` 的 `directoryRootChoices()`、`panel()` 的目录面板分支 | **逐页对齐（第四轮复原；修复未披露回退）**。头部显示普通目录数徽章与 `添加目录`；文件／终端面板列出目录根选择器，选中目录显示目录面板，可切回仓库工作副本；Git 预算面（运行／浏览器）保留。截图见 `evidence/renderer-baseline-2026-09-22/renderer/task-mixed.png`。 |

### 全局导航差异（更正）

- 渲染层侧栏（`packages/renderer/src/components/Shell.tsx`）现列出**九个**一级入口：需要处理 / 环境与服务 / Provider 与上下文 / Token 用量 / 定时任务 / 能力管理 / 远程访问 / 归档与清理 / **本机设置**。
- 原型侧栏标签另有「项目总览 / 任务列表 / 已归档 / 模型与 Provider」等入口，部分用于布局探索。「任务列表」在渲染层并入「项目与任务」分组与项目页；**「本机设置」不再属于被收敛项，已复原为一级入口**（上一版把它列为有意收敛是错误的）。
- 「需要处理」在原型是模态、在渲染层是页面（见上表 #1），故其入口从原型的一次性按钮变为常驻一级导航并带未读计数。

## 未复原项（明确取舍）

> **第三轮整改。** 上一版此处有三行，其中两行（环境与服务作用域编辑、普通目录任务布局）是**错误记为取舍的回退**，经复核否决后已在本轮内存复原，见「规格复原（第三轮）」。

> **第四轮整改。** 上一版把整块「服务启动配方编辑／从 `.vscode` 导入」列为取舍，理由（依赖真实仓库扫描）**不成立**：原型的配方表单与卡片列表、以及导入入口均**完全在内存**，与已复原的作用域编辑同类。本轮已在适配层内存复原表单、卡片列表与模拟导入，取舍收窄为下表的**只有一条**：真实仓库扫描、向仓库默认配置写入配方与进程启动。

原型中仍以下列能力在渲染层**尚未复原**，属**明确取舍**：

| 原型能力 | 渲染层现状 | 为何不复原（取舍理由） |
| --- | --- | --- |
| 真实仓库扫描、向仓库默认配置写入启动配方、进程启动 | 配方表单／卡片列表与 `.vscode` 导入入口已在内存复原；写入与扫描无实现 | 原型自身标注「真实模板快照、配置解析、服务配方写入与重启仍未接入，不能将版本数字变化当作这些能力已验证」（`ui-prototype-review.md:148`）；真实读取与写入属后续工单。 |

> 该项以 `docs/ui-prototype-review.md` 的已确认要求为准，渲染层基线不做半成品实现；其余与「未测边界」一起构成当前与草稿的真实差异清单。
>
> **另有一项独立缺口（不计入上表）：** 原型 `/env` 的环境**新增／管理（重命名、删除）**界面在渲染层尚未复原（`ui-prototype-review.md:146` 记录的用户需求）；因此逐页对照表 #6 将 `/env` 标为**部分对齐**，不声称整体逐页对齐。该缺口与配方复原无关，不并入上表以免与「取舍收窄」混淆。

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
| Zustand | `packages/renderer/src/stores/`（`host` / `events` / `navigation` / `drafts` / `envDrafts` / `ui`） | 界面状态与模拟 Host 展示投影缓存。`host` 缓存适配层的最新投影（工作区、本地设置、审批、注意力、用量）；`events` 订阅适配层事件流（在 store 内取 `adapter`，组件不直接访问适配器）；`navigation` 解析/驱动 URL 路由；`drafts` 保存输入草稿；`envDrafts` 保存按 项目／环境／作用域／任务 隔离的环境配置编辑草稿（含行 id 由 `nextConfigRowId()` 单调序列生成，不再由 KEY 拼出）；`ui` 承载模态、Toast、过滤器与面板开关。 |
| HostAdapter | `packages/renderer/src/data/hostAdapter.ts` + `memoryHost.ts` | 执行、审批、权限、调度、归档、本机设置、任务文件/浏览器页/终端等业务语义与**模拟数据**全部在适配层之后；组件只经 store 读取投影或发起意图，不内联 mock 数据。适配器可替换，渲染层不预设与真实 Host 的协议。 |
| TanStack Virtual | `packages/renderer/src/components/VirtualList.tsx` | 仅用于长列表（Token 用量明细、全部会话列表、定时任务执行记录）。读 `data-total-rows` / `data-virtualized` 暴露数据行数与虚拟化开关；最多四个会话标签等小集合不强制虚拟化。 |
| Shiki | `packages/renderer/src/components/CodeBlock.tsx` | 仅代码高亮。惰性加载 core + bash/json/ts/tsx 语法与 github-light 主题；加载失败回退到 `<pre>`，不阻断对话渲染。 |

补充说明：

- TanStack 仅引入 `@tanstack/react-virtual`，未默认加入 Router / Query / Table / Form / Store；渲染层路由由 `navigation` store 直接读写 `history` 实现。
- 数据全部来自内存模拟 Host（`memoryHost.ts`），不连接 Host、不发网络请求、不读写真实文件；`HostAdapter` 为唯一替换接缝，真实协议留待 02 定义。
- 单一真相：会话标识形如 `taskId:sessionId`，统一由 `data/sessionKey.ts` 的 `SessionKey` 类型 + `sessionKeyOf()` 生成（草稿、live 消息、运行记录复用）；工具面板名由 `stores/ui.ts` 的 `TOOL_PANELS` 单一来源提供；半径统一用 `--radius-panel` 令牌（`rounded-panel`）。组件不再直接 `getState().adapter`，全部经 store。

## 密集场景实测

数据来源：模拟 Host（`packages/renderer/src/data/memoryHost.ts`）。`makeUsage(240)` 生成 240 条 Token 记录；`release` 任务含 4 个基础会话 + 52 条历史会话（40 未归档 / 12 已归档），共 56 个会话；`seedScheduledRuns()` 生成 47 条执行记录。

测量方法：在运行中的开发服务器上用 `playwright-core` 复用本机 Chrome 打开页面，等待 resize observer 稳定后，读取目标容器上的 `data-total-rows` / `data-virtualized` / `data-viewport-height` / `data-row-height` / `data-overscan`，并统计带 `translateY` 内联样式的行元素数量作为**实际渲染行数**。脚本：`packages/renderer/scripts/measure-baseline.mjs`（直接写入 `measurements.json`，并在 `rendered !== ceil(viewportHeight / rowHeight) + overscan` 时非零退出）。

| 场景 | 数据行数 | 视口高度／行高／overscan | 期望窗口 `ceil(h/r)+overscan` | 实际渲染行数 | 虚拟化 |
| --- | --- | --- | --- | --- | --- |
| Token 用量明细（`/usage`，`data-testid="usage-table"`） | 240 | 420 / 34 / 6 | 19 | **19** | true |
| 全部会话列表（`/projects/atlas/tasks/release?session=main` → 全部会话模态，默认「未归档」过滤，`data-testid="session-list"`） | 56（未归档过滤后 43） | 280 / 56 / 6 | 11 | **11** | true |
| 定时任务执行记录（`/schedules`，`data-testid="run-history"`） | 47 | 280 / 40 / 6 | 13 | **13** | true |
| 会话标签（任务页顶部，小集合豁免） | 56 | — | — | 4 | 否（有意不虚拟化） |

- 三个虚拟化列表的**实际渲染行数均等于期望窗口**，且与各列表总数无关，证明它们真正窗口化（渲染行数 ≈ 视口 + overscan）。
- 行数列与 `data-total-rows` 一致；未归档 43 为过滤后的视图行数（全部 56）。
- 「最多四个会话标签」是可记录的小集合豁免：渲染层固定只取前 4 个会话（`sessionTabs`），不虚拟化，实测渲染 4 行。
- 上一版把会话列表记为「数据行数 4、视图 3、渲染 3」——那是**固定数量演示，不是容量证据**；上一版又把 `/usage` 的 `rendered: 17` 当成容量证据——那是**高度反馈环的产物**（见下节），都已在第二轮更正为密集数据 + 期望/实测对照。`measurements.json` 另存 `expectationMismatches`，本机为空数组。

实测输出（2026-09-22，dev server 端口 4335；完整文件见 [`measurements.json`](evidence/renderer-baseline-2026-09-22/measurements.json)）：

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
  "usage": { "total": 240, "virtualized": "true", "declaredHeight": 420, "viewportHeight": 420, "rowHeight": 34, "overscan": 6, "expected": 19, "expectedAttribute": 19, "rendered": 19, "heightMatchesDeclared": true, "rowsMatchExpected": true },
  "sessions": { "total": 43, "virtualized": "true", "declaredHeight": 280, "viewportHeight": 280, "rowHeight": 56, "overscan": 6, "expected": 11, "expectedAttribute": 11, "rendered": 11, "heightMatchesDeclared": true, "rowsMatchExpected": true },
  "sessionTabs": 4,
  "runHistory": { "total": 47, "virtualized": "true", "declaredHeight": 280, "viewportHeight": 280, "rowHeight": 40, "overscan": 6, "expected": 13, "expectedAttribute": 13, "rendered": 13, "heightMatchesDeclared": true, "rowsMatchExpected": true },
  "settings": { "heading": "本机设置", "workspaceRoot": "~/PiDockTasks", "showsConfigDir": true },
  "errors": [],
  "expectationMismatches": []
}
```

说明：`body` 背景为透明（`rgba(0, 0, 0, 0)`），实色背景由 Shell 根容器提供（`rgb(246, 247, 248)`，即 `--color-bg` #f6f7f8）；h1 文本「需要处理」，其前景色 `rgb(37, 43, 48)` 与 `--color-ink` #252b30 一致。`--radius-panel` 实测为 `10px`，对应 `rounded-panel`。

## 虚拟列表高度反馈环（本轮根因修复）

**现象。** `/usage` 的明细表在浏览器中持续收缩：视口 `420 → 418 → 416 …`，实测只渲染 17 行，而模型 `height 420、rowHeight 34、overscan 6 ⇒ ceil(420/34)+6 = 19`。截图里行分隔线只跨 ≈306px，而非声明的 420px（`docs/evidence/.../renderer/usage.png` 上一版）。

**根因。** `VirtualList.tsx` 把 `style={{ height: viewportHeight }}` 写在滚动元素上，而 `ResizeObserver` 回调又把 `entry.contentRect.height` 写回同一个 state。`contentRect` 是 **content box**，而 Tailwind preflight 的 `box-sizing: border-box` 下 `style.height` 是 **border-box**。因此任何带边框的调用方（`UsagePage.tsx` 传入 `className="rounded-md border border-line"`）每次回调都比上次少 2px：测 418 → 写 418 → content 变 416 → …. 无边框的两个调用方（`SchedulesPage` 执行记录 13/13、`Modals` 会话列表 11/11）因为 content == border 而恰好稳定，正好解释了为什么只有 `/usage` 塌陷。

**修复。** 改为**测 border box**：新增纯函数 `resolveViewportHeight()`，按 `borderBoxSize?.[0]?.blockSize` → `getBoundingClientRect().height` → `contentRect.height` 取第一个正值并取整；同时在滚动元素上显式写 `boxSizing: "border-box"`，使「所写即所测」不依赖宿主 preflight。导出 `viewportWindowSize()` 作为组件内部 `ceil(h/r)+overscan` 的单一来源（备用行渲染与虚拟窗口共用）。**实测脚本并未 import 该函数**，而是在 Node 侧独立重算同一公式，并通过脚本断言 `data-expected-rows === 脚本计算的 expected` 与单元测试钉住 19/13/11 这两个已知期望值来保持两处一致；上一版「与实测脚本共用」的说法不准确，已更正。组件另暴露 `data-declared-height/data-viewport-height/data-row-height/data-overscan/data-expected-rows`，实测脚本断言 `viewportHeight === declaredHeight`（防收缩）且 `rendered === ceil(viewportHeight/rowHeight)+overscan`（防窗口错误）。**未**采取丢边框、硬编码声明高度或改用无边框内层包装——前两者掩盖问题，后者仍需与内容盒语义对齐且会增加一层 DOM。

**为何可测。** 以前 `src/test/setup.ts` 把 `ResizeObserver` no-op，反馈环在 CI 不可能发生。本轮改为 `src/test/resizeObserver.ts` 的可控 stub：保留观察者契约，按元素当前 `style.height` 推导 border box，并由 `simulateVerticalBorder(el, px)` 声明边框宽度，因此 `notifyResize(el)` 可以重现真实的「写回 → 再通知」循环。

**新增测试**（`src/test/virtualList.test.tsx`，共 9 例）：

1. `resolveViewportHeight`：border-box 输入取 420 而非 418；缺失 `borderBoxSize` 时回退 rect，再回退 content box；非正值归零。
2. **纯函数反馈环模拟**：把观测值反复回灌，断言收敛在声明高度（旧推导 10 轮后为 400 = 420−20）。
3. **组件级反馈环**（`keeps its declared height across repeated resize notifications`）：渲染带边框列表，连续 `notifyResize` 5 次，断言 `style.height` 始终为 `420px`（**旧代码下为 `418px/416px/…`**）。
4. `viewportWindowSize`：19 / 13 / 11 / 上限封顶。
5. 带边框列表渲染 19 行；无边框列表同样 420px、19 行；卸载后停止观察。

**哪一个测试会在修复前失败。** 上列 (1)(2)(3) 及 `viewportWindowSize` 中带边框的期望在旧代码下失败；其中**组件级反馈环测试 (3)** 是最直接的“旧代码必挂”回归。已用变异验证：把推导改回 content box，`virtualList.test.tsx` 9 例中 4 例失败（含 (1)(2)(3)）；恢复后 9/9 通过。

## 设计令牌与「无绿色」的程序化证据

`packages/renderer/src/test/tokens.test.ts` 现覆盖两层，均先红后绿：

1. **令牌层**：解析 `src/styles/tokens.css` 的颜色令牌，把每个颜色（含 hex 与 `rgb()`/`hsl()` 形式）归一为 HSL 后拒绝绿色相区间（色相 75°–165°、饱和度 ≥ 0.12），断言 `--color-accent` 落在蓝色带（色相 200°–260°）且 CSS 不含 green/lime/emerald 等关键字、也不含落在绿色带内的 `rgb()`/`hsl()` 字面量。
2. **组件源码层**：用 `import.meta.glob(..., { query: "?raw" })` 扫描 `components/`、`pages/`、`stores/`、`data/` 与根部 TSX/TS（**排除测试目录**），拒绝 Tailwind 绿色工具类（`text-green-*`、`bg-green-*` 等）、绿色关键字，以及落在绿色带内的颜色字面量。子色检测已扩展到 **hex（3/4/6/8 位）、`rgb()/rgba()`、`hsl()/hsla()`**，因此 Tailwind **任意值转义**如 `text-[#00ff00]`、`bg-[rgb(0,255,0)]`、`text-[hsl(120_60%_40%)]` 都会被扫到。自检用例先对这些形式断言命中、对蓝色 `text-[#0be]` 与 `text-accent bg-[#233c78]` 断言不命中，再断言真实源码为空集；并已用变异（向 `ui.tsx` 植入绿色任意值）确认测试会挂。

实测令牌值：`--color-accent` #233c78（蓝）、`--color-bg` #f6f7f8、`--color-ink` #252b30；`--radius-panel` 10px；body 背景透明，Shell 根容器实测 `rgb(246, 247, 248)`；页面 h1 文本「需要处理」，颜色 `rgb(37, 43, 48)`。全量令牌（`--color-bg/paper/ink/muted/line/accent/soft/sidebar/orange`）均不在绿色带内；组件源码无绿色工具类、关键字或绿色颜色字面量（hex/rgb/hsl/任意值转义）。

## 收口规则的可演示位置

工单要求七条收口规则全部可演示。下表给出每条规则的入口与自动化证据：

| 收口规则 | 演示入口 | 证据 |
| --- | --- | --- |
| 会话执行状态与审批 | 任务页 `/projects/atlas/tasks/release?session=deploy` | `adapter.test.ts`「only executes an explicitly approved request」；`app.test.tsx`「reviews a concrete approval payload and expires it without executing」 |
| 失败保留草稿 | 任务页失败会话 + 失败后重试 | `stores.test.ts`「keeps the draft and references in the draft store after a failed run」；`app.test.tsx`「retains a draft and references when a run fails」 |
| 确认过期 | 任务页过期确认态（`pages/runState.ts`） | `app.test.tsx`「reviews a concrete approval payload and expires it without executing」（点「标记过期」后断言「确认已过期，未执行。」且未执行命令）；`adapter.test.ts`「expires pending approvals and stops services when a task is archived」 |
| 跨项目「需要处理」 | `/attention` 独立页面（按类型过滤，标签来自 `attentionKindLabel`） | `adapter.test.ts`「keeps cross-project attention items pointing at their task and session」 |
| 会话搜索与归档 | 任务页「全部会话」模态：搜索框 + 未归档/已归档分组 | `app.test.tsx`「searches and archives sessions inside the all-sessions list」（搜索「部署」后列表只剩 1 匹配行；点归档后分组计数 未归档 43→42、已归档 13→14，且切到已归档能看到该行）；另有「virtualizes the long all-sessions list with real row counts」 |
| 按服务查看生效配置来源 | `/env` 服务表「来源」列 | `app.test.tsx`「shows the effective config source per service on the environment page」（断言四层来源文案 共享模板／仓库默认配置／任务覆盖／本机私有配置、敏感值遮蔽、切换服务后解析值随服务变化）；表由 `EnvPage.tsx` 与运行面板共用 `ConfigTable` |
| 归档任务清理清单预览 | `/archive` → 「预览清理清单」模态 | `adapter.test.ts`「only previews cleanup for archived tasks and retains code conservatively」 |

## 交互与视觉验证

工单要求验证流式文本更新、长列表滚动锚点与代码片段展示：

- **流式文本更新**：适配层按序发出 delta，`events` store 追加到同一条 agent 消息并以 `streaming` 标记，settle 后清除标记。自动化证据：`adapter.test.ts`「streams agent output as ordered deltas before the run settles」。
- **长列表滚动锚点**：对话区在用户停留底部时自动跟随流式输出，用户上滚后不打断（`pages/TaskPage.tsx` 的 `pinned` 判定，距底 < 48px 视为贴底）。**本轮新增 Playwright 真实验证**（`scripts/verify-anchor.mjs`，对 4335 dev server 运行），结果存 `docs/evidence/renderer-baseline-2026-09-22/anchor-follow-verification.json`：
  - `log-overflows`：对话容器 `scrollHeight 2471 > clientHeight 588`，确有独立滚动区；
  - `pinned-to-bottom-on-load`：加载即贴底（distance 0）；
  - `detached-after-wheel-gesture`（**本轮新增的真实滚轮手势**）：把鼠标移到对话区中心后 `page.mouse.wheel(0, -800)`，不贴底（distance 800）；
  - `detached-after-scroll-up`：程序化上滚到顶后不再贴底（distance 1883）；
  - `stays-detached-while-scrolled-up`：上滚状态下发送新消息、流式更新后仍保持不贴底（distance 2192）；
  - `repins-at-bottom` / `follows-streaming-while-pinned`：手动回到底部后恢复跟随，新消息后 distance 0；
  - `no-page-errors`：全程无页面错误。
  - **本轮由该验证发现并修复一个真实布局缺陷**：Shell 根容器此前是 `min-h-screen`，页面整体随内容增高，对话区自身从不滚动，`onScroll`/`pinned` 实际不会触发（锚点跟随形同虚设）。已改为 `h-screen overflow-hidden` + 主内容区 `overflow-auto`，使对话区成为独立滚动容器；修复后上述断言全部通过。这是「人工走查会漏、真实断言能抓」的例子。
- **代码片段展示**：`CodeBlock.tsx` 惰性加载 Shiki core + bash/json/ts/tsx + github-light，失败回退 `<pre>`。自动化证据：`codeblock.test.tsx`「highlights a snippet in-process without Node built-ins」；`FilesPanel` 的片段预览改由适配层 `Task.files[].preview` 提供。

**π 标记居中（本轮改为自动断言）**：Shell 侧栏品牌标记用 `grid h-9 w-9 place-items-center rounded-full` 包裹 `π` 字形。`scripts/verify-brand.mjs` 在 4335 dev server 上用 `Range` 选中字形并比较其 bounding box 中心与徽标 border box 中心，实测 `offsetX = 0`、`offsetY = 0`，同时断言徽标为 36×36 圆形、使用 grid place-items 居中、字形为强调蓝 `rgb(35, 60, 120)`，并输出裁剪图 `docs/evidence/renderer-baseline-2026-09-22/renderer/brand-mark.png`；结果存 `brand-mark-verification.json`。上一版仅目视，已升级为可回归断言（字体差异下的像素级渲染仍未覆盖，见未测边界）。

## 本轮修复的评审项（两轴复核）

**A 规格关键项**

1. 复原「本机设置」页面并接回导航（`pages/SettingsPage.tsx`、`stores/navigation.ts`、`components/Shell.tsx`、`HostAdapter.getLocalSettings/setWorkspaceRoot`）；更正本文档上一版的错误「有意收敛」表述。
2. 剩余密集场景：会话列表与执行记录改为真实密集数据 + 虚拟滚动，附行数实测（见上表）；会话标签小集合豁免并记录实测行数。
3. 锚点跟随：新增 Playwright 断言并据此修复布局缺陷（见上）。
4. 绿色令牌断言扩展到 TSX/TS 组件源码（Tailwind 绿色工具类、关键字、绿色颜色字面量）。
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

- 未按模态拆分 `Modals.tsx`（841 行）：本轮只把两个重命名模态拆为独立受控子组件（为修复草稿残留），其余模态共享同一份 `useState`（清理预览、会话过滤），继续拆分收益低于 churn；留待后续按需重构。
- 未把 `memoryHost.ts`（1330 行）的种子数据拆出：`seed*` 已在文件顶部以函数/常量组织，`MemoryHost` 只保留模拟执行；真正该拆的时机是 02 接入真实 Host 时用真实实现替换 `MemoryHost`，此时再按模块切分更自然，提前拆分只会增加迁移成本。
- 未消除 `stores/host.ts` 中约 15 个 `await adapter.X(); await refresh()` 包装：这是「意图 → 适配层 → 重新投影」的最小契约，抽象成泛型 `mutate()` 会隐藏每个方法的返回类型与错误语义。若后续有明确重复痛点再收敛。

## 第二次整改（两轴复核第二轮）

第一轮整改被两轴复核判为「部分未完成 + 一个真实 bug」。本轮逐项处置如下，均附可复现证据；未完成的项以**明确取舍**或**未测边界**列出，不再当已对齐。

| # | 复核发现 | 处置 | 证据 |
| --- | --- | --- | --- |
| CRITICAL 1 | `/usage` 高度反馈环（根因） | 按根因修复为 border-box 测量 + 显式 `box-sizing`；新增纯函数、可控 `ResizeObserver` stub 与组件级回归 | 「虚拟列表高度反馈环」节；`virtualList.test.tsx` 9 例 |
| CRITICAL 2 | `measurements.json` 把 `rendered: 17` 当时序产物发布 | 重新实测并直接写盘；脚本记录并校验 `expected = ceil(h/r)+overscan`，不匹配即非零退出 | `measurements.json`：19/19、11/11、13/13，`expectationMismatches: []` |
| 警告 3 | 两条收口规则证据过度陈述 | 为「会话搜索与归档」「按服务查看生效配置来源」补真实断言 | `app.test.tsx` 两例（搜索/归档计数、四层来源/遮蔽/随服务变化） |
| 警告 4 | `EnvPage` 与原型差距（作用域/编辑/配方） | 记为**明确取舍**（作用域写入与配方导入属 Host 契约，见 02） | 「未复原项（明确取舍）」表；未测边界 #10 |
| 警告 5 | 普通目录任务布局未恢复也未记录 | 记为**明确取舍** | 同上 |
| 警告 6 | `setWorkspaceRoot` 丢掉 `validWorkspaceRoot` 校验 | 恢复校验（POSIX / 盘符 / UNC；另接受 `~/` 并标注为有意扩展） | `memoryHost.ts`；`adapter.test.ts` 新增用例 |
| 警告 7 | 重命名测试只断言显示值，未覆盖保存路径 | 改为断言**保存结果**（保存后仍为 `实现与验证`、无 `泄漏的值`） | `modals.test.tsx`；已用变异（会话模态复用泄漏值）确认会挂 |
| 警告 8 | `capture.mjs` 算出错误却不留存 | 错误写入 `capture-errors.json`；顺带补内联 favicon 消除渲染层唯一 404 | `capture-errors.json`（renderer 为空） |
| 警告 9 | 绿色检测漏 `rgb()`/`hsl()` 与任意值转义 | 检测器归一 hex/rgb/hsl 并覆盖 `text-[…]`，加自检与变异验证 | `tokens.test.ts` 11 例 |
| 10 | π 居中仅目视 | 升级为 Playwright 自动断言（偏移 0）+ 裁剪图 | `scripts/verify-brand.mjs`、`brand-mark-verification.json`、`renderer/brand-mark.png` |
| 11 | 锚点离底仅程序化 | 增加真实滚轮手势离底用例 | `scripts/verify-anchor.mjs`、`anchor-follow-verification.json` |
| 12 | 上轮提交类型与内容不符 | 本轮按实际内容拆分为 `fix/test/docs/build` 等诚实 scope | 见下方「本轮提交」 |

> **证据可复现性（第三轮更正）。** 上一版声称上述 JSON「可逐字节复现」，实际当时只核对了键值，并未逐字节比对。现更正为：这些 JSON 在**本机**重跑可复现到键值一致，但不声称跨主机逐字节一致，也未做逐字节比对。已知时间相关字段：`renderer/task-deploy.png` 的审批面板把 `expiresAt`（`Date.now() + 24h` 经 `toLocaleString`）渲染为文本，截图随运行时刻变化；`approvals[].expiresAt/requestedAt`、`runs[].startedAt`、`sessions[].lastActivity`、`usage[].at`、`scheduledRuns[].at` 等由 `Date.now()`/`new Date()` 产生的 ISO 时间同理。四道 `--force` 检查、证据脚本与三处变异验证的实际输出见 [`verification-log.md`](evidence/renderer-baseline-2026-09-22/verification-log.md)。

## 第三次整改（两轴复核第三轮）：规格复原与证据严谨性

第三轮无未决缺陷；本轮处置（A）两条被错误记为取舍的复原项与（B）证据严谨性修复，均有测试或可重跑证据。

### A 规格复原（第三轮）

两条上一版记为「明确取舍」的流程已在**适配层内存**中复原，未新增传输/协议；实现与测试：

| 复原项 | 实现位置 | 对应原型 | 测试/证据 |
| --- | --- | --- | --- |
| A1 环境作用域编辑与保存 | `pages/EnvPage.tsx`（三个作用域标签页＋可编辑表＋差异预览入口）、`stores/envDrafts.ts`（按 项目/环境/作用域/任务 的草稿）、`data/configRows.ts`（KEY 校验、差异分类、版本递增纯函数、单调行 id）、`data/memoryHost.ts`（`saveEnvironmentConfig`/`adoptLatestTemplate`，共享模板保存递增版本、任务保留采用版本）、`components/Modals.tsx`（`config-diff` 模态） | `closure.js:32`、`README.md:27,49`、`ui-prototype-review.md:148` | `test/configRows.test.ts`（第四轮后 10）、`test/env.test.tsx`（第四轮后 8）、`test/adapter.test.ts`（层写入与版本递增）。截图 `renderer/env.png` |
| A2 普通目录项目与任务 | `data/directories.ts`（链接名/路径/仅目录判定纯函数）、`data/memoryHost.ts`（`setProjectDirectories`/`setTaskDirectories`/`createTask`/`createDirectoryFileReference`、清理预览追加软链接行）、`pages/ProjectPage.tsx`＋`components/Modals.tsx`（目录登记、任务目录选择、新建任务）、`pages/TaskPage.tsx`＋`components/ToolPanels.tsx`（`TASK · 普通目录` 头部与目录面板） | `directories.js:10,12,13,14,15,16,19,21,29`、`ui-prototype-review.md:207-225` | `test/directories.test.ts`（第四轮后 8）、`test/directoriesFlow.test.tsx`（第四轮后 9，含混合任务路径）。截图 `renderer/task-directory.png` |

- 生效配置解析改为**按层组合**：`memoryHost.ts` 的 `resolveServiceConfig()` 依 仓库默认配置 → 共享模板 → 本机私有 → 任务覆盖 → 运行时端口 依次覆盖，每行保留 `source`，因此编辑并保存共享模板后只读视图随之变化。
- 明确排除（属后续工单）：真实仓库扫描、向仓库默认配置写入启动配方与进程启动；配方的内存表单／卡片列表与 `.vscode` 导入已在第四轮复原（见「第四次整改」B）。
- 内存复原**不代表** 已验磁盘目录存在性、读写权限、真实软链接创建与大小写别名（见未测边界 #12）。

### B 证据严谨性

| # | 修复 | 位置 |
| --- | --- | --- |
| B1 | 单独发布 `data-declared-height`，实测断言 `viewportHeight === declaredHeight` 且 `rendered === ceil(h/r)+overscan`，任一不满足非零退出 | `components/VirtualList.tsx`、`scripts/measure-baseline.mjs` |
| B2 | 运行日志落盘（四道 `--force`、证据脚本、三处变异验证） | `docs/evidence/renderer-baseline-2026-09-22/verification-log.md` |
| B3 | 「可逐字节复现」软化为「本机键值可复现」并列出时间相关字段 | 本文「证据可复现性（第三轮更正）」及上节 |
| B4 | 「这两项」改为与表行数一致的「该项」 | 「未复原项（明确取舍）」 |
| B5 | 更正 `viewportWindowSize()` 「与实测脚本共用」的不实说法：两处独立重算，用 `data-expected-rows` 交叉断言与单元测试钉住期望值 | 本文「虚拟列表高度反馈环」、`test/virtualList.test.tsx` |
| B6 | `capture.mjs` 记录意图路由而不是 `page.url()` | `scripts/capture.mjs` |
| B7 | `CHROME`/`BASE`/`OUT`/`VIEWPORT` 抽到 `scripts/evidence.mjs`；原型侧错误显式告警 | `scripts/evidence.mjs` 与四个脚本 |
| B8 | 记录 `getBoundingClientRect()` 为 transform 后测量的残余风险 | 未测边界 #13 |

## 第四次整改（两轴复核第四轮）

第四轮发现一处**未披露的功能回退**、一处被错误收窄的排除项与若干警告／文档漂移。本轮逐项处置，均附测试或可重跑证据。

### A 混合（Git＋普通目录）任务的目录可见性（未披露回退修复）

**问题。** `pages/TaskPage.tsx` 此前用 `isDirectoryOnlyTask(task)` 统一门控目录 UI，导致 **Git＋普通目录混合任务**（种子 `release`）的普通目录数、`添加目录` 入口与文件／终端目录选择器全部不可见、不可选。原型并非如此：`app.js` 的 `header()`（非目录分支）仍渲染 `button('添加目录','addrepo','','plus')` 及 `${taskDirectories().length?' · '+taskDirectories().length+' 个普通目录':''}`；`filesView()`/`terminalView()` 以 `(taskDirectories().length?directoryRootChoices():'')` 前置目录根选择器；`panel()` 在 `(directoryTask()||selectedDirectory())&&['files','terminal'].includes(state.tab)` 时切到目录面板。验收项 3 明确禁止「未注意到的回退」。

**修复。** 把目录 UI 的门控从「仅普通目录」改为「任何含普通目录的任务」；仅将 Git 分支／远程基线／worktree／差异／提交预算面保留在**非**仅目录任务：

| 复原点 | 实现位置 | 原型引用 | 测试／证据 |
| --- | --- | --- | --- |
| 任意含目录任务显示目录数徽章与 `添加目录` 入口 | `pages/TaskPage.tsx`（`hasDirectories`） | `app.js` `header()` | `test/directoriesFlow.test.tsx`「mixed Git + ordinary-directory task page」 |
| 文件／终端面板前置目录根选择器，选中目录切到目录面板，可返回仓库工作副本 | `pages/TaskPage.tsx`＋`components/ToolPanels.tsx`（导出并扩展 `DirectoryRootChoices`，`DirectoryFilesPanel`/`DirectoryTerminalPanel` 支持受控选择） | `app.js` `filesView()`/`terminalView()`/`panel()` | 同上（文件与终端两条用例）；截图 `renderer/task-mixed.png` |
| Git 预算面保留在混合任务 | `pages/TaskPage.tsx`（`availablePanels` 与运行／浏览器面板仍以 `directoryOnly` 为唯一排除条件） | `app.js` `header()` 非目录分支 | 同上（断言 `运行`/`浏览器` 按钮存在） |

> 说明：原型 `directoryRootChoices()` 逐仓库列出 worktree；渲染层文件面板本就是多仓库合并视图，故用一个「仓库工作副本」入口代表回切，不为每个仓库渲染一个语义相同的按钮。这是有意的形状收缩，已在此记录。

### B 服务启动配方与 `.vscode` 导入（内存复原）

| 复原点 | 实现位置 | 原型引用 | 测试／证据 |
| --- | --- | --- | --- |
| 环境 `recipes` 数据与 upsert／模拟导入 | `data/types.ts`（`ServiceRecipe`＋`Environment.recipes`）、`data/hostAdapter.ts`（`saveServiceRecipe`/`importVscodeConfig`）、`data/memoryHost.ts`（`atlasRecipes` 种子、名称校验、按已登记仓库生成示例）、`stores/host.ts` 包装 | `app.js` `environmentEditor()` 的 `服务启动配方` 块与 `从 .vscode 导入` 入口 | `test/adapter.test.ts`（upsert／空名校验／幂等导入） |
| `添加服务`／`编辑` 卡片与 `从 .vscode 导入` 入口 | `pages/EnvPage.tsx`（`服务启动配方` 面板＋配方卡片）、`components/Modals.tsx`（`service-recipe` 模态）、`stores/ui.ts`（`ModalState`） | `app.js` `environmentEditor()` | `test/env.test.tsx`（添加配方、导入到未引用环境） |

- **仍排除**（不实现）：真实仓库扫描、向仓库默认配置写入配方、进程启动；页面与文档均已标注，未复原项表已收窄为该一条。
- 原型 `从 .vscode 导入` 会先弹转换说明再引用示例配方；渲染层直接导入并 toast（内存模拟），属形状差异，已在逐页对照表 #6 归入「部分对齐」。

### C 警告与漂移

| # | 发现 | 处置 | 位置／证据 |
| --- | --- | --- | --- |
| C1 | `/env` 标「逐页对齐」但同行列明配方／导入缺失 | 复原后重核：因**环境新增／管理界面仍未复原**，改标「部分对齐」并写明剩余缺口（`ui-prototype-review.md:146`） | 本文逐页对照表 #6、「未复原项」后说明 |
| C2 | `/env` 始终显示「任务覆盖」标签页与独立任务下拉，可把覆盖存到不匹配的环境 | 按原型 `.filter(([k]) => (task() && task().envId === state.envId) || k !== 'task')`：仅当所选环境被任务引用时出现该标签页，任务下拉只列该环境的任务；环境不再匹配时回退到共享模板 | `pages/EnvPage.tsx`；`test/env.test.tsx` |
| C3 | 清理预览缺任务内软链接路径 | 加入软链接路径＋「保留原目录」原路径 | `data/memoryHost.ts` `previewCleanup`；`test/adapter.test.ts` |
| C4 | 新建任务表单无实时工作区／软链接路径预览 | 加入 pi 工作目录／worktree／软链接实时预览；预览的 `task-<8 位>` 键传给适配层，预览即实际创建路径 | `components/Modals.tsx`、`data/directories.ts`（`newWorkspaceKey`、`workspacePath` 可选段）、`data/hostAdapter.ts`+`data/memoryHost.ts`（`workspaceKey` 入参）；`test/modals.test.tsx` |
| C5 | 配置行 id `${key}-${index}` 可跨改名行碰撞／复用 | 改为单调序列 `nextConfigRowId()`，`envDrafts` 复用同一序列 | `data/configRows.ts`、`stores/envDrafts.ts`；`test/configRows.test.ts` |
| C6 | `evidence.mjs:evidencePath()` 为死导出 | 删除 | `scripts/evidence.mjs` |
| C7 | 状态表只列 5 个 store、漏 `envDrafts`；`memoryHost.ts` 行数过期 | 状态表补回 `envDrafts` 并说明草稿作用域与行 id；`memoryHost.ts` 行数更正为 1330、`Modals.tsx` 更正为 841 | 本文「状态职责边界」「保留的判断项」 |

## 未测边界（诚实清单）

以下**未在本轮验证**，不按通过理解：

1. **桌面环境 / 跨平台**：仅在本机 Chrome + Vite dev server 验证，未跑 Electron 44、utilityProcess、Windows。属 21 / 02 / 15 范围。
2. **真实 Host 数据**：全部数据为内存模拟；未连接 Pi AgentSession、未发网络请求、未读写真实文件。
3. **视觉尺寸**：截图与实测固定 1440×900；窄栏 / 375px / 窄窗、字体差异、中文输入法组合输入、键盘与焦点、浮层遮挡未做自动化断言。
4. **小集合豁免**：会话标签（≤4）未虚拟化，仅记录渲染行数；若未来会话标签数上限变化需重新评估。
5. **终端**：仅模拟命令回显，未接入 PTY / xterm.js；`runTerminalCommand` 不含真实执行。
6. **锚点跟随**：已在真实浏览器断言贴底/离底/回贴，并含一次真实滚轮手势与程序化滚动两条离底路径；未覆盖触控、滚动惯性抖动、超长单条消息等边界。
7. **π 居中**：已断言 1440×900、本机 Chrome 下字形中心与徽标中心对齐（偏移 0）；未在其他字体栈、DPI、操作系统的像素级渲染下验证，也未做基准图对比。
8. **并发 / 断线 / 时钟**：未验证多会话并发、断线重连、定时时钟补跑；适配层为内存单实例。
9. **代码高亮**：Shiki 在 jsdom 与 dev server 验证，未在 Electron 沙箱渲染进程中验证。
10. **已复原的原型流程的运行时部分**：环境作用域编辑、普通目录任务布局、混合任务目录可见性、服务启动配方表单与 `.vscode` 导入已在**内存**复原并验证；但落盘／权限／符号链接、真实仓库扫描、配方写入与进程启动仍**未实现也未验证**（见上）。环境新增／管理界面仍未复原（见逐页对照表 #6 与「未复原项」后的独立缺口说明）。
11. **错误留存范围**：`capture-errors.json` 显示渲染层 14 页无 page/console 错误（已补内联 favicon 消除唯一的 `/favicon.ico` 404）；原型侧静态服务器仍有一条同样的 favicon 404，因为 `prototypes/` 只读未修，不计入渲染层结论；`capture.mjs` 已对该原型侧错误显式告警（`prototypeErrorsAnnounced: true`）。
12. **普通目录的磁盘语义**：本轮只在内存复原布局与数据，**未验证** 目录真实存在性、读写权限、真实软链接创建、大小写别名（case alias）行为与原生目录选择；原型同样未验证这些（`ui-prototype-review.md:215`），原生目录选择属后续工单。
13. **`getBoundingClientRect()` 是 transform 之后的测量（残余风险）**：`resolveViewportHeight()` 的 rect 回退值是 `getBoundingClientRect().height`，会包含外层 `transform`（如 `scaleY()`）的效果。若未来调用方对虚拟列表施加 `scaleY()` 类变换，回写的会是变换后的高度。当前四个调用方都没有对列表施加变换，因此这是**待记录的风险而非缺陷**；若出现此类调用方，应改用 `borderBoxSize`/`contentBoxSize` 或 `offsetHeight`。

## 工具链

ESLint 工具链与 flat config 位于工作区根 `eslint.config.mjs`，依赖在根 `devDependencies`。根 `pnpm lint` 经 Turbo 执行渲染层 `eslint . --max-warnings 0`，非空跑且真实规则生效（含 react-hooks、`@typescript-eslint/no-unused-vars`）；`turbo.json` 的 lint inputs 已纳入根 `eslint.config.mjs` 与 `scripts/**`（本轮补上：证据脚本也会被 lint，改脚本不应命中旧缓存）。

## 实际运行过的确切命令

以下命令均在仓库根 `/Users/leonz3n/Workspace/github/pi-agent-ui` 执行，Node 版本经 PATH 显式固定为 24.21.0：

```bash
export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"

# 四道检查（第二轮整改后用 --force 重跑，确保不是缓存回放）
pnpm typecheck && pnpm typecheck --force
pnpm test && pnpm test --force
pnpm build && pnpm build --force
pnpm lint && pnpm lint --force

# 渲染层 dev server（端口 4335；4318 被本机 Docker 占用，勿改回）
pnpm --filter @pidock/renderer dev

# 单文件测试（TDD 时反复执行）
pnpm --filter @pidock/renderer exec vitest run src/test/virtualList.test.tsx
pnpm --filter @pidock/renderer exec vitest run src/test/tokens.test.ts

# 截图证据（需 dev server 在 4335、原型在 4319）；同时写入 capture-errors.json
node packages/renderer/scripts/capture.mjs

# 密集列表与令牌实测（需 dev server 在 4335）；直接写回 measurements.json 并在窗口不匹配时非零退出
node packages/renderer/scripts/measure-baseline.mjs

# 锚点跟随真实验证（含真实滚轮手势；需 dev server 在 4335）；写回 anchor-follow-verification.json
node packages/renderer/scripts/verify-anchor.mjs

# π 标记居中自动断言（需 dev server 在 4335）；写回 brand-mark-verification.json + renderer/brand-mark.png
node packages/renderer/scripts/verify-brand.mjs

# 原型只读对照服务（仅截图时启动，未修改 prototypes/）
python3 -m http.server 4319 --bind 127.0.0.1   # URL: http://127.0.0.1:4319/?variant=A
```

浏览器自动化一律使用 `playwright-core` + 本机 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`（脚本内可用 `CHROME_PATH` 覆盖），未下载任何浏览器。第三轮整改又用 `--force` 重跑了上述四道检查与四个证据脚本，并把完整输出（含三处变异验证）写入 [`docs/evidence/renderer-baseline-2026-09-22/verification-log.md`](evidence/renderer-baseline-2026-09-22/verification-log.md)。第四轮整改同样以 `--force` 重跑四道检查与四个证据脚本（新增 `task-mixed` 截图与四处变异验证），输出追加在 `verification-log.md` 的「第四轮整改验证」节。

## 本轮提交（第二轮整改）

第二轮整改按内容拆分提交，类型与 scope 与内容一致（上一轮 `666d043` 标为 `test(renderer)` 却包含 `Shell.tsx` 的生产修复，本轮不再混用）：

| 提交 | 类型 | 内容 |
| --- | --- | --- |
| `0ce7924` | `fix(renderer)` | 按 border box 测量虚拟列表高度，消除收缩反馈环；可控 `ResizeObserver` stub 与 9 例回归测试 |
| `ae2d496` | `fix(renderer)` | 恢复任务根目录绝对路径校验 |
| `08a6508` | `test(renderer)` | 两条收口规则断言、重命名保存路径断言、绿色检测扩宽 |
| `fc2afff` | `fix(renderer)` | 内联 favicon 消除渲染层 404 |
| `9e8e3c7` | `test(renderer)` | π 居中与真实滚轮验证、证据错误与期望值留存 |
| `e2c00fe` | `build(workspace)` | lint 缓存输入纳入证据脚本 |
| `521c68c` | `test(renderer)` | 重新生成实测、锚点与品牌证据 |

均提交在 `main`，未 push；未勾选 issue #3 验收项，未关闭 issue #3。

## 本轮提交（第三轮整改）

第三轮整改按内容拆分提交：

| 提交 | 类型 | 内容 |
| --- | --- | --- |
| `67b2357` | `fix(renderer)` | 单独发布 `data-declared-height` 并让实测断言高度不收缩；`capture.mjs` 记录意图路由、原型侧错误告警；证据脚本常量抽到 `scripts/evidence.mjs` |
| `b91be46` | `feat(renderer)` | 在内存适配层复原环境作用域编辑（作用域标签页/可编辑表/差异预览/版本递增）与普通目录项目与任务布局（登记校验与锁定、软链接快照、仅目录任务页、清理只保留目标） |
| `70e4f7a` | `test(renderer)` | 重新生成密集场景/锚点/品牌/截图证据，并写入 `verification-log.md` |
| （本次 docs 提交） | `docs(renderer)` | 删除两条错误的「明确取舍」并记录复原项；更正可复现性、共享函数与「这两项」措辞；记录 `getBoundingClientRect()` 残余风险 |

均提交在 `main`，未 push；未勾选 issue #3 验收项，未关闭 issue #3。

## 本轮提交（第四轮整改）

第四轮整改按内容拆分提交，类型与 scope 与实际内容一致：

| 提交 | 类型 | 内容 |
| --- | --- | --- |
| `b532d16` | `fix(renderer)` | 让混合（Git＋普通目录）任务显示并可选普通目录：头部徽章、`添加目录` 入口、文件／终端目录选择器与目录面板切换；新增混合路径组件测试 |
| `d025e81` | `feat(renderer)` | 在内存适配层复原服务启动配方（`Environment.recipes`、`saveServiceRecipe`、配方卡片／模态）与从 `.vscode` 导入（`importVscodeConfig`）；同文件内收敛 C2 任务覆盖作用域、C3 清理预览软链接路径、C4 新任务工作区／软链接实时预览 |
| `835fdf8` | `fix(renderer)` | 配置行 id 改为单调序列（C5）；删除 `evidence.mjs` 死导出（C6） |
| `e9e2538` | `test(renderer)` | 重新生成实测／锚点／品牌／截图证据（含 `task-mixed.png`）并追加 `verification-log.md` 第四轮输出 |
| （本次 docs 提交） | `docs(renderer)` | 记录混合任务目录回退修复与配方复原；`/env` 改标**部分对齐**并写明环境新增／管理仍未复原；未复原项收窄为「真实扫描／写入／启动」；状态表补 `envDrafts`；更正 `memoryHost.ts` / `Modals.tsx` 行数 |

均提交在 `main`，未 push；未勾选 issue #3 验收项，未关闭 issue #3。
