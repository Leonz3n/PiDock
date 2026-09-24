# [UI 对齐 07] (#31) 对话消息与引用 — 验证日志

父工单 [#24](https://github.com/Leonz3n/PiDock/issues/24)。本片把消息区按原型 A
（`prototypes/pidock-ui/app.js:57 conversation()`）对齐，并吸收 [#29](https://github.com/Leonz3n/PiDock/issues/29)
评审留下的「78px 子代理条挤压消息区」残项。

- 交付提交：`03882d3` `feat(renderer): align the conversation and references with prototype A (#31)`
- 证据脚本：`node docs/evidence/ui-alignment-s6/capture-conversation.mjs` → `geometry assertions: ok (85 checks)`
- 测量产物：`conversation.json`、`renderer/*.png`、`prototype/1440x900-conversation.png`
- 口径：**原型 A 只读**（`127.0.0.1:4319/?variant=A`，1440×900）；渲染侧 `127.0.0.1:4335`；
  所有定位只用 `data-testid`（[#30](https://github.com/Leonz3n/PiDock/issues/30) 的教训）；
  脚本带几何断言，非零退出即失败。

## 1. 消息区几何（原型 vs 渲染）

| 项 | 原型 A（实测） | 本片（实测） | 结论 |
| --- | --- | --- | --- |
| `.messages` 内边距 @1440/1280 | `26px 28px 10px` | `26px 28px 10px` | 一致 |
| `.messages` 内边距 @1180（≤1180） | `20px` | `20px` | 一致 |
| `.messages` 内边距 @1024（≤1180） | `20px` | `20px` | 一致 |
| `.messages` 内边距 @900（≤960） | `16px` | `16px` | 一致 |
| `.message` 下间距 | `25px` | `25px` | 一致 |
| `.message-head` 间距 / 字号 / 下间距 | `9px` / `11px` / `10px` | `9px` / `11px` / `10px` | 一致 |
| `.userbubble` padding | `13px 16px` | `13px 16px` | 一致 |
| `.userbubble` 底色 | `rgb(245,246,246)` | `rgb(245,246,246)` | 一致 |
| `.userbubble` 圆角 | `2px 10px 10px 10px` | `2px 10px 10px 10px` | 一致 |
| 正文缩进 | `31px` | `31px` | 一致 |
| ≤960 缩进 | `0` | `0` | 一致 |
| `.date-label` 字号 / 下间距 | `10px` / `22px` | `10px` / `22px` | 一致 |
| `.refchip` | `10px`、`1px 5px`、圆角 `4px`、`rgb(237,239,243)`、边框 `1px` | 同左 | 一致 |
| 头像 / 品牌 π | `25px` / `22px` | `25px` / `22px` | 一致 |
| 消息内图片 | `.message-images img{width:200px;height:125px;object-fit:contain}` | `200×125` / `contain` | 一致 |
| `.message-footer` 字号 | `10px` | `10px` | 一致 |

日期分组标签按真实会话时间产出：`2026年9月22日 · 实现与验证`（种子消息 `createdAt` = `2026-09-22`，
会话名来自 Host），**未**写死原型里的「今天 · 示例会话」。

## 2. 工具结果卡（`.toolcard`）

数据只来自 Host 侧已有的 `RunRecord` 与该任务自身的工作区计数，**没有**渲染层编造的步骤或结论；
没有运行记录时整卡不渲染（`conversationView.test.ts` 断言 `undefined`）。

| 部件 | 原型 | 本片（实测） |
| --- | --- | --- |
| 行 | 图标 + 文本 + 右侧操作（`查看文件 ↗` / `任务内覆盖`） | `4 个仓库工作副本` + `查看文件 ↗`（按钮，开文件面板）；`服务依赖与端口` + `5 本地 · 2 远程` |
| 步骤 | `.steps` + `.dot.live` | 步骤来自 `RunRecord.steps`；`pending` 且回合在跑/等确认 → live 环（实测 `读取任务上下文(非live) / 运行工具(live)`） |
| 结论条 | `.run-result`（左 2px `#5d719f`、底 `#f4f5f8`） | 同左；`✓ 执行完成`、`✗ 构建失败，已保留现场` + `失败范围：…` |
| 卡内动作 | `查看浏览器` / `查看变更` | `查看浏览器` / `查看变更`（开同一工具面板） |
| 卡片高度 | 原型示例卡 138px（视觉参考） | 运行/已完成 213px、失败 281px；**位于滚动区内**（`insideLog: true`），不占消息区高度 |

关于「运行中步骤的 live 点」：真实回合约 30ms 结束，脚本用 `page.clock` 冻结时钟取到该态并断言，
但 **Playwright 的截图路径会推进已安装的假时钟**（实测：`runFor(8)` 后连续四次 `evaluate` 往返仍停在
`执行中 · 正在执行`，第一次截图调用即翻到 `已完成`），因此**没有提交可能误导的运行中截图**：
该态由 JSON 断言锁定，`pending` 步骤的非 live 形态由 `1440x900-toolcard-completed.png` 呈现。

## 3. 子代理条（`#29` 残项）与纵向预算

| 项 | #29 交付时（`3f20369`） | 本片 | 结论 |
| --- | --- | --- | --- |
| 子代理条高度 @1440 | 78px（常驻卡片网格） | **51px**（一行 + 展开开关）；展开 120px | 回收 27px |
| 子代理条高度 @900（≤960） | 78px | **49px**；展开 185px（单列） | 一致规则 |
| 消息区 @1440（同态：idle-other-busy） | 349px | **377px** | +28px |
| 消息区 @1440（completed） | 309px | **336px** | +27px |
| 消息区 @900（折叠） | — | 283px；展开 147px | 展开可复原 |

常驻高度只留一行；运行中的信息没有藏起来——`N 个运行中` 与数量徽章仍在标签行上。

纵向预算无回退（同一脚本 `docs/evidence/ui-alignment-s3/capture-execution.mjs` 复测，#29 双档 + #30 输入区）：

| 档位 | #29 交付时 | 本片复测 | 下限 | 结论 |
| --- | --- | --- | --- | --- |
| `approval`（等待确认） | 346 | **346** | 340 | 达标 |
| `expired`（确认已过期） | 406 | **406** | 340 | 达标 |
| `running`（带 114px 写操作权条） | 305 | **305** | 300 | 达标 |
| `failed` / `failed-readonly` | 315 | **315 / 315** | 300 | 达标 |
| `completed` / `stopped` / `rejected` / `idle-other-busy` | 309 / 434 / 434 / 350 | **336 / 434 / 434 / 377** | 300 | 达标（子代理条影响的两态各 +27） |
| 执行状态卡高度 | 141（护栏 145） | **141** | ≤145 | 达标 |
| 输入区（`composerH`） | 143 | **143** | 143 | 未回退 |
| 工具栏条带宽度（#28/#30 防空转） | 1440：1014→505 | 同左 | 开栏严格更窄 | 达标 |

`capture-execution.mjs` → `geometry assertions: ok (42 measured states)`；S6 脚本另行复算这 9 个态的
下限（`s3CrossCheck`）并要求 `idle-other-busy ≥ 349 + 25`。

## 4. 逐盒结论（#31 验收清单）

| 验收项 | 结论 | 落地 | 实测 |
| --- | --- | --- | --- |
| 消息区几何（26/28/10、≤1180 → 20、≤960 → 16、间距 25、正文 12px/1.95、气泡 13/16 + `2px 10px 10px 10px` + `#f5f6f6`、缩进 31px、≤960 归零） | COVERED | `TaskPage.tsx` `Conversation`/`MessageRow` | 见 §1 |
| 消息头部（头像 25×25 +「你」+ 时间；π 22×22 +「Pi」+ 模式标签 + 右侧徽章） | COVERED | `conversationView.ts:conversationModeLabel/conversationBadge/messageTimeLabel`、`ui.tsx:BrandMark/LocalUserAvatar` | 模式 `实现与验证`；只读会话 `阅读与分析` + `只读`；空闲 `空闲` |
| 日期分组标签按真实时间 | COVERED | `conversationView.ts:groupMessagesByDay/dayLabel` | `2026年9月22日 · 实现与验证` |
| 引用 chip（`.refchip` 形态 + 与既有引用同源 + 不退化） | COVERED | `MessageRow` refchip 分支 | `@ spec.md`（10px / `1px 5px` / 4px / `#edeff3` / `#dfe3eb`）；`restoredFlows.test.tsx` 断言发送后仍在消息上 |
| 工具结果卡（行 / 步骤 / 结论条 / 卡内动作，数据不得编造） | COVERED | `conversationView.ts:toolResultView`、`TaskPage.tsx:ToolResultCard` | §2；无记录时不渲染 |
| 消息尾部归属行（`Provider · 账号 / 模型`，不可用按既有规则） | PARTIAL | `MessageRow` → `MessageAttribution` | 名称侧 `Anthropic 官方 / Claude Sonnet`；不可用分支（模型已移出配置）显示橙色说明「模型 … 已不在该配置中，历史保持不变」。**账号段缺失**：`ProviderProfile`（`data/types.ts:388`）只有 `authRef`（凭据引用名，不得展示），没有「账号」显示名 → 见 §6 残留 R1 |
| 空态（π + 两行文案；有消息后消失） | COVERED | `TaskPage.tsx` `conversation-empty` 分支 | `1440x900-conversation-empty.png`；测试断言发首条消息后消失 |
| 子代理条几何 + 卡片网格 + a11y + 回收 78px | COVERED | `ToolPanels.tsx:SessionSubagentList` | §3；`aria-label="当前会话启动的 Subagent"`、卡片 `查看 X，状态` + `aria-pressed`、`1 个运行中`、`minmax(190px,1fr)`、≤960 单列 |
| 纵向预算不退化 | COVERED | — | §3 表 |
| 只读会话只影响展示 | COVERED | `conversationBadge` / `conversationModeLabel` | 只读会话 `mode=阅读与分析`、`badge=只读`、消息数 32 不变；权限行为未改（`composerAlignment.test.tsx` 覆盖输入区） |
| 用例覆盖（日期分组 / 头部 / chip / 卡片各部件 / 归属不可用 / 空态 / 子代理条几何与可访问名） | COVERED | `test/conversationView.test.ts`（14 例）、`test/conversationAlignment.test.tsx`（4 例） | renderer **54 文件 / 463 例**（基线 52/445 → +2 文件 / +18 例） |
| 证据提交（多档截图 + 几何 JSON + 原型对照 + 本日志） | COVERED | `docs/evidence/ui-alignment-s6/` | 13 张渲染截图 + 1 张原型对照 + `conversation.json` + 本文件 |
| 证据脚本 `data-testid` 定位、可重跑、带几何断言 | COVERED | `capture-conversation.mjs` | 85 条断言、0 违反；`[data-testid=…]` 前缀定位 |
| 既有用例零回归 + `pnpm turbo run typecheck test build lint --force` | COVERED | — | §5 |

## 5. 门禁

| 项 | 结果 |
| --- | --- |
| `pnpm turbo run typecheck test build lint --force` | 全绿（见交付回报中的汇总数字） |
| renderer 用例 | **54 文件 / 463 例**（基线 52 / 445） |
| shell 用例 | 54 文件 / 801 例（未变） |
| S6 证据脚本 | `ok (85 checks)`，0 违反 |
| S3 证据脚本（跨切片复测） | `ok (42 measured states)`，9 态下限全部达标 |
| S4 证据脚本（跨切片复测） | `ok (22 measured states)`；输入区 143px 未回退 |

## 6. 已声明的偏差、口径与残留

**偏差（有意，均已实测）**

1. **子代理条默认折叠**：原型 A 常驻展开卡片网格；本片改为「一行 + 展开列表」开关（收起 51px / 展开 120px）。
   原因：#29 评审记录的 78px 常驻挤压。信息未隐藏（数量 + `N 个运行中` 留在标签行）。
2. **工具卡渲染位置**：原型把 `.toolcard` 写在某条助手消息体内；Host 没有「每条消息的工具调用记录」，
   本片按会话级 `RunRecord` 渲染一条卡（在滚动区末尾）。因此卡片不绑定某条消息，也不会随时间伪造多条。
3. **行右侧文案**：第二行右侧用真实数据 `N 本地 · M 远程`（原型示例写作「任务内覆盖」——该短语对应原型内置数据，
   本应用的服务模式计数才是有据可查的值）。
4. **账号段未渲染**：原型 `Anthropic · 工作账号 / Claude Sonnet` 中的「账号」在本应用没有显示名（只有 `authRef` 引用名）。
   本片渲染 `<Provider 显示名> / <模型显示名>`，不可用时按既有 `describeHistoryAttribution` 规则给出说明；
   未回退成只显示 id。
5. **空态品牌尺寸**：原型空态用基准 `.brandmark`（29px），本片沿用消息头的 22px 品牌标记（`BrandMark size="sm"`），
   不为此单开第三种尺寸。品牌标记的形状/尺寸本身是 [#25](https://github.com/Leonz3n/PiDock/issues/25) 遗留的用户裁决项。
6. **无时间戳的消息**：`Message.createdAt` 是本片新加的**可选**字段，适配器写消息时打上；历史种子消息补了
   `createdAt`。Host 侧真实通路（`shell-host`）没有逐消息时间戳时，头部不显示时间，而不是用「刚刚」冒充。

**未测 / 残项（含去处）**

| # | 项 | 状态 | 去处 |
| --- | --- | --- | --- |
| R1 | 归属行的「账号」显示名 | RESIDUAL-UNTESTED | 需要 Host/配置侧提供账号显示名（`ProviderProfile` 无该字段）；记录，不前端编造 |
| R2 | 每条消息的工具调用记录 | RESIDUAL-UNTESTED | Host 侧消息模型缺该字段；工具卡因此描述会话级 `RunRecord`（见偏差 2） |
| R3 | 运行中 live 点的截图 | 未提交（原因见 §2） | 由 `conversation.json` 断言 + `conversationView.test.ts` 覆盖；截图会因假时钟推进而失真 |
| R4 | Electron GUI 内的真实观感（字体、滚动、粘贴图片硬件路径） | RESIDUAL-UNTESTED | 既有环境残留（GUI 在代理环境被 OS 级弹窗阻塞），需用户本地确认；[#25](https://github.com/Leonz3n/PiDock/issues/25)–[#30](https://github.com/Leonz3n/PiDock/issues/30) 同 |
| R5 | 品牌标记形状 / 工具区宽度 / 用户 chip 名称 | 待用户裁决 | [#25](https://github.com/Leonz3n/PiDock/issues/25) 起的三项遗留决策 |
