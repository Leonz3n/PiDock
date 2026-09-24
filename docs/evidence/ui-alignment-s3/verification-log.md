# [UI 对齐 05] (#29) 会话导航与执行状态卡 — 验证记录

切片：#29（父 Epic #24）。实现基线：原型 A（`prototypes/pidock-ui/`），只读引用。
测量工具：`docs/evidence/ui-alignment-s3/capture-execution.mjs`（headless Chromium，
renderer dev server 127.0.0.1:4335，原型 127.0.0.1:4319），原始数据
`docs/evidence/ui-alignment-s3/execution-card.json`（含两轮 review 修复后的 36 个测量态）。

复现：

```bash
export PATH="/private/tmp/pidock-pnpm/node_modules/.bin:$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
node docs/evidence/ui-alignment-s3/capture-execution.mjs   # 采集 + 几何断言，失败即退出码 1
pnpm turbo run typecheck test build lint --force
```

本轮为第二轮 review 修复轮（结果行与状态对应、证据措辞如实、只读 + 有记录组合实测）。§7 列出两轮逐条结论。

## 1. 验收逐条结论

| # | 验收项 | 结论 | 证据 |
| --- | --- | --- | --- |
| 1 | 会话导航按原型：`全部会话 N` + 最多 4 个标签 + 激活标签替换最后一个 + 只读/归档徽标 + `aria-label="新建会话"` 图标按钮 + `title` 含「· 右键操作」 | COVERED | `TaskPage.tsx`（条带 + `+` IconButton + `title`）；上限来自 `data/sessionNav.ts` 的 `MAX_VISIBLE_SESSION_TABS`/`visibleSessionTabs`（既有，`sessionCoordination.test.ts` 断言「激活替换最后一个」）；`sessionNavTier.test.tsx` 4 例 |
| 2 | 标签条在所有断点（含 1181–1277 + 工具面板、1280/1024 + 工具面板、≤960、≤720）不裁切、不截断标签文字 | COVERED（几何与类契约） | §2 两张表：21 个档位 + 6 个长名档位 `labelClipped=false`、激活标签始终在条内；`capture-execution.mjs:assertGeometry` 在 Chromium 上断言（可复跑，违反即非零退码）；`sessionNavTier.test.tsx` 类契约 |
| 3 | 执行状态卡 8 态 + `aria-label="会话执行状态"` | COVERED | `TaskPage.tsx` `RunStateCard`（`<section aria-label="会话执行状态">`）；文案为原型 `closureLabels`（`runState.ts`，本切片把 `failed` 从「执行失败」改为「失败」）；`executionView.test.ts` 8 态文案 + `executionCardFlow.test.tsx` 态矩阵 |
| 4 | 状态相关入口：执行中→停止执行，等待确认→批准本次操作+拒绝+标记过期，失败→检查并重试，确认已过期→标记已处理，其余无入口；批准一次性 | COVERED | `pages/executionView.ts`（`executionActions`/`EXECUTION_ACTION_LABEL`）；`executionCardFlow.test.tsx` 矩阵 + 「leaves no approve entry once the Host stops listing the request as pending」（断言该请求不再 pending）；一次性权威在 Host `packages/shell/src/host/service-control.ts:110`（`consumeApproval` → `packages/shell/src/main/execution-ledger.ts` 落 `consumedAt`，`already-consumed` 见 `execution-ledger.test.ts:131-133` 与 `:166-169`），渲染层不复制该语义 |
| 5 | 其它会话执行中/等待确认时的跨会话提示 | COVERED | `executionView.ts` `otherBusySession`（对应原型 `other>=0` 分支）；`executionCardFlow.test.tsx`「shows no card without a run record and points at another busy session」 |
| 6 | 状态来自既有 Host/events 数据，不伪造进度/时长/百分比；无运行记录不出卡 | COVERED（一处口径见 §5-R2） | `executionView.ts`（待确认请求 > 实时记录 > 会话 `runState`）；卡内无百分比/进度条/估算时长；会话空闲且无其它忙会话时不出卡（`executionCardVisible`） |
| 7 | 只读会话：停止/批准/拒绝/重试入口禁用，并给出**可见**说明（不是只有 `title`） | COVERED（jsdom 断言；无截图，见 §6） | 禁用按钮带 `title="当前是只读会话，请先调整会话权限"`（文案与既有只读提示同一处常量 `READONLY_ACTION_TITLE`）+ 卡片内可见行 `data-testid="execution-readonly-hint"`；`executionCardFlow.test.tsx`「disables the entries and explains why in a read-only session」断言禁用、`title`、可见行文案，并在无入口的态断言不出现该行 |
| 8 | 等待确认卡展示 操作/命令/目录/影响/接收人/有效期/载荷版本，与 `docs/product-design-closure.md` 一致 | COVERED（一处字段缺口见 §5-R4） | 卡内 `data-testid="execution-approval-preview"`：`待批准：<操作>` + `目标：<命令> · <目录> · 接收人：…` + `影响：…。批准仅授权这一次操作，不自动授权未来执行。`（原型把该句并进正文段落）+ `有效期：<本地时间>（等待起点后 24 小时与下一次计划时刻取较早者；过期后不发送）` + `载荷版本：…`；对应 `docs/product-design-closure.md` 的确认卡与有效期口径 |
| 9 | 纵向预算（1440×900，无工具面板）：审批态/过期态消息区 ≥340px；带额外 chrome 的态 ≥300px；卡片 ≤145px 且不超过原型等待态 225px | COVERED | §3 表：审批态 **344**、过期态 **404**（≥340）；执行中 303、失败 314、已完成 308（≥300）；全部态卡片 ≤141px ≤ 145px 且 ≤ 原型 225px；断言写在 `assertGeometry()`（双档下限 + 卡片护栏 + 与原型对比） |
| 10 | 测试覆盖：8 态渲染、入口有无、一次性批准、停止走既有 API、跨会话提示、只读禁用、单一审批面、不截断、结果行与状态对应 | COVERED | 3 个测试文件 23 例：`executionView.test.ts`(9)、`executionCardFlow.test.tsx`(10)、`sessionNavTier.test.tsx`(4)；renderer 51 文件/426 例 → **51 文件/431 例**，0 回归；`not wrapped in act` 0 |

## 2. 标签条几何（before/after，Chromium）

`clipPx = max(0, scrollWidth - clientWidth)`；`visibleTabs` 为实际渲染出的标签数；
`标签文字截断` 用标签内 `<span>` 的 `scrollWidth > clientWidth` 判定。
修复前 `clipPx > 0` 意味着条带 `overflow-hidden`，内容**取不到**；修复后条带
`overflow-x:auto`，同一数值表示「横向滚动这么多即可看到」，内容可取到（断言按此区分：
溢出必须可滚动）。两种情况下 `标签文字截断` 都必须为「无」。

| 档位 | 修复前（`ui-alignment-s2/vertical-budget.json`） | 修复后（本切片） | 可见标签 | 标签文字截断 |
| --- | --- | --- | --- | --- |
| 1440×900（关/单面板/全面板） | 0 / 0 / 0 | 0 / 0 / 0 | 4 / 4 / 4 | 无 |
| 1280×900（关/单面板/全面板） | 0 / **41** / **41** | 0 / 0 / 0 | 4 / 4 / 4 | 无 |
| 1200×900（关/单面板/全面板） | 未测 | 0 / 45 / 45（可滚动） | 4 / 4 / 4 | 无 |
| 1181×900（关/单面板/全面板） | 未测 | 0 / 56 / 56（可滚动） | 4 / 4 / 4 | 无 |
| 1024×800（关/单面板/全面板） | 0 / **149** / **149** | 0 / 0 / 0 | 2 / 2 / 2 | 无 |
| 900×800 | 未测 | 0 / 0 / 0 | 1 / 1 / 1 | 无 |
| 720×760 | 未测 | 0 / 0 / 0 | 1 / 1 / 1 | 无 |

### 2.1 长会话名 + 工具面板（review P2-2）

场景：新建会话并改名为上限内的 10 字名（`sessionTabLabel` 上限 10 字），再打开「文件」面板。

| 视口（+ 工具面板） | 条带宽/内容宽 | 溢出可滚动 | 标签文字截断 | 激活标签在条内 |
| --- | --- | --- | --- | --- |
| 1181×900 | 358 / 382 | 是（24px） | 无 | 是 |
| 1200×900 | 369 / 382 | 是（13px） | 无 | 是 |
| 1240×900 | 391 / 391 | 否 | 无 | 是 |
| 1277×900 | 413 / 413 | 否 | 无 | 是 |
| 1280×900 | 414 / 414 | 否 | 无 | 是 |
| 1440×900 | 505 / 505 | 否 | 无 | 是 |

机制（`TaskPage.tsx` 条带）：**实现与原型有意不同**。原型 `navigation.css` 的
`.session-tabs{display:flex;min-width:0;flex:1;overflow:hidden}` 与
`.session-tabs .session-tab{min-width:0;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`
是「收缩 + 省略号」，只有外层 `.sessions{overflow-x:auto}` 可滚动，而它的子元素不可滚动——
即原型在拥挤时**截断标签文字**，且没有 4 标签上限（同一修订块里非激活标签直接
`display:none`）。实现选择不截断：条带自身 `overflow-x:auto`、每个标签 `shrink-0`、
标签文字 `whitespace-nowrap`，长度上限由 `sessionTabLabel` 的 10 字负责（≈142px < 原型 180px），
因此 36 个档位全部 `labelClipped=false`，拥挤时用横向滚动而不是省略号
（本轮 review P2-B：旧记录误称原型「不给标签宽度上限、挤了就横向滚动」，已改正）。
另用 `ResizeObserver` + 切换会话时把激活标签滚入可视区（否则工具面板一打开，激活会话就落到条带右缘之外）。
非激活标签仍按「非激活序号」分层：第 1 个 `below-mid:hidden`（≤960px 隐藏）、
其余 `below-wide:hidden`（≤1180px 隐藏），激活标签永不隐藏。
`+` 图标按钮 28px 始终可见；页面级横向溢出：全部 27 个档位 `false`。

## 3. 执行状态卡与纵向预算（1440×900，无工具面板）

`cardH` 卡片高度；`messagesH` `[role=log][aria-label="会话消息"]` 高度；
`chrome` 为列内除卡片/输入框/会话条/消息区之外的块（脚本逐态采集，含高度）。
修复前数据取自 `9a93b09` 的同名 JSON。

| 状态 | 卡片 before → after | messagesH before → after | 下限 | 同页额外 chrome |
| --- | --- | --- | --- | --- |
| 空闲 + 跨会话提示（main） | 59 → 53 | 343 → **349** | 300 | 子代理条 78 |
| 等待确认（deploy） | 205 → **141** | **26 → 344** | 340 | — |
| 执行中（approve 后） | 69 → 63 | 52 → **303** | 300 | 写入协调条 114 |
| 已停止 | 79 → 53 | 161 → **433** | 300 | — |
| 已拒绝 | 59 → 53 | 182 → **433** | 300 | — |
| 确认已过期（两条请求都过期） | 186 → **81** | 55 → **404** | 340 | — |
| 失败（真实失败回合） | 172 → **141** | 283 → **314** | 300 | 输入框 175（失败草稿带 23px 引用行） |
| 失败 + 只读会话（本轮新增） | — → **141** | — → **314** | 300 | 输入框 175 |
| 已完成（main 普通回合） | 123 → **94** | 279 → **308** | 300 | 子代理条 78 |

- 列预算（工作区 680px）：`messages = 680 − 32(会话条) − 卡片 − 输入框 − 6×(块数−1)`。
- 结果行与状态对应（本轮 P2-A）：行只描述**卡片状态由哪条记录推出**——执行中→最近一条批准
  记录（`执行数据库迁移 · 正在执行 bun run db:migrate`）、已拒绝/确认已过期→最近一条同状态记录
  （按 `requestedAt`），其余状态（空闲/等待确认/已停止/失败/已完成）没有结果行。修复前取
  「数组里第一条非待确认」，于是「执行中」旁边写着「部署到 Staging · 已拒绝，未执行。」。
- 只读 + 有运行记录（本轮新增档位 `failed-readonly`）：可见说明行与状态行同行
  （`readonlyHint` 自身高 15px，卡片仍为 141px），入口禁用，消息区 314px，
  截图 `renderer/1440-card-failed-readonly.png`。
- 卡片护栏（父裁决 (c)）：所有态 `cardH ≤ 145px`，且都低于原型等待态 225px；
  卡片内部滚动：所有态 `cardScrolls = false`（`max-h-[34vh]` 未触发）。
- 原型对照（同一脚本测原型 A 页）：等待确认态 `.execution-panel` **225px**、
  `.messages` **99px**、`.composer-wrap` 167px。本实现审批态消息区 344px = 原型的 **3.5 倍**，
  卡片 141px 也低于原型的 225px：本切片没有一处比原型更挤或更大。
- 下限口径（父裁决 (a)，写进 `assertGeometry()`）：
  - 审批态/过期态（列内只有卡片）**≥340px** → 实测 344 / 404；
  - 携带本切片之外 chrome 的态（写入协调条 / 子代理条 / 带引用草稿）**≥300px** →
    实测 303 / 314 / 308 / 349（`failed-readonly` 也按 300）；
  - 差额来源逐条量化在 JSON 的 `extraChrome` 里，去向见 §5-R5。
- **与 #27 的 400px 基线的关系（本轮补齐口径，review P2-C）**：#27 的
  「1440×900 无面板消息区 ≥400px」适用于当前页面**不显示执行状态卡**的状态（无卡片档为
  408px 量级）；卡片一旦出现，#29 的双档下限（340/300）**取代**它。因此「空闲 + 跨会话提示」
  档（卡片 53px）实测 349px < 408px 不是回归，而是卡片按 #29 验收 5 必须出现的结果。

## 4. 门禁与仓库状态

- `pnpm turbo run typecheck test build lint --force`：**8/8 成功**。
- renderer：**51 文件 / 431 例全绿**（第一轮修复后 427，第二轮 +4）；shell：54 文件 / 801 例（未变）。
- `not wrapped in act`：0；无 `.skip/.only/.todo`。
- 改动仅限 `packages/renderer/**` 与 `docs/evidence/ui-alignment-s3/**`，
  `prototypes/**` 0 改动（只读引用），`packages/shell/**` 未触碰。
- 采集脚本可复跑并带断言：`assertGeometry()` 检查每个档位标签未截断、条带溢出必须可滚动、
  激活标签在条内、可见标签数分层（4/4/2/1/1）、长名档位不截断、卡片不内部滚动、
  卡片护栏、双档消息区下限、审批面唯一、只读说明行可见且不独占一块、页面无横向溢出
  （**36** 个测量态）。

## 5. 残项（含去向）

- **R1（已裁决）** 审批态消息区原为 26px：病根是**两处审批面**（输入框上方 247px 的
  `ApprovalCard` + 卡内 205px 预览）。本轮合并为卡内一处后为 344px。父裁决：审批/过期 ≥340px、
  带额外 chrome 的态 ≥300px、卡片 ≤145px；见 §3。
- **R2（状态口径）** 会话空闲但**其它会话**忙时仍出卡（显示「空闲」+ 跨会话提示），
  这是 #5 跨会话提示的落点；因此 #6 的「无运行记录不显示卡片」在「本会话空闲且无其它忙会话」
  时成立。
- **R3（已修）** 「标记过期」原来只在输入框上方面板里，且该面板取
  `approvals.find(taskId+sessionId)` 不看状态，导致第一条过期后第二条没有过期入口。
  本轮：面板删除，`标记过期` 进入执行状态卡的状态行（原型把控制放在 `.between` 行的结构），
  它作用于当前 pending 的请求，因此「两条请求 → 两次标记过期 → 确认已过期」在真实 UI 里可达，
  并有截图（`renderer/1440-card-expired.png`；修复前该态只能由 jsdom 断言）。
- **R4（字段缺口，未做）** `docs/product-design-closure.md` 的确认卡要求展示「待发送内容」，
  但渲染层 `Approval` 类型（`packages/renderer/src/data/types.ts`）没有对应字段，卡内也没有
  该行；要补必须先由 Host 载荷提供该字段。去向：确认/审批切片（#19/#20 系列）。
- **R5（本切片之外 chrome，逐条去向）** 额度差额来自不属于 #29 的既有块，量化后不折叠：
  - 写入协调条 **114px**（[PiDock 09] #11 的 chrome，执行中态出现）→ 记到
    [#11](https://github.com/Leonz3n/PiDock/issues/11)；
  - 子代理条 **78px**（有子代理的会话）→ 后续切片残项（S6 对话/子代理区域）；
  - 失败态输入框 **175px**（失败草稿带 23px 引用行）→
    [#30](https://github.com/Leonz3n/PiDock/issues/30)（S4 输入区高度已含此项）。
- **R6（几何断言的运行位置）** `pnpm test` 是 jsdom，无布局，因此数值断言放在 Chromium
  采集脚本里（可复跑、违反即退码 1），`pnpm test` 覆盖类契约（tier 类、`shrink-0`、
  `overflow-x-auto`、`whitespace-nowrap`、`+` 按钮、`title`）。
- **R7（己补测）** 「只读 + 有入口」在种子数据下不可达（只读的会话没有运行记录），
  本轮改为**驱动可达**：先把失败会话跑出真实失败回合，再通过它自己的权限对话框（`选择权限：默认权限` → `只读`）
  切成只读——这条路径就是用户走的那条。结果：卡片 141px（与可写失败态相同，说明行没有
  多占一行）、消息区 314px ≥ 300px、入口禁用、可见说明行同行为 —— 截图
  `renderer/1440-card-failed-readonly.png`；断言写在 `assertGeometry()`（该档位必须有可见说明行）。
- **R8（文案与断言校准）** 本轮删掉了原型没有的一行「停止不回滚已完成操作；恢复不自动重放已完成工具。」；
  `执行失败` → `失败`（原型 `closureLabels`）；「标记已处理」toast 由「已移出关注列表，执行记录保留」
  改为「已在本会话隐藏该状态卡；执行记录保留」——Host 侧没有 ack 入口
  （`execution-ledger` 每次读取都会重建过期项），旧文案会谎称已移出「需要处理」。
  去向：Host 侧确认/忽略 API（确认/审批切片）。
- **R9（断言强度）** 原「clears the pending request from the Host so it can never fire twice」
  的标题强于断言（断言只看渲染层不再给入口），已改名为「leaves no approve entry once the Host
  stops listing the request as pending」，并补断言该请求不再是 pending；一次性语义的权威
  文件与行号（`service-control.ts:110`、`execution-ledger.ts` 的 `already-consumed`、
  `execution-ledger.test.ts:131-133`/`:166-169`）已写进测试注释。
- **R10（结果行口径）** 结果行从「会话里第一条非待确认」改为
  `executionView.ts` 的 `outcomeApprovalFor(approvals, taskId, sessionId, state)`：按状态
  取最近一条对应记录，取不到就不出该行。副作用有两个，都是有意的：
  （1）等待确认态不再附带上一轮的结论（预览已经说明了当前要批的事）；
  （2）已停止/失败/已完成态不再借用某条请求的结论——旧行为会在「已停止」旁写着「正在执行 …」。
  影响的一处既有断言（`app.test.tsx` 的过期流程）已改为断言 Host 状态与卡片转去审阅第二条请求。

## 6. 未测/不可测

- 真实 Electron 窗口内的表现（GUI 重启被 OS 级弹窗阻塞，见 #26/#27 记录）。
- 真实 Host（`shellHost`）下的执行状态卡：`getRun` 仍未被渲染层调用（刻意不接，避免
  fallback 内存镜像冒充 Host 记录）；真实回合的 `runs` 记录仍只来自 `stores/events.ts` 的实时事件。
- 「待发送内容」字段（§5-R4）与 Host 侧「标记已处理」ack（§5-R8）。
- 原型 B/C 变体、其它页面对齐（S4 输入框与附件、S6 对话消息与引用、S7 管理页）。
- 只读说明行在窄档（≤ 1180px 打开工具面板）下会换行、卡片多约 21px：没有实测该组合的数值
  （只读档位只在 1440×900 采过），断言只在 1440×900 生效。

## 7. 两轮 review 逐条结论

第一轮（`6ec7bc4`）

| review 项 | 结论 | 落地 |
| --- | --- | --- |
| P1-1 单审批面（26px） | 已修 | 输入框上方的 `ApprovalCard` 与其派生删除（`approvalStatusLabel` 一并删除）；载荷审阅与 批准/拒绝/标记过期 全在卡内；审批态 26 → **344px**；断言 `approvalSurfaces ≤ 1`，测试「renders the payload review only inside the execution card」 |
| P2-1 toast 诚实性 | 已修 | 文案改为「已在本会话隐藏该状态卡；执行记录保留」；Host ack 记为去向（§5-R8），未实现 |
| P2-2 长名 + 工具栏 1200 | 已修 | 条带改为自制方案 `overflow-x:auto` + `shrink-0` + `whitespace-nowrap` + 激活标签滚入可视区（该项当时写成「照原型」，实际是有意偏离，本轮已在 §2 与代码注释改正，见下表 P2-B）；1181–1277 + 面板下 0 截断（§2.1），6 个新档位写进 JSON |
| P2-3 只读可见提示 | 已修（当时仅 jsdom 断言） | 卡片可见行 `execution-readonly-hint` + 按钮 `title`（同文案常量）；当时无截图，本轮已补测（见下表 P2-D） |
| P2-4 断言强度与行号 | 已修 | 见 §5-R9 |
| P2-6 删除原型外文案 | 已修 | 「停止不回滚已完成操作；恢复不自动重放已完成工具。」已删；原型失败/过期行原样保留 |
| 记录「待发送内容」缺口 | 已记录 | §5-R4（未实现） |

第二轮（本轮，review 报告级 P2-A…P2-E）

| review 项 | 结论 | 落地 |
| --- | --- | --- |
| P2-A 结果行张冠李戴 | 已修（改代码 + 用例 + 证据） | 新增纯函数 `executionView.ts` `outcomeApprovalFor()`，`TaskPage.tsx` 改用它；执行中态实测由「部署到 Staging · 已拒绝，未执行。」变为「执行数据库迁移 · 正在执行 bun run db:migrate」（`execution-card.json` `card.running.cardText` + 截图）；已停止/失败/已完成不再借用请求结论；用例 `executionView.test.ts` 3 例 + `executionCardFlow.test.tsx`「keeps the outcome line on the request the state came from」 |
| P2-B 原型描述不实 | 已改证据与注释 | §2 机制段落按 `prototypes/pidock-ui/navigation.css:1` 如实改写（原型 `.session-tabs{overflow:hidden}` + `.session-tab{max-width:180px;text-overflow:ellipsis}`，只有 `.sessions` 可滚动，且该修订块里非激活标签 `display:none`），并明确本次 `overflow-x:auto` + 10 字上限是**有意偏离**；`capture-execution.mjs` 的两处注释同步 |
| P2-C #27 400px 基线被取代未记录 | 已改证据 | §3 新增「与 #27 的 400px 基线的关系」：卡片出现时以 340/300 为准；「空闲 + 跨会话提示」349px < 408px 是卡片按验收 5 必须出现的结果，不是回归 |
| P2-D 只读说明行未进护栏 | 已修（布局 + 实测 + 断言） | 说明行从独立块移入状态行（`flex-wrap` 下仍可换行）；新增 `failed-readonly` 档位实测：卡片 **141px**（与可写失败态相同）、消息区 **314px** ≥ 300、入口禁用、说明行可见（`readonlyHint` 15px）；`assertGeometry()` 增加该档位的可见性与护栏断言；截图 `renderer/1440-card-failed-readonly.png`；§5-R7 由「无法截图」改为「已补测」 |
| P2-E 注释不实 | 已改注释 | `TaskPage.tsx` 条带 `ResizeObserver` 注释不再声称「jsdom 没有 ResizeObserver」，改为「守护完全没有 ResizeObserver 的环境；`src/test/setup.ts` 装的是可控 stub，用例走观察路径」 |
