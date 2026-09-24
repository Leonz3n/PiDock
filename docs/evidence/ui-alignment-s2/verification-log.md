# [UI 对齐 03] (#27) 任务工作区头部对齐原型 A 与纵向预算收敛 — 证据

本目录由 `capture-vertical.mjs` 生成（headless Chromium）：

```bash
# 渲染层 dev server 在 4335，原型 A 在 4319（只读）
node docs/evidence/ui-alignment-s2/capture-vertical.mjs
```

产物：`vertical-budget.json`（逐区块高度 / 消息区高度与占比 / 横向溢出）、`renderer/*.png`（渲染层 1440×900 三种面板状态 + `任务操作` 菜单 + 普通目录任务）、`prototype/1440-prototype-A.png`（原型对照）。脚本输出写回本目录，可在任意 cwd 重跑。

## 1. 验收结论

| # | 验收项 | 结论 | 证据 |
| --- | --- | --- | --- |
| 1 | 头部按原型：`TASK WORKSPACE #nnn` eyebrow + 大标题 + 图标工具条 + 添加目录 + 启动/停止服务 + `···` + 单行 chips | COVERED | `TaskPage.tsx` 的 `TaskHeader`、`components/IconButton`（`ui.tsx`）、`components/TaskActionMenu.tsx`；截图 `renderer/1440-closed.png`；eyebrow 实测文本 `TASK WORKSPACE task-a1f92c3d`（原型 `TASK WORKSPACE #001`，本任务无序号，改用 workspaceKey） |
| 2 | 原文字按钮行消失；所有原入口仍可达 | COVERED | 见 §3 映射表；`taskHeaderFlow.test.tsx` 断言 `getAllByRole("button",{name:"运行"})` 长度 1、未开菜单时不存在「归档当前任务」「审阅与交付」按钮 |
| 3 | `···` 收纳次要/破坏性动作，键盘可达 | COVERED | 菜单实测项：`["重命名任务","新建会话","查看全部会话","Subagent 列表（2）","管理仓库与目录","审阅与交付","归档当前任务"]`（`vertical-budget.json.menuItems`）；用例覆盖 Enter/Space 打开、方向键/Home/End 循环、Esc 关闭并回焦、点击外部关闭 |
| 4 | 纵向预算：1440×900 无面板 ≥400px（≥45%）；1 个面板 ≥330px | COVERED | **无面板 408px（45.3%）**、**1 个面板 374px（41.5%）**、6 个面板 374px（`vertical-budget.json.states["1440x900-*"]`） |
| 5 | Subagent 卡区不常占高度 | COVERED | 仅在当前会话存在 Subagent 时渲染（`TaskPage.tsx` 条件 + `SessionSubagentList` 空数组返回 null，`restoredFlows.test.tsx`「切换会话后子代理列表消失」用例仍覆盖），且压缩为单行卡片：122px → **78px**（原型同区块 117px） |
| 6 | 输入区不因本切片变高（≤150px @1440×900 空内容） | COVERED（含披露） | 无面板 **145px** ✓；打开面板时 **179px** —— 该增长在切片前基线同样存在（窄列下两个控件簇折行），属 S4「输入框与附件」范围，本切片未改输入区 |
| 7 | 会话标签改用 `below-*` 断点 | COVERED | `TaskPage.tsx` 非活跃标签 `flex below-mid:hidden`（原 `hidden md:flex`）；标签行改为不折行（48px → **32px**） |
| 8 | 底部摘要栏按时降级 | COVERED | `ShellSummaryBar.tsx`：≤960 隐藏浏览器控制者段、≤720 隐藏服务段并收紧 padding/gap（原型 `.switcher .state{display:none}`、`@media(max-width:720px){.switcher{gap:2px;padding:6px}}`） |
| 9 | 顺带修 #26 两条 P2 | COVERED | `Shell.tsx`：页类页面中间档改四边 `p-[25px]`；子代理独立栏 ≤720 改 `below-stack:min-h-[620px]`（原型 `.subagent-sidebar{height:620px}`），工具面板仍 `below-stack:min-h-[500px]` |
| 10 | 既有用例零回归 + 新增用例 | COVERED | renderer **46 文件 / 393 例**（切片前 45/384，新增 `taskHeaderFlow.test.tsx` 9 例）；唯一改动既有用例：`restoredFlows.test.tsx` 交付流程改从菜单进入（入口按本切片迁移，断言未减弱） |
| 11 | 证据提交进 `docs/evidence/**` | COVERED | 本目录 |
| 12 | 门禁全绿 | COVERED | §4 |

## 2. 纵向预算实测（headless Chromium，`vertical-budget.json`）

### 切片前后（同一任务页 `release`）

| 视口 / 状态 | before（父侧在 `324d75d` 实测，见 #27 背景） | after（本切片实测） |
| --- | --- | --- |
| 1440×900 无面板 · 消息区 | 305px（33.9%） | **408px（45.3%）** |
| 1440×900 1 面板 · 消息区 | 237px | **374px（41.5%）** |
| 1440×900 无面板 · 头部（含原文字按钮行） | 45 + 26 = 71px | **106px**（单块，含 eyebrow/标题/actionset/meta） |
| 1440×900 1 面板 · 头部 | 63 + 42 = 105px | **106px**（与宽度无关） |
| 1440×900 会话标签行 | 32px | 32px（1280 时由 48 → 32） |
| 1440×900 Subagent 卡区 | 122px | **78px** |
| 1440×900 输入区 | 145px（无面板）/ 179px（有面板） | 145px / 179px（未改） |
| 横向溢出 | 无 | 无（12 组状态全部 `noHorizontalOverflow = true`） |

### 各档全量（本切片）

| 视口 | 无面板 | 1 面板 | 6 面板 |
| --- | --- | --- | --- |
| 1440×900 | 408px（45.3%） | 374px（41.5%） | 374px |
| 1280×900 | 408px（45.3%） | 358px（39.7%） | 358px |
| 1024×800 | 274px（34.2%） | 218px | 218px |

1000px 以上头部恒为 **106px**（原型结构：`.taskheader` 位于对话/工具栏分栏之上，宽度与是否开面板无关）。

### 原型 A 同视口对照（同一次运行实测）

| 区块 | 原型 A @1440×900 | 本实现 |
| --- | --- | --- |
| `.taskheader` | 127px | 106px |
| `.taskheader .meta` | 21px | 22px |
| `.sessions` / 会话标签行 | 43px | 32px |
| `.session-subagents` / Subagent 卡区 | 117px | 78px |
| `.composer-wrap` / 输入区 | 167px | 145px |
| `.messages` | 256px | 408px |

说明：原型 `.messages` 较小是因为它的默认演示态在消息上方还有空状态/日期块，且头部与输入区更高；本实现各带状区块均不高于原型，消息区因此更大。原型数值为本次同 harness 实测，不是引用文档。

## 3. 旧入口 → 新位置映射表

| 旧入口（文字按钮行） | 新位置 |
| --- | --- |
| `Subagent N`（文字按钮） | actionset 图标按钮（`branch` 图标，`aria-label="查看 Subagent，共 N 个"`）+ `···` 菜单「Subagent 列表（N）」 |
| `添加目录` | actionset 文字按钮（保留）+ `···` 菜单「管理仓库与目录」（同一 `task-sources` 模态） |
| `审阅与交付` | `···` 菜单（混合任务且未归档时出现） |
| `运行` / `协议` / `浏览器` / `文件` / `终端` / `日志` | actionset 图标工具条（每个按钮保留原可访问名；`aria-pressed` 表示已打开） |
| `归档当前任务` | `···` 菜单 |
| （无） | actionset 新增「启动本地服务 / 停止服务」——原型 `toggle-run`，对全部本地服务调用既有 `setServiceRunning`；只读会话拒绝并提示 |
| 头部「仓库：…」（仓库名列表） | 移出头部；文件面板 `仓库工作副本` / 面板内 `仓库` 行仍显示 |
| 头部「目录：/…/task-…」 | 移出头部可见文本；保留为 eyebrow 的 `title`（悬停显示完整任务根目录），文件/终端面板显示工作目录与实际 cwd |
| 头部「代码变化：N 个文件」 | meta 行保留但压缩为「代码变化 N」 |

## 4. 机制与改动文件

- `packages/renderer/src/components/ui.tsx`：新增 `IconButton`（原型 `.iconbtn` 28px、hover `#e9eded`、选中用柔和强调色；React 19 下 `ref` 作为普通 prop 传入）。
- `packages/renderer/src/components/Icon.tsx`：新增 `branch/server/terminal/file/link/more/play/stop/check`（路径取自原型 `app.js` `paths`）；协议面板用 `link`（原型无协议工具，见文件内注释）。
- `packages/renderer/src/components/TaskActionMenu.tsx`：`···` 菜单（`role="menu"`、首项聚焦、方向键/Home/End、Esc 回焦、外点关闭）。
- `packages/renderer/src/pages/TaskPage.tsx`：头部重写；删除文字按钮行；头部移到 `task-body` 之上（原型 `.main > .taskheader + .taskbody`）；工具条图标按钮；本地服务批量开关；会话标签断点与不折行；子代理栏 ≤720 高度；子代理卡片压缩为单行。
- `packages/renderer/src/components/ToolPanels.tsx`：`SessionSubagentList` 单行卡片（摘要以 `title` 保留）。
- `packages/renderer/src/components/Shell.tsx`：任务视图去掉纵向页面内边距（保留水平内边距），页类页面中间档改四边 `25px`。
- `packages/renderer/src/components/ShellSummaryBar.tsx`：窄档降级。

## 5. 门禁（`pnpm turbo run typecheck test build lint --force`）

```
Tasks:    8 successful, 8 total
@pidock/shell:    Test Files 54 passed (54)   Tests 801 passed (801)
@pidock/renderer: Test Files 46 passed (46)   Tests 393 passed (393)
```

## 6. 未测 / 未做（如实记录）

1. **输入区在有工具面板时为 179px**（>150px）：折行来自输入区两个控件簇（`上下文 …`、`模型 …` 标签过长），切片前基线同样如此；属 S4「输入框与附件」范围，本切片未改输入区。1440×900 无面板时为 145px ✓。
2. **1024×800 档消息区 218-274px**：验收只对 1440×900 定指标；1024 是 S0 的降级档，此处仍可用但更紧凑。
3. **未在 Electron 打包运行时验证**：全部几何数据来自 dev server（4335）+ headless Chromium；`minWidth` 窗口行为属 S0（#26）。
4. **未做像素级对比**：只比结构、文本、区块高度与可访问名，未做图像 diff。
5. **`重命名任务` / `查看全部会话` / `新建会话` 菜单项**：复用既有模态与既有 `createSession`；菜单本身的键盘用例覆盖，但「新建会话」在菜单中的创建结果未单独断言（既有会话标签的创建流程仍有用例）。
6. 原型数值取自 4319 原型服务（只读），未修改 `prototypes/**`。
