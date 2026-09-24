# [UI 对齐 05] (#29) 会话导航与执行状态卡 — 验证记录

切片：#29（父 Epic #24）。实现基线：原型 A（`prototypes/pidock-ui/`），只读引用。
测量工具：`docs/evidence/ui-alignment-s3/capture-execution.mjs`（headless Chromium，
renderer dev server 127.0.0.1:4335，原型 127.0.0.1:4319），原始数据
`docs/evidence/ui-alignment-s3/execution-card.json`。

复现：

```bash
export PATH="/private/tmp/pidock-pnpm/node_modules/.bin:$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
node docs/evidence/ui-alignment-s3/capture-execution.mjs   # 采集 + 几何断言，失败即退出码 1
pnpm turbo run typecheck test build lint --force
```

## 1. 验收逐条结论

| # | 验收项 | 结论 | 证据 |
| --- | --- | --- | --- |
| 1 | 会话导航按原型：`全部会话 N` + 最多 4 个标签 + 激活标签替换最后一个 + 只读/归档徽标 + `aria-label="新建会话"` 图标按钮 + `title` 含「· 右键操作」 | COVERED | `TaskPage.tsx:738-798`（条带+`+` IconButton+`title`）；上限来自 `data/sessionNav.ts` 的 `MAX_VISIBLE_SESSION_TABS`/`visibleSessionTabs`（既有，`sessionCoordination.test.ts` 断言「激活替换最后一个」）；`sessionNavTier.test.tsx` 4 例 |
| 2 | 标签条在所有断点（含 1280/1024 + 工具面板、≤960、≤720）不裁切；`tabStrip.scrollWidth <= clientWidth`；按层减少标签数量而非截断 | COVERED（几何与类契约） | 见 §2 表：15 个档位 `clipPx = 0`、`labelClipped = false`；`TaskPage.tsx:808-822` tier + `min-w-0 shrink`；`sessionNavTier.test.tsx` 类契约；`capture-execution.mjs:assertGeometry` 在 Chromium 上断言（可复跑，违反即非零退出） |
| 3 | 执行状态卡 8 态 + `aria-label="会话执行状态"` | COVERED | `TaskPage.tsx:929-1072`（`<section aria-label="会话执行状态">`）；文案为原型 `closureLabels`（`runState.ts:3-14`，本切片把 `failed` 从「执行失败」改为「失败」）；`executionView.test.ts` 8 态文案 + `executionCardFlow.test.tsx` 7 态渲染矩阵 |
| 4 | 状态相关入口：执行中→停止执行，等待确认→批准本次操作+拒绝，失败→检查并重试，确认已过期→标记已处理，其余无入口；批准一次性 | COVERED | `pages/executionView.ts:20-34`（`executionActions`/`EXECUTION_ACTION_LABEL`）；矩阵断言见 `executionCardFlow.test.tsx`；完成后请求不再 pending，卡片不再给入口（`executionCardFlow.test.tsx`「clears the pending request…」）；一次性权威在 Host `packages/shell/src/host/service-control.ts:39,110`（`consumeApproval`，`execution-ledger.test.ts:232` 断言 `consumedAt`），渲染层不复制该语义 |
| 5 | 其它会话执行中/等待确认时的跨会话提示 | COVERED | `executionView.ts:85-96`（`otherBusySession`，对应原型 `other>=0` 分支）；页面测量 `otherSession = 15px`（main 页与 failed 页各一处）；`executionCardFlow.test.tsx`「shows no card without a run record and points at another busy session」 |
| 6 | 状态来自既有 Host/events 数据，不伪造进度/时长/百分比；无运行记录不出卡 | COVERED（一处口径见 §5-R2） | `executionView.ts:59-72`（待确认请求 > 实时记录 > 会话 `runState`）；卡片内没有百分比/进度条/估算时长，只显示 Host 文案（`record.summary`/`failedScope`/`steps`）；会话空闲且无其它忙会话时不出卡（`executionCardVisible`，`executionView.test.ts`） |
| 7 | 只读会话：停止/批准/拒绝/重试入口禁用并给提示 | COVERED | `TaskPage.tsx:991-1001`（`disabled={readonly}` + `title="当前是只读会话，请先调整会话权限"`，与既有只读提示同一文案）；`executionCardFlow.test.tsx` 覆盖 检查并重试 / 停止执行 / 标记已处理 三态禁用 |
| 8 | 等待确认卡展示 目标/影响/有效期，与 `docs/product-design-closure.md` 一致 | COVERED | `TaskPage.tsx:1019-1033`：`待批准：<操作>` + `目标：<命令> · <目录> [+ 接收人]` + `影响：…` + `有效期：<本地时间>（等待起点后 24 小时与下一次计划时刻取较早者；过期后不发送）` + 「批准仅授权这一次操作，不自动授权未来执行。」；对应 `docs/product-design-closure.md:14`（确认卡展示操作、目标／接收人、待发送内容及影响；批准仅作用于本次请求）与 `:21`（有效期取较早者、一次性） |
| 9 | 纵向预算：卡片出现后 1440×900 消息区仍 ≥340px | PARTIAL | 无记录型卡片（空闲+hint，59px）→ 消息区 **343px** ≥ 340；带记录/预览的卡片 → 279–283px（见 §3）。原因与取舍见 §5-R1：340px 这个下限是按「卡片≈60px」推的，而原型自己的 `.execution-panel` 同样是内容型面板（等待确认 225px），本卡片的 summary/失败范围/步骤/预览都是原型要求的信息 |
| 10 | 测试覆盖：8 态渲染、入口有无、一次性批准、停止走既有 API、跨会话提示、只读禁用、不裁切 | COVERED | 新增 3 个测试文件 18 例：`executionView.test.ts`(6)、`executionCardFlow.test.tsx`(8)、`sessionNavTier.test.tsx`(4)；renderer 48 文件/408 例 → **51 文件/426 例**，0 回归；`not wrapped in act` 0 |

## 2. 标签条几何（before/after，Chromium）

`clipPx = max(0, scrollWidth - clientWidth)`；`visibleTabs` 为实际渲染出的标签数。

| 档位 | 修复前（#27 证据 `ui-alignment-s2/vertical-budget.json`） | 修复后（本切片） | 可见标签 | 标签文字截断 |
| --- | --- | --- | --- | --- |
| 1440×900（关/单面板/全面板） | 0 / 0 / 0 | 0 / 0 / 0 | 4 / 4 / 4 | 无 |
| 1280×900（关/单面板/全面板） | 0 / **41** / **41** | 0 / 0 / 0 | 4 / 4 / 4 | 无 |
| 1024×800（关/单面板/全面板） | 0 / **149** / **149** | 0 / 0 / 0 | 2 / 2 / 2 | 无 |
| 900×800 | 未测 | 0 / 0 / 0 | 1 / 1 / 1 | 无 |
| 720×760 | 未测 | 0 / 0 / 0 | 1 / 1 / 1 | 无 |

机制（`TaskPage.tsx:808-822`）：标签 `min-w-0 shrink`（原型 `closure.css` 的
`.session-tabs .session-tab{flex-shrink:1}`），非激活标签按「非激活序号」分层：
第 1 个 `below-mid:hidden`（≤960px 隐藏）、其余 `below-wide:hidden`（≤1180px 隐藏），
激活标签永不隐藏。`+` 图标按钮 28px，始终可见；`overflow-hidden` 只作兜底。
页面级横向溢出：15 个档位全部 `false`。

## 3. 执行状态卡与纵向预算（1440×900）

`cardH` 为卡片高度，`messagesH` 为 `[role=log][aria-label="会话消息"]` 高度，
`page` 列出该截图里同时存在的其它大块（用于解释差额）。

| 状态 | cardH | messagesH | 同页其它块 | 备注 |
| --- | --- | --- | --- | --- |
| 空闲 + 跨会话提示（main，S2 基线页） | 59 | **343** | —（S2 基线 408，卡片+间距 65） | 无入口 |
| 等待确认（deploy） | 205 | 26 | 输入框上方「等待确认」面板 **247** | 预览块 128px；原型等待态 `.execution-panel` 225px |
| 等待确认（第一条过期后，第二条仍待确认） | 186 | 55 | 同上 | 见 §5-R3：第二条确认在 UI 里没有「标记过期」入口 |
| 执行中（approve 后） | 69 | 52 | 同上 | 只有 停止执行 |
| 已停止 | 79 | 161 | 同上 | 无入口 |
| 已拒绝 | 59 | 182 | 同上 | 无入口 |
| 失败（真实失败回合） | 172 | 283 | 该会话无 subagent 块 | 失败范围 + 折叠的「执行步骤（完成 2 / 共 4）」 |
| 已完成（main 普通回合） | 123 | **279** | —（S2 基线页） | 无入口；比空闲卡多 summary+步骤+尾注 |

- 卡片内部滚动：所有状态 `cardScrolls = false`（`max-h-[34vh]` 未触发）。
- 原型参照（同一采集脚本，原型 A 页面内 `executionPanel()`）：空闲 **68px**、
  等待确认 **225px**（其中 `.approval-preview` 116px）→ 本实现（59/205）不高于原型，
  本切片没有把卡片做得比原型更大的地方。
- 结论：#9 的 340px 只在「无记录型卡片」成立（343px）。带记录/预览的卡片在
  S2 基线页上按同页其他块推算为 408 − (123|172) − 6 ≈ 279|230px。这是取舍而非遗漏：
  见 §5-R1。

## 4. 门禁与仓库状态

- `pnpm turbo run typecheck test build lint --force`：**8/8 成功**。
- renderer：**51 文件 / 426 例全绿**（切片前 48/408）；shell：54 文件 / 801 例（未变）。
- `not wrapped in act`：0；无 `.skip/.only/.todo`。
- 改动仅限 `packages/renderer/**` 与 `docs/evidence/ui-alignment-s3/**`（`git show --stat`），
  `prototypes/**` 0 改动（只读引用），`packages/shell/**` 未触碰。
- 采集脚本可复跑并带断言：`assertGeometry()` 检查每个档位的 `clipPx=0`、标签未截断、
  标签数分层（4/4/2/1/1）、卡片不内部滚动、页面无横向溢出（23 个测量态）。

## 5. 残项（含去向）

- **R1（#9 部分不达）** 内容型卡片（失败 172px / 已完成 123px）在 S2 基线页面上把消息区
  压到 279–283px，低于 340px。去向：需要产品决策——是接受原型的信息密度（原型等待态卡片
  本身就 225px），还是把「失败范围/执行步骤/尾注」移出卡片（例如并入消息流或折叠区）、
  或把 340px 下限改为「按卡片实高扣除」。本切片不做未批准的信息删减。
- **R2（状态口径）** 会话空闲但**其它会话**忙时仍出卡（显示「空闲」+ 跨会话提示），
  这是 #5 跨会话提示的落点；因此 #6 的「无运行记录不显示卡片」在「本会话空闲且无其它忙会话」
  时成立。若要求空闲一律不出卡，则跨会话提示无处安放，需要改到其它位置。
- **R3（既有确认 UI 缺口，非本切片引入）** 同一会话的两条待确认请求里，只有第一条能在
  输入框上方的「等待确认」面板里操作：该面板取 `approvals.find(taskId+sessionId)`
  （`TaskPage.tsx:1263`，不看状态、不看是否 pending），所以第一条过期后它仍显示旧载荷，
  第二条没有「标记过期」入口（「需要处理」页只有「定位会话」，`AttentionPage.tsx:84`）。
  本切片的执行状态卡补上了第二条的「批准/拒绝」入口，但没有补齐「标记过期」。
  去向：确认/审批切片（#19/#20 系列）或新切片，与本切片的卡片刻意解耦。
- **R4（层数机制与 #2 措辞的差异）** #2 建议用 `visibleSessionTabs(..., {narrow})` 减少标签；
  本实现改成纯 CSS 分层（同一可见结果，无需 JS 量宽，且给出 4/2/1 三档而非两档）。
  `visibleSessionTabs` 与 `{narrow}` 仍是既有接缝与单测覆盖（`sessionCoordination.test.ts`），
  只是组件不再按 JS 判断宽度。若要求必须走 JS 分支，需要加 `matchMedia` 监听。
- **R5（既有重复入口）** 等待确认现在有两个操作面：输入框上方的「等待确认」审阅面板
  （#19/#20 既有，含命令/目录/载荷版本/标记过期，247px）与执行状态卡的原型预览
  （#4/#8 要求，205px）。原型只有一个。deploy 会话页因此消息区仅 26px（不加卡片为 237px）。
  去向：需要产品决策收敛为一个入口（或把审阅面板折叠为摘要）。
- **R6（几何断言的运行位置）** `pnpm test` 是 jsdom，没有布局，因此数值断言放在
  Chromium 采集脚本里（可复跑、违反即退出码 1），`pnpm test` 覆盖类契约（tier 类、`min-w-0 shrink`、
  `overflow-hidden`、`+` 按钮、`title`）。若要求 `pnpm test` 直接断言数值，需要在测试里拉起
  Chromium（新增 e2e 任务），本切片未做。
- **R7（未截图的卡片状态）** 「确认已过期 + 标记已处理」在种子数据下无法通过 UI 到达
  （第二条确认没有过期入口，见 R3）：Chromium 侧记录了到达「等待确认（第二条）」的一步，
  「确认已过期」的卡片本身只由 `executionCardFlow.test.tsx` 断言（含「标记已处理」后卡片消失、
  approval 仍为 `expired`、会话状态不变）。只读会话的禁用入口也只由 jsdom 覆盖（种子只读会话无运行记录）。
- **R8（文案对齐）** `runStateLabel("failed")` 由「执行失败」改为原型 `closureLabels` 的「失败」。
  影响面：会话列表徽标与执行状态卡；注意力列表/失败提示文案（「执行失败：…」）来自 Host detail，
  未改。测试同步点：`app.test.tsx:17` 由 `findByText("等待确认")` 改为按 heading 定位审阅面板
  （状态行与面板标题现在同名，属于本切片新增的重复文案，非产品回退）。

## 6. 未测/不可测

- 真实 Electron 窗口内的表现（GUI 重启被 OS 级弹窗阻塞，见 #26/#27 记录）。
- 真实 Host（`shellHost`）下的执行状态卡：`getRun` 仍未被渲染层调用（刻意不接，避免
  fallback 内存镜像冒充 Host 记录）；真实回合的 `runs` 记录仍只来自 `stores/events.ts` 的实时事件。
- 原型 B/C 变体、其它页面对齐（S4 输入框与附件、S6 对话消息与引用、S7 管理页）。
