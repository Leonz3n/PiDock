# [UI 对齐 03] (#27) 任务工作区头部对齐原型 A 与纵向预算收敛 — 证据

本目录由 `capture-vertical.mjs` 生成（headless Chromium）：

```bash
# 渲染层 dev server 在 4335，原型 A 在 4319（只读）
node docs/evidence/ui-alignment-s2/capture-vertical.mjs
```

产物：`vertical-budget.json`（逐区块高度 / 消息区高度与占比 / 横向溢出 / 会话标签条是否裁切，**9 组状态** = 3 视口 × 3 面板态）、`renderer/*.png`（渲染层 **7 张**：1440×900 三种面板状态 + 1280×900 / 1024×800 的 1 面板态 + `任务操作` 菜单 + 普通目录任务）、`prototype/1440-prototype-A.png`（原型对照，1 张）。脚本输出写回本目录，可在任意 cwd 重跑。

## 1. 验收结论

| # | 验收项 | 结论 | 证据 |
| --- | --- | --- | --- |
| 1 | 头部按原型：`TASK WORKSPACE #<key>` eyebrow + 大标题 + 图标工具条 + 添加目录 + 启动/停止服务 + `···` + 单行 chips | COVERED | `TaskPage.tsx` 的 `TaskHeader`、`components/IconButton`（`ui.tsx`）、`components/TaskActionMenu.tsx`；截图 `renderer/1440-closed.png`；eyebrow 实测文本 `TASK WORKSPACE #a1f92c3d`（原型 `TASK WORKSPACE #001`；产品无任务序号，用去掉 `task-` 前缀的任务键充当，完整 `workspaceKey` 保留在 eyebrow 的 `title`） |
| 2 | 原文字按钮行消失；所有原入口仍可达 | COVERED | 见 §3 映射表；`taskHeaderFlow.test.tsx` 断言 `getAllByRole("button",{name:"运行"})` 长度 1、未开菜单时不存在「归档当前任务」「审阅与交付」按钮 |
| 3 | `···` 收纳次要/破坏性动作，键盘可达 | COVERED | 菜单实测项：`["重命名任务","新建会话","查看全部会话","Subagent 列表（2）","管理仓库与目录","审阅与交付","归档当前任务"]`（`vertical-budget.json.menuItems`）；用例实测覆盖：点击打开、**Enter/Space 打开**（`taskHeaderFlow.test.tsx` 新增用例）、首项聚焦、`↓`/`↑`（含回绕）、`Home`、**`End`**、Esc 关闭并回焦、点击外部关闭；触发器不再带 `aria-pressed`（新增断言） |
| 4 | 纵向预算：1440×900 无面板 ≥400px（≥45%）；1 个面板 ≥330px | COVERED | **无面板 408px（45.3%）**、**1 个面板 374px（41.5%）**、6 个面板 374px（`vertical-budget.json.states["1440x900-*"]`） |
| 5 | Subagent 卡区不常占高度 | COVERED | 仅在当前会话存在 Subagent 时渲染（`TaskPage.tsx` 条件 + `SessionSubagentList` 空数组返回 null，`restoredFlows.test.tsx`「切换会话后子代理列表消失」用例仍覆盖），且压缩为单行卡片：122px → **78px**（原型同区块 117px） |
| 6 | 输入区不因本切片变高（≤150px @1440×900 空内容） | COVERED（含披露） | 无面板 **145px** ✓；打开面板时 **179px** —— 该增长在切片前基线同样存在（窄列下两个控件簇折行），属 S4「输入框与附件」范围，本切片未改输入区 |
| 7 | 会话标签改用 `below-*` 断点 | COVERED（含裁切残留，见 §6.8） | `TaskPage.tsx` 非活跃标签 `flex below-mid:hidden`（原 `hidden md:flex`）；标签行改为不折行：`Badge` 加 `whitespace-nowrap` 后 **9 组状态全部 32px**（修复前 1280/1024 开面板时为 48px，见 §2）。收尾轮补 `session-tab-strip` 的 `scrollWidth <= clientWidth` 断言：1440 全档与所有视口的无面板态 **不裁切**，1280/1024 开面板时仍裁切 41px / 149px（§6.8） |
| 8 | 底部摘要栏按时降级 | COVERED | `ShellSummaryBar.tsx`：≤960 隐藏浏览器控制者段、≤720 隐藏服务段并收紧 padding/gap（原型 `.switcher .state{display:none}`、`@media(max-width:720px){.switcher{gap:2px;padding:6px}}`） |
| 9 | 顺带修 #26 两条 P2 | COVERED | `Shell.tsx`：页类页面中间档改四边 `p-[25px]`；子代理独立栏 ≤720 改 `below-stack:min-h-[620px]`（原型 `.subagent-sidebar{height:620px}`），工具面板仍 `below-stack:min-h-[500px]` |
| 9b | 原型保真补充：非普通目录任务的 `启动/停止服务` 始终渲染 | COVERED | 无本地服务时 `disabled` + `title="当前任务没有本地服务"`（原型 `toggle-run` 无条件渲染）；用例：把全部本地服务切为 `remote` 后断言按钮存在、禁用、title 正确 |
| 10 | 既有用例零回归 + 新增用例 | COVERED | renderer **46 文件 / 395 例**（切片前 45/384；`taskHeaderFlow.test.tsx` 9 → 11 例）；改动既有用例 2 处，断言未减弱：`restoredFlows.test.tsx` 交付流程改从菜单进入（入口按本切片迁移），`modals.test.tsx`「新建任务后显示预览键」改为断言 `#<key>` 形式 + `title` 仍含完整 `task-…` 键 |
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
| 1440×900 会话标签行 | 32px | 32px |
| 1440×900 Subagent 卡区 | 122px | **78px** |
| 1440×900 输入区 | 145px（无面板）/ 179px（有面板） | 145px / 179px（未改） |
| 横向溢出 | 无 | 无（**9 组状态**全部 `noHorizontalOverflow = true`） |

### 收尾修复轮（标签行折行，`Badge` 加 `whitespace-nowrap` 前后）

| 状态 | 标签行 before | 标签行 after | 消息区 before | 消息区 after |
| --- | --- | --- | --- | --- |
| 1440×900 closed / one / all | 32 / 32 / 32 | 32 / 32 / 32 | 408 / 374 / 374 | 408 / 374 / 374 |
| 1280×900 closed / one / all | 32 / **48** / **48** | 32 / **32** / **32** | 408 / 358 / 358 | 408 / **374** / **374** |
| 1024×800 closed / one / all | 32 / **48** / **48** | 32 / **32** / **32** | 274 / 218 / 218 | 274 / **234** / **234** |

根因：压缩后的会话标签内 CJK `Badge`（`已归档`/`只读`/写入角色）可折行，把 32px 标签行撑到 48px；`Badge` 加 `whitespace-nowrap` 后全部状态回到 32px，窄档消息区因此回收 16px。1440×900 的验收指标未受影响（每档均为 32px）。

### 收尾修复轮二（本轮：eyebrow 空格 / 禁用态 / 服务行按钮 / 标签条断言）

| 项 | before | after |
| --- | --- | --- |
| eyebrow 可访问文本 | `TASK WORKSPACE#a1f92c3d`（无空格） | `TASK WORKSPACE #a1f92c3d`（补齐原型同时具备的空格 + `margin-left:8px`） |
| 零本地服务时的 `启动/停止服务` | `disabled` 但保留 primary 外观 | `Button` 基类统一 `disabled:opacity-50 disabled:cursor-not-allowed` |
| 工具面板服务行操作按钮 @1440 开 1 面板 | `停止` / `改为远程` 被压成竖排 1–2 字 | 操作组 `shrink-0 whitespace-nowrap`、按钮 `shrink-0`；服务名 `shrink-0`、位置与实例地址 `truncate` → 单行完整（见 `renderer/1440-one-panel.png`、`renderer/1024-one-panel.png`） |
| 会话标签条裁切断言 | 无（只有页面级 `scrollWidth`） | `states[*].tabStrip = { scrollWidth, clientWidth, noClip }` |

服务行验证方式：`serviceTopologyFlow.test.tsx` 断言行内 `span.truncate` 存在、实例地址带 `truncate`、`停止` 按钮及其操作组带 `shrink-0`/`whitespace-nowrap`（jsdom 无布局，故配截图；截图已随本目录刷新）。

### 各档全量（本切片 = #27 时点；后续切片刷新后的现值见 §2.9）

| 视口 | 无面板 | 1 面板 | 6 面板 |
| --- | --- | --- | --- |
| 1440×900 | 408px（45.3%） | 374px（41.5%） | 374px |
| 1280×900 | 408px（45.3%） | 374px（41.5%） | 374px |
| 1024×800 | 274px（34.2%） | 234px | 234px |

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

### 2.9 后续切片刷新后的复测（#32 收口轮，2026-09-24）：测量基准与下限断言

本节上方的 §2 各表是 **#27 交付时点**的实测（当时任务页还没有执行状态卡）。此后 `b410e6b`（[UI 对齐 08] #32 的证据刷新）重跑了本脚本，数值随之变成后续切片的几何；#32 收口轮又把**测量基准**写进脚本与 JSON，并补上此前缺失的下限断言。

| 视口 / 状态 | #27 时点 | 现值（`messagesH`，**含**执行状态卡） | 现值（`cardFreeMessagesH`，等效去卡） | 卡片 |
| --- | --- | --- | --- | --- |
| 1440×900 closed | 408px | **384px** | **443px** | 53px |
| 1440×900 one / all | 374px | **384px** | **443px** | 53px |
| 1280×900 closed / one / all | 408 / 374 / 374 | **384px** | **443px** | 53px |
| 1024×800 closed | 274px | **284px** | 343px（该档无下限，仅记录） | 53px |
| 1024×800 one / all | 234px | **251px** | 310px（同上） | 53px |

读懂这张表需要三点，都已写入脚本与 JSON：

1. **基准差异**：现值的 384px 是该状态**含一张 53px 跨会话执行状态卡**的测量（该卡由 [UI 对齐 05] #29 验收第 5 项要求，会话空闲而本任务另一会话执行中/等待确认时出现，实测文案「空闲 ·「部署审查」正在执行或等待确认…」）。脚本现在逐状态记录 `cardH` / `cardText` / `cardFreeGap` / `cardFreeMessagesH`，读的人不必猜。
2. **与 #27 的 ≥400px 的关系**：#27 的下限是在**无执行状态卡**的状态被接受的，等效去卡值 **443px ≥ 400px**（对比 #27 时点的 408px 是 **+35px**），改善来自后续切片的区块压缩（子代理条 78 → 51px、会话标签行 32 → 28px、输入区 145 → 143px；三处均取自本节同 harness 的 rows 实测）。含卡片时按 #29 的双档（审批/过期 ≥340px、带既有 chrome ≥300px）判定，见 `ui-alignment-s3/verification-log.md`。
3. **`1440x900 one/all` 与 `closed` 同高是正确行为**，不是面板没打开：父侧独立实测开面板后对话列宽 **1146 → 637px**（工具区确实打开），而 1440 档子代理卡在两种列宽下仍各排 2 列、条高不变；1024 档两者仍不同（284 vs 251）。

**下限断言（本轮新增）**：脚本对**所有 900px 高的档位**（`1440x900-*` 与 `1280x900-*`，共 **6** 个状态）断言 `cardFreeMessagesH ≥ 400`，违例即写入 `assertions.violations` 并 `process.exit(1)`；JSON 里新增 `assertions = { checked: 6, violations: [], floor: { cardFree: 400 } }`。800px 高的 `1024x800-*` 只记录不断言（该档去卡值 343 / 310，不在 #27 的口径内；#27 的下限是在 900px 高的窗口上接受的）。

负向验证（证明断言真的会失败，而不是永远绿）：把脚本复制到同目录临时文件、把 `MESSAGES_FLOOR_NO_CARD` 改成 `500` 后重跑 → `exit 1`，输出**六条** `card-free message area 443px < the 500px floor`；验证后已删除临时文件并重跑还原 JSON。

此前这条链上没有任何断言（`b410e6b` 的刷新把 408 改成 384，脚本仍然 exit 0），这正是本轮补断言的原因。

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

- `packages/renderer/src/components/ui.tsx`：新增 `IconButton`（原型 `.iconbtn` 28px、hover `#e9eded`、选中用柔和强调色；React 19 下 `ref` 作为普通 prop 传入）；`aria-pressed` 仅在显式传入 `selected` 时输出（菜单触发器不再自称开关）；`Badge` 加 `whitespace-nowrap`（窄栏不折行）；`Button` 基类加 `disabled:cursor-not-allowed disabled:opacity-50`（禁用态可见）。
- `packages/renderer/src/components/ToolPanels.tsx`：`SessionSubagentList` 单行卡片（摘要以 `title` 保留）；服务行改为「左按钮 `min-w-0 flex-1` + 名称 `shrink-0` + 位置/实例地址 `truncate`」与「操作组 `shrink-0 whitespace-nowrap`」，操作按钮不再被压成竖排。
- `packages/renderer/src/components/Icon.tsx`：新增 `branch/server/terminal/file/link/more/play/stop`（路径取自原型 `app.js` `paths`）；协议面板用 `link`（原型无协议工具，见文件内注释）；`play`/`stop` 用于头部的本地服务开关（原型 `toggle-run`）；未使用的 `check` 已删。
- `packages/renderer/src/components/TaskActionMenu.tsx`：`···` 菜单（`role="menu"`、首项聚焦、方向键/Home/End、Esc 回焦、外点关闭）。
- `packages/renderer/src/pages/TaskPage.tsx`：头部重写；删除文字按钮行；头部移到 `task-body` 之上（原型 `.main > .taskheader + .taskbody`）；工具条图标按钮；本地服务批量开关；会话标签断点与不折行；子代理栏 ≤720 高度；子代理卡片压缩为单行；eyebrow 补空格；会话标签条加 `data-testid="session-tab-strip"`（供证据断言）。
- `packages/renderer/src/components/ToolPanels.tsx`：`SessionSubagentList` 单行卡片（摘要以 `title` 保留）。
- `packages/renderer/src/components/Shell.tsx`：任务视图去掉纵向页面内边距（保留水平内边距），页类页面中间档改四边 `25px`。
- `packages/renderer/src/components/ShellSummaryBar.tsx`：窄档降级。

## 5. 门禁（`pnpm turbo run typecheck test build lint --force`）

```
Tasks:    8 successful, 8 total
@pidock/shell:    Test Files 54 passed (54)   Tests 801 passed (801)
@pidock/renderer: Test Files 46 passed (46)   Tests 395 passed (395)
```

（收尾修复轮后重跑：renderer 46 文件 / 395 例；shell 未改动，54 / 801。）

## 6. 未测 / 未做（如实记录）

1. **输入区在有工具面板时为 179px**（>150px）：折行来自输入区两个控件簇（`上下文 …`、`模型 …` 标签过长），切片前基线同样如此；属 S4「输入框与附件」范围，本切片未改输入区。1440×900 无面板时为 145px ✓。
2. **1024×800 档消息区 234-274px**：验收只对 1440×900 定指标；1024 是 S0 的降级档，此处仍可用但更紧凑。
3. **未在 Electron 打包运行时验证**：全部几何数据来自 dev server（4335）+ headless Chromium；`minWidth` 窗口行为属 S0（#26）。
4. **未做像素级对比**：只比结构、文本、区块高度与可访问名，未做图像 diff。
5. **`重命名任务` / `查看全部会话` / `新建会话` 菜单项**：复用既有模态与既有 `createSession`；菜单本身的键盘用例覆盖，但「新建会话」在菜单中的创建结果未单独断言（既有会话标签的创建流程仍有用例）。
6. **无本地服务的任务**：种子任务均有本地服务，`启动/停止服务` 的 `disabled` 分支只在把全部本地服务切为 `remote` 后可达（用例即这么做）；真实仓库中零本地服务任务的头部观感未做截图。
7. 原型数值取自 4319 原型服务（只读），未修改 `prototypes/**`。
8. **会话标签条在窄栏会裁切（新发现，本轮断言实测）**：`session-tab-strip` 为 `overflow-hidden` 且无横向滚动，`Badge` 不再折行后多余宽度由标签条自己吃掉：

   | 状态 | scrollWidth | clientWidth | 裁切 |
   | --- | --- | --- | --- |
   | 1440×900（closed/one/all） | 972 / 463 / 463 | 972 / 463 / 463 | **0px** |
   | 1280×900 closed / one / all | 812 / 413 / 413 | 812 / **372** / **372** | 0 / **41px** / **41px** |
   | 1024×800 closed / one / all | 590 / 413 / 413 | 590 / **264** / **264** | 0 / **149px** / **149px** |

   可见后果：`renderer/1024-one-panel.png` 中「历史排查」标签被截断（无滚动提示、无法滑出）。1440×900 的验收指标不受影响（0px），但这是本轮新增断言暴露的**真实残留**，未擅自扩大范围修改：候选修法（需父流程定）——(a) 标签条改 `overflow-x-auto` + 隐藏滚动条；(b) 标签按钮改 `min-w-0` 允许进一步压缩（标签更早截断，但全部可见）；(c) 放不下时把非活跃标签收成「+N」计数入口。
