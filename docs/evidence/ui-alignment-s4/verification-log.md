# [UI 对齐 06] (#30) 输入区与附件 — 验证记录

日期：2026-09-24 · 分支 `main` · 基线 `d8d2847`（S3 收口）→ 交付 `b305f41` + 评审修复轮
证据脚本：`node docs/evidence/ui-alignment-s4/capture-composer.mjs`（渲染层 4335 / 原型 A 4319）
原始数据：`composer.json`（5 档 ×（渲染层 + 原型）+ 9 个状态，**21** 个测量态带几何断言，违反即非零退出）

**定位规则（本切片引入并写进两个脚本）**：证据脚本一律用 `data-testid` 定位，不得依赖
`aria-label` 或可见文案。真实事故：#30 把输入框可访问名改成原型文案「给 Agent 的消息」，
而 [UI 对齐 05] (#29) 的脚本仍按「消息输入」定位 → 整条跨切片证据链 `locator` 超时、
无法复跑。修复轮补齐了 `task-composer-input` / `composer-send` / `composer-permission` /
`composer-attach` / `composer-file-input` / `composer-model-trigger` / `composer-image-warning` /
`composer-attachment-open|remove` / `tool-tab-<panel>` / `session-new` / `session-menu-*` /
`session-name-input|save` 等 testid，并把两个脚本改为按它们定位（#29 脚本已重跑并复测，见其 §3.1）。

## 1. 验收逐条结论

| # | 验收项 | 结论 | 证据 |
| --- | --- | --- | --- |
| 1 | 输入区外观与原型一致（内缩/圆角/**阴影**、textarea `min-height:66px`、`+` 22px 方形、发送按钮右下） | COVERED | textarea **66px**、附件按钮 **22×28**、发送 **27×27** 强调色方块 + `arrow` 字形、圆角 `10px` 与描边同值；**20px 侧内缩**实测 5 档全为 20/20（原型 `.composer-wrap{padding:9px 20px 15px}`）；**阴影** `rgba(36,43,59,0.02) 0px 3px 10px 0px` 与原型 `.composer` 同层（断言：渲染层计算值必须包含原型的阴影层）；5 档页面截图 + 5 档**输入区裁剪**截图 |
| 2 | 可访问名称与原型一致 | COVERED | textarea「给 Agent 的消息」、附件「添加文件」+`title`、发送「发送消息」、权限「选择权限：<模式>」、模型「选择模型：<模型>」+`aria-haspopup="dialog"`、**推理触发器默认渲染**「推理 · 跟随模型」、移除按钮「移除 <名称>」（原型写法）；placeholder 与原型逐字一致（用例断言） |
| 3 | **粘贴图片/截图成为附件** | COVERED | 剪贴板图片 → `kind="attachment"` + 预览 + 可移除；命名 `粘贴图片-<4 位随机键>.<ext>`，**两次粘贴名称不同**（用例 + `composer.json.states.paste`）；剪贴板纯文本插入光标处；无图片时完全不拦截；来源行「剪贴板图片 · N KB · 仅本页保留」 |
| 4 | `compose-meta` 行（计量条 + `估算 x k / <window> · <%>` + 本会话 tokens） | COVERED | 实测 `24.8k / 200k · 12.4%` + `本会话 68.4k tokens`；计量条 43×4px；数值全部来自 Host 会话记录（`contextUsed/contextWindow/contextSource/tokens`），**渲染层无本地估算**；`估算/待更新` 标记由 `describeContextDisplay()` 决定；浮层 `role="dialog"` + `aria-label` + Esc + **焦点返回触发按钮**（用例断言 `toHaveFocus`） |
| 5 | 附件条按原型（缩略图/文件名/移除/展开 + 不支持图片警告） | COVERED | 紧凑芯片（缩略图 + 名称）+「预览 <名称>」按钮 +「移除 <名称>」；**展开改为模态灯箱**（原型 `attachments.js` 用 `modal()`），不再内联占高；警告文案与原型逐字一致（`role="status"` + 内联「选择模型」）、附件保留、发送禁用 |
| 6 | 发送前校验与键盘行为不退化 | COVERED | 既有用例全绿未削弱（模型已移除 / 空文本 / `/命令` / 思考档位 / 不支持图片；Enter 发送、Shift+Enter 换行、补全 ↑↓/Tab/Enter/Esc)；无 `.skip/.only/.todo` |
| 7 | **修 #27 残留：窄栏输入区高度不再膨胀** | COVERED | 见 §2.1：**5 档全部 143px**（#27 已提交证据：1440/1280 = 145、1024 = **179**），按钮行恒单行 28px、`rowWrapped=false` |
| 8 | 纵向预算不退化 | COVERED | 无卡片参照态 **409px ≥ 400px**（#27 基线 408px，见 §2.3）；带卡片三态实测 **346 / 315 / 315**，见 §2.4 与 #29 的双档口径（审批/过期 ≥340、带既有 chrome 的态 ≥300） |
| 9 | 只读会话禁用 + **可见**提示（只出现一次） | COVERED | textarea / 附件入口 / 文件选择 / 发送均禁用且 `+` 有 `disabled:opacity-50`；可见说明行 `role="status"`；**只读 + 有记录的档位由卡片说明行承担、输入框不再重复**（实测 `composerHintVisible=0`，用例锁定） |
| 10 | 用例覆盖 | COVERED | `composerAlignment.test.tsx` **11 例**（+3：两次粘贴名称唯一 + blob 释放、默认态推理触发器、只读规则只出现一次）+ `composerRules.test.ts` 2 例；几何走可复跑脚本 + 断言 |
| 11 | 证据提交 | COVERED | `composer.json`（5 档 ×（渲染层+原型）+ 9 状态）+ `renderer/` **18 张**（5 档页面 + 5 档裁剪 + card-free/paste/readonly/warning/heavy + `1440-card-{approval,failed,failed-readonly}`）+ `prototype/` 6 张 + `capture-composer.mjs` |
| 12 | 门禁全绿 | COVERED | 见 §7 |

## 2. 几何表（实测）

### 2.1 输入区高度按档位（修复前 → 修复后，对照原型 A）

| 档位 | 修复前 | 修复后 | 原型 A | 差（后 − 原型） |
| --- | --- | --- | --- | --- |
| 1440×900 | 145 | **143** | 167 | −24 |
| 1280×900 | 145 | **143** | 167 | −24 |
| 1024×800 | **179** | **143** | 167 | −24 |
| 900×800 | 未测量（无出处） | **143** | 167 | −24 |
| 720×760 | 未测量（无出处） | **143** | 167 | −24 |

跨档位极差 **0px**（断言 ≤2px）。组成：textarea 66（原型 66）+ 按钮行 28（原型 28）+
表单内边距 20 + 边框 2 + meta 行 15（原型 19）+ 表单与 meta 间距 6（原型 8）。
> 「修复前」列只保留能从已提交证据核对的数字（`ui-alignment-s2/vertical-budget.json` 的
> 1440/1280/1024）；900/720 的旧值曾以 145/179 出现在上一版报告里但**在已提交证据中查不到出处**，
> 本轮按事实改为「未测量」，不再保留无出处数字。

### 2.2 其余实测（渲染层 vs 原型 A）

| 项 | 渲染层 | 原型 A |
| --- | --- | --- |
| 输入区侧内缩（5 档一致） | **20 / 20** px | 20 / 20 px |
| 表单与 meta 行间距（5 档一致） | **6** px | 8 px（有意更紧，见 §5） |
| 表单阴影 | `… rgba(36,43,59,0.02) 0px 3px 10px 0px` | `rgba(36,43,59,0.02) 0px 3px 10px 0px` |
| 附件入口 / 发送按钮 | 22×28 / 27×27 | 宽 22、命中区 28 / 27×27 |
| 按钮行高（是否换行） | 28 / 不换行（全档，含 720） | 单行 |
| meta 行 | 15px | 19px |

### 2.3 状态实测

| 状态 | 输入区 | 消息区 | 说明 |
| --- | --- | --- | --- |
| 无卡片参照态（真实用户路径：先在 `deploy` 拒绝待确认请求 → 切回 `main`） | 143 | **409**（下限 400） | #27 基线 408，本切片 +1 |
| 只读（无卡片动作） | **168**（143 + 说明行 25） | 326 | 可见说明行在输入框内（卡片无法承担） |
| 粘贴图片后 | 193 | — | 芯片行 50px |
| 12 个附件 | 212 | 281 | 原型 213 / 210；条带 61px 不滚动、未超 182px 上限 |
| 不支持图片 | 227 | 266 | 警告行 + 芯片行；发送禁用、附件保留 |

### 2.4 执行状态卡档位（[UI 对齐 05] (#29) 双档下限复测）

| 档位 | 输入区 | 消息区 | 下限 | 卡片 | 结论 |
| --- | --- | --- | --- | --- | --- |
| `approval` 等待确认 | 143 | **346** | 340 | 141 | 达标 |
| `failed` 失败 | 174 | **315** | 300 | 141 | 达标（174 = 143 + 草稿引用行 31） |
| `failed-readonly` 只读 + 记录 | 174 | **315** | 300 | 141 | 达标；卡片说明行可见、输入框不再重复（`composerHintVisible=0`） |

其余档位（`running` 305、`expired` 406、`completed` 309、`stopped`/`rejected` 434、
`idle-other-busy` 350）由 #29 脚本在**同一提交**上复测，见其 §3.1。

## 3. 与票面的出入（如实记录）

1. **票面「档位 ≤1024 / ≤720 内边距降级」不成立**：原型 A 的 `.composer-wrap` 5 档恒为 `9px 20px 15px`；那两条 `10px`/`12px` 属于 `.runtime-layout`/`.focus-layout` 变体。**父流程已把该子句从票面作废**（评审核对 `style.css` 后确认），本切片按原型实际行为实现「不随档位改内边距」。
2. **票面「本会话 tokens 也可点开浮层」不成立**：原型该按钮的动作是 `view:usage`（跳 Token 用量页）。实现按原型跳转，浮层语义落在上下文按钮与模型/权限/推理浮层上。

## 4. 顺带修正的既有缺陷

- **`Modal` 关闭后不还焦点** → 记录打开时的 `document.activeElement` 并在卸载时恢复（用例断言）。
- **`IconButton` 无 `disabled:` 样式** → 补 `disabled:cursor-not-allowed disabled:opacity-50`。
- **模型触发按钮文案过长导致窄档截断** → 改为原型 `.model-trigger` 形态（模型名 + `down` 字形），提供者/模型 id/窗口留在 `title` 与 meta 行；并补原型的「· 不可用」后缀。
- **发送按钮** → 原型 `.send` 的 27×27 强调色方块 + `arrow` 字形。
- **表单下方常驻说明行删除** → 「仅本页预览」信息由每个附件的 `detail` 承载。
- **blob URL 从不释放**（评审 P2-D）→ 附件离开草稿（移除/发送/切换会话）即 `revokeObjectURL`；卸载时只释放草稿已不再引用的 URL（否则回到任务时草稿里的缩略图会变成破图）。
- **粘贴附件名恒为 `粘贴图片-atta.png`**（评审 P1-2）→ id 前置 4 位随机键，两次粘贴名称与可访问名都不再相同。
- **只读规则出现两份**（评审 P1-1/P2-E）→ 卡片与输入框共用一份执行状态视图，卡片有可禁用入口时由卡片承担，否则由输入框承担。

## 5. 有意偏离（与原型不同，注明理由）

1. **紧凑芯片 + 灯箱**：原型 `.image-attachment` 是 112×65 卡片，本实现保留 32px 紧凑芯片、展开走模态灯箱。理由：原型自身输入区 167px、12 附件档 213px，若照搬卡片形态会再吃掉消息区（父流程下限）；灯箱与原型 `modal()` 的交互一致。
2. **表单与 meta 行间距 6px（原型 8px）**：本切片的输入区已比原型矮 24px，把 2px 还原会重新贴到 #29 的审批态下限（340px）上。
3. **输入区纵向内缩**：原型 wrap 另有 9px（上）/15px（下）内边距，本实现由任务区留白承担；补足会再占 24px 消息区。
4. **320px 以下档位的换行**：原型 `.compose-bottom` 无 `flex-wrap`，本实现保留 `flex-wrap` 作为窄档降级（实测 5 档均未触发换行）。上一版用例注释把 `flex-wrap` 归因给原型，评审指出有误，本轮已改正注释。

## 6. 残项（含去向）

- **R1 真实剪贴板路径未端到端验证**：浏览器证据用页面内构造的 `ClipboardEvent` + 真 `DataTransfer`（真 React 处理器与 store、真渲染），**不是**系统剪贴板硬件路径；jsdom 用例是手写 `clipboardData` 替身。证明：处理器、命名、草稿插入、store 效果、`defaultPrevented`；不证明：浏览器/OS 剪贴板权限与 `navigator.clipboard`。**去向**：随 [#22](https://github.com/Leonz3n/PiDock/issues/22) 打包后在真机上手测。
- **R2 附件仍为内存态**：不落盘、不上传、刷新即失（blob 生命周期已在 §4 修正）。
- **R3 权限/推理触发器形态未完全照原型**：原型 `.permission-trigger` 有模式图标 + 箭头、`.thinking-trigger` 有箭头；本实现仍是无边框文字按钮（可访问名与文案已一致，默认态已渲染）。**去向**：[#24](https://github.com/Leonz3n/PiDock/issues/24) 后续切片统一控件形态。
- **R4 只读态输入区比常态高 25px**（168 vs 143）：该档位没有可禁用的卡片入口，规则只能落在输入框内；消息区 326px 仍充裕。**去向**：如后续统一对话区预算再收敛。
- **R5 `compose-meta` 行高 15px vs 原型 19px**：10px 文字 + 紧行高，数值与语义一致、更省纵向。
- **R6 12 附件档输入区 212px（本切片前 184px）**：20px 侧内缩让条带多占一行；仍低于原型同档 213px、消息区 281px 高于原型 210px。
- **R7 720×760 档页面高 2804px**：整页截图看不到输入区，已补裁剪截图（`720x760-composer-crop.png`）；该档不参与消息区下限（视口高度不同）。
- **R8 `#29` 交接项「失败态输入框 175px」**：现为 **174px**（143 结构 + 31 草稿引用行），该档消息区 **315px ≥ 300**。差额来自用户草稿里的引用行而非应用 chrome，**不再作为缺口**；[#29](https://github.com/Leonz3n/PiDock/issues/29) 残项表已按此更新。
- **未测（by design）**：Electron GUI 重启需本地目视确认；真实文件上传/服务进程属 #13 产品缺口；B/C 变体未实现。

## 7. 门禁

```
pnpm turbo run typecheck lint test build --force
 Tasks:    8 successful, 8 total
 @pidock/shell:test:       Tests  801 passed (801)     (54 files)
 @pidock/renderer:test:    Tests  444 passed (444)     (52 files; #29 交付时 51/431)
 not wrapped in act: 0 ; eslint --max-warnings 0 通过
node docs/evidence/ui-alignment-s4/capture-composer.mjs
 geometry assertions: ok (21 measured states)
node docs/evidence/ui-alignment-s3/capture-execution.mjs
 geometry assertions: ok (36 measured states)
```

## 7.1 复跑幂等性（本次实测）

在交付提交上把两个捕获脚本各重跑一次，逐字段对比：**所有几何数值、状态值、断言结果完全一致**
（s4 555 个字段中 1 个不同、s3 1423 个字段中 6 个不同，无一为测量值）：

- `states.paste.attachmentLabels[0]`：`粘贴图片-3304.png` → `粘贴图片-6edc.png` —— 这正是 P1-2 的修复，粘贴名的 4 位键**每次运行都不同**（有意）。
- s3 的 `tabStripLongName.*.tabs[3].id`：新建会话的 id 含时间戳，脚本每次运行都新建一个会话（该脚本既有行为，非本次引入）。

因此：重跑会让工作树出现 2 个 JSON + 数张截图的差异（键与抗锯齿），**数值不变**；复核时以数值字段为准。

## 8. 评审修复轮（review 结论 → 落地）

| review 项 | 结论 | 落地 |
| --- | --- | --- |
| P1-1 纵向预算在带卡片态被突破 | 已修（实测确认） | 复现：`running` **299 < 300**、`approval` **340（贴地板）**；成因是输入区结构改动全档 +4px。修法：去掉表单与 meta 行的重复间距（`gap-1.5` 与 `mt-1.5` 叠加了 12px）→ 输入区 **143px**；加上「只读规则只出现一次」→ 复测 `running` **305**、`approval` **346**、`expired` **406**、`failed-readonly` **315**；S4 脚本新增 3 个卡片档位实测 + 下限断言，S3 脚本重跑并记录 §3.1 |
| P1-2 粘贴判别名恒为 `atta` | 已修 | id 前置 4 位随机键；用例「两次粘贴名称不同」+ 证据 `attachmentLabels`；移除后 `revokeObjectURL` 被调用（用例断言） |
| P2-A 阴影/内缩/meta 间距 | 已修 + 已断言 | 补原型阴影层、补 20px 侧内缩（5 档实测 = 原型 20/20）、meta 间距 6 vs 原型 8（§5 记录理由）；三者都进 `assertGeometry()`（原型参考值本身也被断言非空，避免断言空转） |
| P2-B 芯片形态与移除名 | 已修 | 移除按钮改名「移除 <名称>」；展开改模态灯箱；紧凑形态写入 §5 有意偏离 |
| P2-C 默认态缺推理触发器 | 已修 | 触发器改为始终渲染，默认「推理 · 跟随模型」（用例断言）；模型触发器补「· 不可用」后缀 |
| P2-D blob URL 泄漏 | 已修 | 见 §4（移除/发送/切换会话释放；卸载只释放草稿不再引用的） |
| P2-E #29 交接项未披露 | 已记录 | §6-R8（实测 174px / 消息区 315px） |
| P2-F 证据卫生 | 已修 | 张数口径改对（18 张，逐类列出）；无出处的「修复前」数字删除（§2.1 注）；720 档补裁剪截图；`flex-wrap` 归因注释改正；`prevented` 变量语义命名改正 |
