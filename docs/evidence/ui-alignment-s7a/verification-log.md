# [UI 对齐 08] #32 验证记录 — 项目总览 / 生效来源 / 管理页几何基线

- 分支 `main`，起点 `45ed5e4`，本片提交 `cc5cd4e` → `853b71b` → `b7572f2` → `c8076a5` → `1c74c1c` → `5b00c8e` → `b410e6b` → `d7bbf2c`（+ 证据提交）。
- 未 push。
- 证据脚本：`node docs/evidence/ui-alignment-s7a/capture-management.mjs`（可重跑，**退出码 0**，`167` 条断言 / `0` 违例，五档 viewport）。
- 数据：`management.json`（原型与实现的逐项实测）、`prototype/`5 张 PNG、`renderer/`**31 张** PNG（五档 × 6 个状态：项目总览仓库形态 / 目录形态 / 空态、项目管理弹窗、项目表单、生效来源 + 1 张任务工作区入口）。
  - 计数以磁盘为准（收口轮实点）；上一版交付报告里写的「`prototype/` 4 张」是错的，实际 5 张：`1440x900-{effective-config, project-directory, project-form, project-repository, projects-dialog}.png`。

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
| 横向溢出 | 五档 × 10 个页面/弹窗状态（3 页面形态：仓库 / 目录 / 空态；7 弹窗：项目管理、项目表单、生效来源、管理目录——后者仅目录形态）= **50 条记录全部** `scrollWidth ≤ clientWidth`；`management.json` 内 `noHorizontalOverflow` 共 51 条（含 1 条任务工作区入口），逐条 `true` |

## 2. 验收项逐条

| # | 验收项 | 结论 | 证据 |
| --- | --- | --- | --- |
| 1 | 项目总览页按原型 | **COVERED（含一处已声明偏离）** | `pages/ProjectPage.tsx:126`（目录形态）/ `:181`（仓库形态）：`view-label PROJECT` + 标题 + `page-intro`；仓库形态三张 `.stat` 卡（`statCount === 3` = 原型 3）、`项目仓库` `check-row`；目录形态 `项目目录` `.management-list` 5 行（4 `Git 仓库` + 1 `普通目录 · 软链接接入`，badge 文案与原型逐条相等）、`继续工作` 卡片文案 `4 个 Git 仓库 · 1 个普通目录`（与原型同正则）；无项目 → `项目` + `.empty`「创建第一个项目」；≤720 `.grid2 → 1fr`。偏离：`管理目录` 按钮打开本仓既有的「管理普通目录」弹窗，原型该按钮指向 `edit-project`（见 §4-D1） |
| 2 | 项目管理弹窗按原型 | **COVERED** | `Modals.tsx` `ProjectListModal`（`testId="projects-dialog"`）：`管理列表`每行「当前项目/切换」+「编辑」+「删除」、空态 `PageEmpty`、底部「新建项目」主按钮；删除走 `project-delete` 确认弹窗（不无确认删除）；证据 `rowEntries` 行内按钮数 = 原型行按钮数 |
| 3 | 项目表单按原型 | **COVERED** | `ProjectEditModal`（`testId="project-editor"`）：名称/说明/`关联已注册仓库` 复选框组；`disabledChoices ≥ 1`、`usedNotices ≥ 1`（「任务使用中」）；复选框 `15px` = 原型 `15px`，行用原型 `.check-row`（`padding 11px 0 / gap 10px` = 原型同值）；名称为空/重名有可读报错（既有用例） |
| 4 | 生效来源只读视图按原型 | **COVERED** | `EffectiveConfigModal`（`testId="effective-config-dialog"`）：表头 `KEY / 最终值 / 来源`；`任务名 · 环境 · 任务模板 v12`；服务选择器；5 行来源四类齐备（`仓库默认配置 · .env` / `共享模板 · 测试环境 · v12` / `本机私有配置 · ~/.pi/dock/config.json` / `任务覆盖` / `运行时端口绑定 · 本地`）；**只读**：仅 1 个 `select`、0 个可编辑输入、0 个「保存/确定」按钮，切换服务后行内容随之变化（`serviceSwitch.changed = true`）；入口：环境页工具栏 `data-testid="env-effective-config"` + 任务工作区运行面板 `tool-effective-config`（两者均实测打开） |
| 5 | note 文案 | **COVERED（一处措辞调整）** | 「仅展示已保存的应用配置；未保存草稿不参与。业务框架配置优先级与真实进程值需运行时核对。保存修改不代表运行中进程已加载，需显式重启受影响服务。」三条齐备；原型首句「示例解析」被去掉，因为本实现的解析来自 Host 真实分层而非示例行（见 §4-D2） |
| 6 | 管理页几何基线可复用 | **COVERED** | `components/Management.tsx`（`ViewLabel/PageTitle/SectionTitle/SectionHeader/PageIntro/Note/Card/CardStack/CardGrid/StatCard/InlineNotice/PreviewNote/PageEmpty/CheckRow/CheckField/TabRow/TableWrap/Table/Th/Td/ManagementList/ManagementRow/ManagementRowText`）；`.page` 内边距在 `components/Shell.tsx:41-46`；每个原语带原型类名做**标记类**，使证据脚本两侧读同一选择器；本片 S7b 未动页面（模型/用量/能力/远程/计划/归档）全部未改 |
| 7 | 只读/权限 | **COVERED** | 未新增任何 Host/RPC 写接口（`git diff --name-only 45ed5e4..d7bbf2c` 只出现 `docs/` 与 `packages/renderer/`，八个提交零触碰 `packages/shell/**`）；生效来源弹窗无写入入口；项目表单沿用既有 `saveProject`；受限态（只读会话）仍由既有规则禁用按钮 |
| 8 | 纵向/横向健壮性五档 | **COVERED** | 见 §1 末两行（五档 × 10 个页面/弹窗状态 = 50 条无横向溢出记录，全部通过；`.page` `overflow-y auto`）。脚本对每档 10 条逐一断言（每档 3 页面形态 + 7 弹窗） |
| 9 | 用例覆盖 | **COVERED** | renderer 57 文件 / **487** 例全绿（基线 54/463，+3 文件 / +24 例；其中 +4 例来自收口提交 `d7bbf2c`：管理环境导航、「管理目录」入口、`SectionTitle` 字重、表格末行）：`test/managementPrimitives.test.tsx`、`test/projectOverview.test.tsx`（仓库形态 + 目录形态 + 空态 + 弹窗 + 表单校验）、`test/effectiveConfig.test.tsx`（表头/来源四类/只读/覆盖优先/服务切换/工作区入口）、`test/managementFlows.test.tsx`、`test/modals.test.tsx`、`test/env.test.tsx`、`test/app.test.tsx` |
| 10 | 证据提交 | **COVERED** | 本目录 |
| 11 | 既有用例零回归 | **COVERED** | `pnpm turbo run typecheck test build lint --force` 全绿（见 §3）；**七个**证据脚本（S1/S2/S3/S4/S5/S6/S7a）在收口轮重跑全部退出码 0 |
| 12 | 不新增绿色、不改原型、不做 S7b | **COVERED** | 原型目录零改动（本片八个提交 `45ed5e4..d7bbf2c` 的 `git diff --name-only` 无 `prototypes/**`、无 `packages/shell/**`）；S7b 页面未动 |

## 3. 全量门禁与回归扫描

```
pnpm turbo run typecheck test build lint --force
# Tasks: 8 successful, 8 total（0 cached）/ exit 0
# @pidock/shell:test    54 files / 801 tests passed
# @pidock/renderer:test 57 files / 487 tests passed   ← 收口轮实跑（交付时 483，+4 来自 d7bbf2c）
```

客户端脚本重跑（同一构建）：

| 脚本 | 结果 | 相对已提交快照的数值变化 |
| --- | --- | --- |
| `ui-alignment-s1/verify-shell-facts.mjs` | exit 0 | 仅导航相对时间文案（`1 天前 → 2 天前`） |
| `ui-alignment-s2/capture-vertical.mjs` | exit 0（**本片起自带断言：3 条 card-free floor 检查 @400px**，见其日志 §2.9） | `1440-closed`：`headerH 106 → 103`、`messagesH 408 → 384`（**含 53px 跨会话执行卡**，等效去卡 **443**）、`composerH 145 → 143`、会话标签行 `32 → 28`、子代理条 `78 → 51` |
| `ui-alignment-s5/capture-tool-rail.mjs` | exit 0 | `tool-rail.json` 数值零变化（工具区与徽标无关）；仅截图重绘 |
| `ui-alignment-s3/capture-execution-card.mjs` | **ok（42 个实测状态）** | 会话标签内层 `strip.h 32 → 27`、最长标签 `w 173 → 160`；9 个卡片状态的 `messagesH` **各 +7px**（approval 346 → 353、running 305 → 312、failed 315 → 322、completed 336 → 343…），无一下降 |
| `ui-alignment-s4/capture-composer.mjs` | **ok（22 个实测状态）** | 每档 `+7px`：`cardFree 436 → 443`、`readOnly 353 → 360`、`unsupportedImage 293 → 300`、`heavyAttachments 308 → 315`、`card-approval 346 → 353`、`card-failed` / `card-failed-readonly 315 → 322`；`workspaceH 680 → 683` |
| `ui-alignment-s6/capture-conversation.mjs` | **ok（101 项检查）** | 1440：`collapsed 377 → 384`、`expanded 309 → 316`；900：`collapsed 283 → 286`、`expanded 215 → 218` |

变化来源单一且可解释，且**没有任何状态变小**——这句只对任务工作区的三份证据（S3/S4/S6）成立：每一档消息区都 `+7px`，最窄档 `+3px`。本片把共享 `Badge` 从「11px 药丸 + 边框」对齐为原型 `.badge`（`10px / padding 2px 7px / radius 5px / 无边框`），会话标签行随之矮了 4–5px（S2 行 `32 → 28`、S3 内层 `strip.h 32 → 27`），消息区因此变大。

**S2 是例外，必须分开读**：它的已提交值一直停留在 #27 时点（`408 / 78 / 32 / 145`），`b410e6b` 刷新后成为 `384`——差额来自 [UI 对齐 05] (#29) 的 53px 跨会话执行状态卡，等效去卡值为 **443px**（比 #27 时点的 408px 多 **35px**；其中 27px 来自 [UI 对齐 07] (#31) 已声明的子代理条折叠 `78 → 51`）。该脚本本轮起自带 card-free 下限断言，见其日志 §2.9。

## 4. 已声明偏离与未决事项（不隐藏）

- **D1 目录形态的「管理目录」按钮**：原型 `directoryProjectPage()` 指向 `edit-project`；本仓在 `directoriesFlow.test.tsx` 里已交付独立「管理普通目录」弹窗并依赖该入口，故该按钮保留打开独立弹窗；`编辑项目` 仍可从 `项目管理 → 编辑` 到达（原型 `projectsDialog()` 也正是这一处），验收项「编辑项目入口」不缺。
- **D2 note 首句**：原型写「示例解析」（其行是造出来的），本实现的行来自 Host 真实分层，故只保留后三句（信息量不减）。
- **D3 弹窗内部留白**：原型 `.modal-body{padding:22px 25px}`、`.modal{max-height:90vh}`、`.modal-backdrop{backdrop-filter:blur(3px)}`；本实现为 `px-5 py-4`（20/16）、`max-h-[70vh]`、无模糊。外层 `width 660px / radius 13px` 已对齐；内部留白属全仓弹窗基线（S1–S6 都受影响），本片只记录不动。
- **D4 按钮几何与图标**：原型 `.btn{padding:7px 11px;font-size:12px;border-radius:7px;gap:6px}`、`.btn.sm{padding:4px 8px;font-size:11px}`，且绝大多数按钮带图标。本实现 `Button` 偏离**范围比上一版记录的更大**：默认 `md` 是 `px-3.5 py-1.5 text-sm`（**14px 字号**，原型 12px）、`size="sm"` 是 `4px 10px / 12px / radius 6px / gap 6px`。图标两侧已**实测**（`management.json → geometry.button.icons`）：原型 `footerPrimary 1` / `rowSmall 0` / 项目页 `pageButtons [0,1,0,1]`；渲染层 `footerPrimary 0` / `rowSmall 0` / `pageButtons [0,0,0,0,0]`。**几何**不在本片擅改（会重绘全部早期切片）；**图标**已移交 S7b（[#33](https://github.com/Leonz3n/PiDock/issues/33)，验收清单已补「管理页按钮按原型补图标」）。
- **D5 调色板（epic 级未决，需用户裁决）**：原型样式表**末尾的「调研修订」段覆盖了基色**：`--accent #4668cc`（基色 `#233c78`）、`--soft #edf1fc`、`--sidebar #f4f5f7`、`--bg #f6f7f9`；本仓 `styles/tokens.css` 用的是**基色**。四处差异全部实测在 `management.json → palette.differs`（`differs: ["accent", "soft", "sidebar", "bg"]`）。**本片不改**：整体切到修订调色板会牵动 S1 起的全部截图与品牌校验（`ui-alignment-s1/verify-brand.mjs` 断言基色 `rgb(35,60,120)`），属 epic 级决定，需用户裁决后再单开切片处理。
- **D6 生效来源弹窗多一段说明**（原型 `closure.js:27` 的三条 note 之后没有这一段）：保留追加的「只读视图：敏感值遮蔽；每行标出来自 仓库默认配置／共享模板／本机私有配置／任务覆盖／运行时端口绑定 哪一层。」。它说的是本实现真实存在的行为（只读 + 来源列），属新增说明而非改写原型文案。
- **D7 项目表单的提示文案**：原型 `management.js:20` 写「以下为原型示例仓库，可暂不选择，稍后再绑定。」；本实现写「任务使用中的仓库不能解除关联。」。保留本实现：原型那句在真实产品里是假话（仓库不是原型示例），本句说的是真实约束（与脚本实测的 `disabledChoices ≥ 1` 一致）。
### 4.1 本片按原型改掉、不再算偏离的差异

- **`SectionTitle` 字重**：原型 `h2` 未声明字重 → 计算值 **700**（`h1/h3` 声明 650），实现原为 650 → 已改 700；脚本现逐项比对 `fontSize / fontWeight / letterSpacing / color`。
- **`.table tr:last-child td{border:0}`**：末行不再带底边。原实现把 `last:` 变体挂在单元格上，会命中该行的最后一格而不是整行；现挂在表格层。
- **`.modal .page-intro{margin-bottom:16px}`**：项目管理弹窗的说明改走 `PageIntro dense`（弹窗内 13px/16px，页面内仍是 26px）。
- **生效来源弹窗头行**：原型是正文 `<p>`（继承 13px），实现原为 12px → 已改 13px。
- **项目总览的「管理环境」**：原型 `management.js:29` 是 `view:env`（导航到环境与服务页），实现原为打开环境列表弹窗 → 已改为导航；环境列表弹窗保留其在环境页的入口。
- **死代码 margin 覆盖（实测记录）**：`ProjectPage` 原有三处 `mt-0 mb-0` / `mb-0` 想压掉组件的 `mt-4` / `mb-[26px]`；但 Tailwind 按属性顺序生成工具类、不按 class 书写顺序，所以这些覆盖是**死代码**，页面上实测为 **16px / 15px / 26px**。已改为 `SectionHeader flush` 与 `PageIntro dense` 两个显式入口，并删掉覆盖。

- **R1 未跑**：真实配置落盘/进程重启（验收明确非目标）；Electron GUI 目视确认（本机 OS 级模态阻塞，仍待用户）；五档之外（1180/850）未纳入本片五档清单。
- **R2 目录形态的 `继续工作` 卡片用 `<small>` 计数**，仓库形态用 `page-intro + badge`——两者都照原型各自的写法，不是同一组件（原型亦然）。

## 5. 复现步骤

```bash
export PATH="/private/tmp/pidock-pnpm/node_modules/.bin:$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
# 前置：renderer dev server 127.0.0.1:4335、原型 127.0.0.1:4319（只读）
node docs/evidence/ui-alignment-s7a/capture-management.mjs   # 167 断言 / 0 违例
```

重跑确定性：`management.json` 逐字节可复现（重跑后 `git status` 无差异）；**截图 PNG 不保证逐字节一致**（同一构建重跑时有 3 张因输入框光标/绘制时序产生字节差异），判定以 JSON 数值与断言为准。
