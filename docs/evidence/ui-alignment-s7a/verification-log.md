# [UI 对齐 08] #32 验证记录 — 项目总览 / 生效来源 / 管理页几何基线

- 分支 `main`，起点 `45ed5e4`，本片提交 `cc5cd4e` → `853b71b` → `b7572f2` → `c8076a5` → `1c74c1c`（+ 证据提交）。
- 未 push。
- 证据脚本：`node docs/evidence/ui-alignment-s7a/capture-management.mjs`（可重跑，**退出码 0**，`165` 条断言 / `0` 违例，五档 viewport）。
- 数据：`management.json`（原型与实现的逐项实测）、`prototype/*.png`、`renderer/*.png`（五档 × 项目总览[仓库形态/目录形态/空态] + 项目管理弹窗 + 项目表单 + 生效来源 + 任务工作区入口）。

## 1. 几何基线实测（1440x900，左为渲染层实测，右为同一次运行里读到的原型 A）

| 选择器 | 实测（实现） vs 原型 |
| --- | --- |
| `.page` | `padding 30px 34px` vs `30px 34px`；`background rgb(251,251,252)` vs `rgb(251,251,252)`；`overflow-y auto` vs `auto` |
| `.page` @900 / @720 | `25px` / `20px` vs `25px` / `20px` |
| `.view-label` | `10px / letter-spacing 1.8px / uppercase / rgb(149,151,156) / margin-bottom 6px` vs 同值 |
| `.page-intro` | `12px / margin 6px 0 26px` vs 同值 |
| `.card` | `padding 20px / radius 10px / #fff / border 1px` vs 同值 |
| `.stat` | `28px / 550 / -1px / margin-top 9px` vs 同值 |
| `.grid2` / `.grid3` | 列数 2→1(@≤720) / 3→1(@≤960)；`gap 16px`；`grid3` 三列宽 `371.328px 371.328px 371.344px` = 原型同值 |
| `.check-row` | `padding 11px 0 / gap 10px / 12px` vs 同值 |
| `.management-list` / `.management-row` | `gap 10px` / `padding 13px 0, gap 14px` vs 同值 |
| `.note` | `10px / rgb(147,156,159) / margin-top 11px` vs 同值 |
| `.table th` / `.table td` | `padding 11px 13px, bg rgb(250,251,252), 10px/500/rgb(150,153,158)` / `padding 13px, 11px` vs 同值 |
| `.table` @720 | `min-width 650px` → 弹窗内容宽 `618px`，表格在 `overflow:auto` 的弹窗体内横向滚动，页面无横向溢出 |
| `.modal` | `width 660px`（五档均 `min(660, 100%)`）、`radius 13px` vs 同值 |
| 横向溢出 | 五档 ×（项目总览仓库形态 / 目录形态 / 空态 / 项目管理弹窗 / 项目表单 / 生效来源）全部 `scrollWidth ≤ clientWidth` |

## 2. 验收项逐条

| # | 验收项 | 结论 | 证据 |
| --- | --- | --- | --- |
| 1 | 项目总览页按原型 | **COVERED（含一处已声明偏离）** | `pages/ProjectPage.tsx:126`（目录形态）/ `:181`（仓库形态）：`view-label PROJECT` + 标题 + `page-intro`；仓库形态三张 `.stat` 卡（`statCount === 3` = 原型 3）、`项目仓库` `check-row`；目录形态 `项目目录` `.management-list` 5 行（4 `Git 仓库` + 1 `普通目录 · 软链接接入`，badge 文案与原型逐条相等）、`继续工作` 卡片文案 `4 个 Git 仓库 · 1 个普通目录`（与原型同正则）；无项目 → `项目` + `.empty`「创建第一个项目」；≤720 `.grid2 → 1fr`。偏离：`管理目录` 按钮打开本仓既有的「管理普通目录」弹窗，原型该按钮指向 `edit-project`（见 §4-D1） |
| 2 | 项目管理弹窗按原型 | **COVERED** | `Modals.tsx` `ProjectListModal`（`testId="projects-dialog"`）：`管理列表`每行「当前项目/切换」+「编辑」+「删除」、空态 `PageEmpty`、底部「新建项目」主按钮；删除走 `project-delete` 确认弹窗（不无确认删除）；证据 `rowEntries` 行内按钮数 = 原型行按钮数 |
| 3 | 项目表单按原型 | **COVERED** | `ProjectEditModal`（`testId="project-editor"`）：名称/说明/`关联已注册仓库` 复选框组；`disabledChoices ≥ 1`、`usedNotices ≥ 1`（「任务使用中」）；复选框 `15px` = 原型 `15px`，行用原型 `.check-row`（`padding 11px 0 / gap 10px` = 原型同值）；名称为空/重名有可读报错（既有用例） |
| 4 | 生效来源只读视图按原型 | **COVERED** | `EffectiveConfigModal`（`testId="effective-config-dialog"`）：表头 `KEY / 最终值 / 来源`；`任务名 · 环境 · 任务模板 v12`；服务选择器；5 行来源四类齐备（`仓库默认配置 · .env` / `共享模板 · 测试环境 · v12` / `本机私有配置 · ~/.pi/dock/config.json` / `任务覆盖` / `运行时端口绑定 · 本地`）；**只读**：仅 1 个 `select`、0 个可编辑输入、0 个「保存/确定」按钮，切换服务后行内容随之变化（`serviceSwitch.changed = true`）；入口：环境页工具栏 `data-testid="env-effective-config"` + 任务工作区运行面板 `tool-effective-config`（两者均实测打开） |
| 5 | note 文案 | **COVERED（一处措辞调整）** | 「仅展示已保存的应用配置；未保存草稿不参与。业务框架配置优先级与真实进程值需运行时核对。保存修改不代表运行中进程已加载，需显式重启受影响服务。」三条齐备；原型首句「示例解析」被去掉，因为本实现的解析来自 Host 真实分层而非示例行（见 §4-D2） |
| 6 | 管理页几何基线可复用 | **COVERED** | `components/Management.tsx`（`ViewLabel/PageTitle/SectionTitle/SectionHeader/PageIntro/Note/Card/CardStack/CardGrid/StatCard/InlineNotice/PreviewNote/PageEmpty/CheckRow/CheckField/TabRow/TableWrap/Table/Th/Td/ManagementList/ManagementRow/ManagementRowText`）；`.page` 内边距在 `components/Shell.tsx:41-46`；每个原语带原型类名做**标记类**，使证据脚本两侧读同一选择器；本片 S7b 未动页面（模型/用量/能力/远程/计划/归档）全部未改 |
| 7 | 只读/权限 | **COVERED** | 未新增任何 Host/RPC 写接口（`git show --stat` 五次提交均只动 `packages/renderer/**`）；生效来源弹窗无写入入口；项目表单沿用既有 `saveProject`；受限态（只读会话）仍由既有规则禁用按钮 |
| 8 | 纵向/横向健壮性五档 | **COVERED** | 见 §1 末两行（五档 22 个页面/弹窗组合无横向溢出；`.page` `overflow-y auto`） |
| 9 | 用例覆盖 | **COVERED** | renderer 57 文件 / **483** 例全绿（基线 54/463，+3 文件 / +20 例）：`test/managementPrimitives.test.tsx`、`test/projectOverview.test.tsx`（仓库形态 + 目录形态 + 空态 + 弹窗 + 表单校验）、`test/effectiveConfig.test.tsx`（表头/来源四类/只读/覆盖优先/服务切换/工作区入口）、`test/managementFlows.test.tsx`、`test/modals.test.tsx`、`test/env.test.tsx`、`test/app.test.tsx` |
| 10 | 证据提交 | **COVERED** | 本目录 |
| 11 | 既有用例零回归 | **COVERED** | `pnpm turbo run typecheck test build lint --force` 全绿（见 §3）；S1/S2/S3/S4/S5/S6 六个证据脚本重跑全部退出码 0 |
| 12 | 不新增绿色、不改原型、不做 S7b | **COVERED** | 原型目录零改动（五次提交 `--stat` 无 `prototypes/**`、无 `packages/shell/**`）；S7b 页面未动 |

## 3. 全量门禁与回归扫描

```
pnpm turbo run typecheck test build lint --force
# Tasks: 8 successful, 8 total（0 cached）/ Time: 13.183s / exit 0
# @pidock/shell:test    54 files / 801 tests passed
# @pidock/renderer:test 57 files / 483 tests passed
```

客户端脚本重跑（同一构建）：

| 脚本 | 结果 | 相对已提交快照的数值变化 |
| --- | --- | --- |
| `ui-alignment-s1/verify-shell-facts.mjs` | exit 0 | 仅导航相对时间文案（`1 天前 → 2 天前`） |
| `ui-alignment-s2/capture-vertical.mjs` | exit 0（**该脚本只记录，无断言**） | `1440-closed`：`headerH 106 → 103`、`messagesH 408 → 384`、`composerH 145 → 143`、标签行 `32 → 27` |
| `ui-alignment-s5/capture-tool-rail.mjs` | exit 0 | `tool-rail.json` 数值零变化（工具区与徽标无关）；仅截图重绘 |
| `ui-alignment-s3/capture-execution-card.mjs` | **ok（42 个实测状态）** | 会话标签行 `strip.h 32 → 27`、最长标签 `w 173 → 160`；`messagesH` 未降 |
| `ui-alignment-s4/capture-composer.mjs` | **ok（22 个实测状态）** | `messagesH 377 → 384`、`workspaceH 680 → 683`（每档 +7px） |
| `ui-alignment-s6/capture-conversation.mjs` | **ok（101 项检查）** | `messagesH 377 → 384`、`subagents.expanded.messagesH 309 → 316` |

变化来源单一且可解释：本片把共享 `Badge` 从「11px 药丸 + 边框」对齐为原型 `.badge`（`10px / padding 2px 7px / radius 5px / 无边框`），标签行的徽标矮了 5px，于是任务工作区的消息区**多出 7px**，没有任何状态变小。S1/S2 的快照仅作记录刷新（S2 已提交值本来就停留在 #27 时点，S4/S6 已提交证据早已记录 377）。

## 4. 已声明偏离与未决事项（不隐藏）

- **D1 目录形态的「管理目录」按钮**：原型 `directoryProjectPage()` 指向 `edit-project`；本仓在 `directoriesFlow.test.tsx` 里已交付独立「管理普通目录」弹窗并依赖该入口，故该按钮保留打开独立弹窗；`编辑项目` 仍可从 `项目管理 → 编辑` 到达（原型 `projectsDialog()` 也正是这一处），验收项「编辑项目入口」不缺。
- **D2 note 首句**：原型写「示例解析」（其行是造出来的），本实现的行来自 Host 真实分层，故只保留后三句（信息量不减）。
- **D3 弹窗内部留白**：原型 `.modal-body{padding:22px 25px}`、`.modal{max-height:90vh}`、`.modal-backdrop{backdrop-filter:blur(3px)}`；本实现为 `px-5 py-4`（20/16）、`max-h-[70vh]`、无模糊。外层 `width 660px / radius 13px` 已对齐；内部留白属全仓弹窗基线（S1–S6 都受影响），本片只记录不动。
- **D4 按钮几何与图标**：原型 `.btn{padding:7px 11px;font-size:12px;border-radius:7px}`、`.btn.sm{padding:4px 8px;font-size:11px}`，且绝大多数按钮带图标（项目页 `pageButtons` 图标数 `[0,1,0,1]`、弹窗主按钮 1 个）；本实现 `Button` 为 `size="sm" → 4px 10px / 12px / 6px`、`gap 6px`、**0 图标**。已实测并写入 `management.json → geometry.button`，不在本片擅改（会重绘全部早期切片）。
- **D5 调色板**：「调研修订」段在原型样式表末尾覆盖了基色：`--accent #4668cc`（基色 `#233c78`）、`--soft #edf1fc`、`--sidebar #f4f5f7`、`--bg #f6f7f9`；本仓 `styles/tokens.css` 用的是**基色**。四处全部实测差异记录在 `management.json → palette.differs`。需产品/主管裁定是否整体切换（影响全部截图与品牌色），本片未改。
- **R1 未跑**：真实配置落盘/进程重启（验收明确非目标）；Electron GUI 目视确认（本机 OS 级模态阻塞，仍待用户）；五档之外（1180/850）未纳入本片五档清单。
- **R2 目录形态的 `继续工作` 卡片用 `<small>` 计数**，仓库形态用 `page-intro + badge`——两者都照原型各自的写法，不是同一组件（原型亦然）。

## 5. 复现步骤

```bash
export PATH="/private/tmp/pidock-pnpm/node_modules/.bin:$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
# 前置：renderer dev server 127.0.0.1:4335、原型 127.0.0.1:4319（只读）
node docs/evidence/ui-alignment-s7a/capture-management.mjs   # 165 断言 / 0 违例
```

重跑确定性：`management.json` 逐字节可复现（重跑后 `git status` 无差异）；**截图 PNG 不保证逐字节一致**（同一构建重跑时有 3 张因输入框光标/绘制时序产生字节差异），判定以 JSON 数值与断言为准。
