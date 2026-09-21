# 渲染层基线评审（#3 / 原 20）

2026-09-22。本记录覆盖渲染层基线（`packages/renderer`，`@pidock/renderer`）与静态草稿 `prototypes/pidock-ui/`（variant A 对话优先）的逐页对照、组件与许可证、状态职责边界，以及密集列表的实测数据。

对照截图证据：[`docs/evidence/renderer-baseline-2026-09-22/`](evidence/renderer-baseline-2026-09-22/)（renderer 12 张 + prototype 9 张）。原型只读保留，未修改。

## 与草稿的逐页对照

渲染层 12 个可截图页面 vs 原型 9 张页面截图。下表逐一给出映射关系；原型侧没有独立页面的渲染层页面，均记明「有意新增」及理由，不存在把疏漏当作取舍的情况。

| # | 渲染层页面（路由） | 原型对照 | 结论与差异理由 |
| --- | --- | --- | --- |
| 1 | 需要处理 `/attention` | 无独立页；原型为「需要处理」模态（`prototypes/pidock-ui/closure.js` 的 `attentionDialog()`，经侧栏按钮注入） | **有意升级为独立页面**。收口规则要求跨项目汇总，作为可深链、可过滤的一等页面比一次性模态更适合持续处理；过滤器（全部/待确认/失败/过期/完成未读）为新增，理由是把原型中分散的判定集中在同一视图。 |
| 2 | 项目总览 `/projects/atlas` | `prototype/project.png` | **逐页对齐**。Hero、统计卡、继续工作任务卡与草稿一致；差异仅在于按渲染层栅格做了密度收紧，为有意为之。 |
| 3 | 任务页·主会话 `/projects/atlas/tasks/release?session=main` | `prototype/task-main.png` | **逐页对齐**。A 对话优先布局：任务导航常驻、对话占主区、工具面板按需打开。 |
| 4 | 任务页·部署审批会话（`?session=deploy`） | 原型同一任务页的会话切换态（草稿固定数量演示，未单独截图） | **有意拆为可截图状态**。用 `session` 查询参数把「执行状态与审批」收口规则固化为可复现路由，便于验收；属于证据粒度细化，不是新增产品行为。 |
| 5 | 任务页·失败现场（`?session=failed`） | 原型同一任务页的失败态 | **有意拆为可截图状态**。理由同上：把「失败保留草稿」收口规则做成可深链、可重复截图的证据。 |
| 6 | 环境与服务 `/env` | `prototype/env.png` | **逐页对齐**。共享模板 / 本机私有 / 任务覆盖的分层与生效来源展示一致。 |
| 7 | Provider 与上下文 `/providers` | `prototype/providers.png` | **逐页对齐**。同一供应商多配置、模型与上下文占用分开记录保持一致。 |
| 8 | Token 用量 `/usage` | `prototype/usage.png` | **逐页对齐并有意加强**。筛选与明细列对齐草稿；明细改用虚拟滚动（见下「密集场景实测」），理由是把原型的固定条数改为可扩展实现。 |
| 9 | 定时任务 `/schedules` | `prototype/schedules.png` | **逐页对齐**。模板仅作新建起点、不自动启用保持一致。 |
| 10 | 能力管理 `/capabilities` | `prototype/capabilities.png` | **逐页对齐**。按 Skills / Extensions / Packages / MCP Servers 分类一致。 |
| 11 | 远程访问 `/remote` | `prototype/remote.png` | **逐页对齐**。主机主动连接、每设备独立撤销保持一致。 |
| 12 | 归档与清理 `/archive` | `prototype/archive.png` | **逐页对齐**。归档停止执行、恢复不自动启动、清理仅面向归档任务保持一致。 |

### 全局导航差异（有意）

- 渲染层侧栏（`packages/renderer/src/components/Shell.tsx`）把八个页面全部列为一级入口：需要处理 / 环境与服务 / Provider 与上下文 / Token 用量 / 定时任务 / 能力管理 / 远程访问 / 归档与清理。
- 原型侧栏标签不同（项目总览 / 环境与服务 / Token 用量 / 任务列表 / 已归档 / 本机设置 / 模型与 Provider，能力入口另经 `capabilityNavigation()` 注入）。**有意收敛**：渲染层去掉原型用于布局探索的重复/临时入口（如「本机设置」「任务列表」），改为与九个产品页面一一对应，避免导航与页面集合不一致。
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
| ESLint | 9.39.5 | MIT | 静态检查（工具链已上移到工作区根，见下） |
| typescript-eslint / `@eslint/js` / `eslint-plugin-react-hooks` / `globals` | 8.70.1 / 9.39.5 / 7.1.1 / 17.12.0 | MIT | ESLint flat config 规则 |
| Turborepo | 2.11.2 | MPL-2.0 | 工作区任务编排 |
| pnpm | 11.22.0 | MIT | 包管理 |
| playwright-core（仅证据脚本） | 1.63.0 | Apache-2.0 | 截图与实测脚本，复用本机 Chrome，不下载浏览器 |

许可证复核方式：以上均为 package.json 声明中被 OSI 认可的开源许可；Turborepo 为 MPL-2.0（仅工具链，不进入产物代码路径）。所有依赖社区活跃、持续维护，符合工单「优先社区活跃、可长期维护」的要求。

## 状态职责边界

| 层 | 位置 | 职责 |
| --- | --- | --- |
| Zustand | `packages/renderer/src/stores/`（`host` / `events` / `navigation` / `drafts` / `ui`） | 界面状态与模拟 Host 展示投影缓存。`host` 缓存适配层的最新投影；`events` 订阅适配层事件流；`navigation` 解析/驱动 URL 路由；`drafts` 保存输入草稿与确认过期；`ui` 承载模态、Toast、过滤器等局部界面状态。 |
| HostAdapter | `packages/renderer/src/data/hostAdapter.ts` + `memoryHost.ts` | 执行、审批、权限、调度、归档等业务语义全部在适配层之后；组件不直接实现这些逻辑，只经 store 读取投影并发起意图。适配器可替换，渲染层不预设与真实 Host 的协议。 |
| TanStack Virtual | `packages/renderer/src/components/VirtualList.tsx` | 仅用于长列表（Token 用量明细、会话列表）。读 `data-total-rows` / `data-virtualized` 暴露数据行数与虚拟化开关；最多四个会话标签等小集合不强制虚拟化。 |
| Shiki | `packages/renderer/src/components/CodeBlock.tsx` | 仅代码高亮。惰性加载 core + bash/json/ts/tsx 语法与 github-light 主题；加载失败回退到 `<pre>`，不阻断对话渲染。 |

补充说明：

- TanStack 仅引入 `@tanstack/react-virtual`，未默认加入 Router / Query / Table / Form / Store；渲染层路由由 `navigation` store 直接读写 `history` 实现（`packages/renderer/src/stores/navigation.ts`）。
- 数据全部来自内存模拟 Host（`memoryHost.ts`），不连接 Host、不发网络请求、不读写真实文件；`HostAdapter` 为唯一替换接缝，真实协议留待 02 定义。

## 密集场景实测

数据来源：模拟 Host（`packages/renderer/src/data/memoryHost.ts`），`makeUsage(240)` 生成 240 条 Token 记录；`seedSessions()` 中 `release` 任务含 4 个会话（main / deploy / failed / archived-1，其中 archived-1 已归档）。

| 场景 | 数据行数 | 视图行数 | 实际渲染行数 | 虚拟化 |
| --- | --- | --- | --- | --- |
| Token 用量明细（`/usage`，`data-testid="usage-table"`） | 240 | 240（全部 Provider / 全部任务） | 17 | true |
| 会话列表（`/projects/atlas/tasks/release?session=main` → 全部会话模态，`data-testid="session-list"`） | 4（默认「未归档」过滤后 3） | 3 | 3 | true |

测量方法：在运行中的开发服务器上用 `playwright-core` 复用本机 Chrome 打开页面，读取目标容器上的 `data-total-rows` 与 `data-virtualized`，并统计带 `translateY` 内联样式的行元素数量作为实际渲染行数。会话列表按默认「未归档」过滤展示 3 行，故数据行数记 4、过滤后视图 3 行；3 行均小于视口，全部渲染且仍标记 `data-virtualized="true"`。脚本：`packages/renderer/scripts/measure-baseline.mjs`。

实测输出（2026-09-22，dev server 端口 4335）：

```json
{
  "tokens": {
    "accent": "#233c78",
    "bg": "#f6f7f8",
    "ink": "#252b30",
    "bodyBackground": "rgba(0, 0, 0, 0)",
    "shellBackground": "rgb(246, 247, 248)",
    "headingText": "需要处理",
    "headingColor": "rgb(37, 43, 48)"
  },
  "usage": { "total": 240, "virtualized": "true", "rendered": 17 },
  "sessions": { "total": 3, "virtualized": "true", "rendered": 3 },
  "errors": []
}
```

说明：`body` 背景为透明（`rgba(0, 0, 0, 0)`），实色背景由 Shell 根容器提供（`rgb(246, 247, 248)`，即 `--color-bg` #f6f7f8）；h1 文本「需要处理」，其前景色 `rgb(37, 43, 48)` 与 `--color-ink` #252b30 一致。

## 设计令牌与「无绿色」的程序化证据

为避免仅凭肉眼判定，新增单测 `packages/renderer/src/test/tokens.test.ts`：解析 `src/styles/tokens.css` 中的全部颜色令牌，转 HSL 后拒绝落在绿色相区间（色相 75°–165°、饱和度 ≥ 0.12）的颜色，并断言 `--color-accent` 落在蓝色带（色相 200°–260°）且 CSS 中不出现 green/lime/emerald 等关键字。该测试先红后绿（注入 `#22c55e` 时 2 项失败），纳入 `pnpm test` 常规执行。

实测令牌值：`--color-accent` #233c78（蓝）、`--color-bg` #f6f7f8、`--color-ink` #252b30；body 背景透明，Shell 根容器实测 `rgb(246, 247, 248)`；页面 h1 文本「需要处理」，颜色 `rgb(37, 43, 48)`。全量令牌（`--color-bg/paper/ink/muted/line/accent/soft/sidebar/orange`）均不在绿色带内。

## 收口规则的可演示位置

工单要求七条收口规则全部可演示。下表给出每条规则的入口与自动化证据：

| 收口规则 | 演示入口 | 证据 |
| --- | --- | --- |
| 会话执行状态与审批 | 任务页 `/projects/atlas/tasks/release?session=deploy` | `adapter.test.ts`「only executes an explicitly approved request」；`app.test.tsx`「reviews a concrete approval payload and expires it without executing」 |
| 失败保留草稿 | 任务页失败会话 + 失败后重试 | `stores.test.ts`「keeps the draft and references in the draft store after a failed run」；`app.test.tsx`「retains a draft and references when a run fails」 |
| 确认过期 | 任务页过期确认态（`packages/renderer/src/pages/runState.ts`） | `adapter.test.ts`「expires pending approvals and stops services when a task is archived」 |
| 跨项目「需要处理」 | `/attention` 独立页面（按类型过滤） | `adapter.test.ts`「keeps cross-project attention items pointing at their task and session」 |
| 会话搜索与归档 | 任务页「全部会话」模态：搜索框 + 未归档/已归档分组 | `Modals.tsx` 会话列表（虚拟化）与过滤选项 |
| 按服务查看生效配置来源 | `/env` 服务表「来源」列 | `EnvPage.tsx` 生效来源展示 |
| 归档任务清理清单预览 | `/archive` → 「预览清理清单」模态 | `adapter.test.ts`「only previews cleanup for archived tasks and retains code conservatively」 |

## 交互与视觉验证

工单要求验证流式文本更新、长列表滚动锚点与代码片段展示：

- **流式文本更新**：适配层按序发出 delta，`events` store 追加到同一条 agent 消息并以 `streaming` 标记，settle 后清除标记（`packages/renderer/src/stores/events.ts`）。自动化证据：`adapter.test.ts`「streams agent output as ordered deltas before the run settles」。
- **长列表滚动锚点**：对话区在用户停留底部时自动跟随流式输出，用户上滚后不打断（`packages/renderer/src/pages/TaskPage.tsx` 的 `pinned` 判定，距底 < 48px 视为贴底）。此项以开发服务器人工走查 + 代码检视确认；受 jsdom 无布局限制，暂无自动化断言，属已知验证边界。
- **代码片段展示**：`CodeBlock.tsx` 惰性加载 Shiki core + bash/json/ts/tsx + github-light，失败回退 `<pre>`。自动化证据：`codeblock.test.tsx`「highlights a snippet in-process without Node built-ins」。

**π 标记居中**：Shell 侧栏品牌标记用 `grid h-9 w-9 place-items-center rounded-full` 包裹 `π` 字形，按栅格居中而非文字基线，避免原型早期出现的下沉；截图中可见（`docs/evidence/renderer-baseline-2026-09-22/renderer/*.png`）。

## 工具链上移

ESLint 工具链与 flat config 已从 `packages/renderer/eslint.config.js` 上移到工作区根 `eslint.config.mjs`，依赖（`eslint`、`@eslint/js`、`typescript-eslint`、`eslint-plugin-react-hooks`、`globals`）移入根 `devDependencies`。根 `pnpm lint` 经 Turbo 执行渲染层 `eslint . --max-warnings 0`，非空跑且真实规则生效（含 react-hooks、`@typescript-eslint/no-unused-vars`）；`turbo.json` 的 lint inputs 已纳入根 `eslint.config.mjs`，避免配置变更漏缓存。

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

# 原型只读对照服务（仅截图时启动，未修改 prototypes/）
python3 -m http.server 4319 --bind 127.0.0.1   # URL: http://127.0.0.1:4319/?variant=A
```

浏览器自动化一律使用 `playwright-core` + 本机 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`，未下载任何浏览器。
