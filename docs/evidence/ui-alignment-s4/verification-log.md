# [UI 对齐 06] (#30) 输入区与附件 — 验证记录

日期：2026-09-24 · 分支 `main` · 基线 `d8d2847`（S3 收口）
证据脚本：`node docs/evidence/ui-alignment-s4/capture-composer.mjs`（渲染层 4335 / 原型 A 4319）
原始数据：`composer.json`（18 个实测状态，脚本内置几何断言，违反即非零退出）

## 1. 逐盒结论

| # | 验收项 | 结论 | 证据 |
| --- | --- | --- | --- |
| 1 | 输入区外观与原型一致（容器内边距/圆角/阴影、textarea `min-height:66px`、`+` 附件按钮 22px 方形、发送按钮右下、档位内边距降级） | COVERED | textarea **66px**、附件按钮 **22×28**（原型 `.composer .iconbtn{width:22px}` + `.iconbtn{height:28px}`）、发送按钮为原型 `.send` 的 27×27 强调色方块 + `arrow` 字形；表单圆角/描边/内边距与原型 `.composer` 同值；5 档截图 `renderer/*-composer.png` |
| 2 | 可访问名称与原型一致 | COVERED | textarea「给 Agent 的消息」、附件入口「添加文件」+ `title`、发送「发送消息」（图标按钮的 `aria-label`）、模型触发 `aria-haspopup="dialog"`、权限/推理触发同属性；placeholder 与原型逐字一致（用例断言） |
| 3 | **粘贴图片/截图成为附件** | COVERED | 剪贴板图片 → `kind="attachment"` + 预览 + 可移除，命名 `粘贴图片-<id4>.<ext>`、来源行「剪贴板图片 · N KB · 仅本页保留」；剪贴板纯文本按原型插入光标处（用例 + 浏览器实测 `defaultPrevented=true`、草稿 `看这张截图`、toast「已粘贴 1 张图片，可附上文字后发送」）；**无图片时完全不拦截**（浏览器原生文本粘贴与撤销保持可用） |
| 4 | `compose-meta` 行（计量条 + `估算 x k / <window> · <%>` + 本会话 tokens） | COVERED | 实测 `24.8k / 200k · 12.4%` + `本会话 68.4k tokens`；计量条 43×4px 与填充宽度取自 `describeContextDisplay().percent`；**无伪造估算**：种子会话 `contextSource="actual"` 时**不显示**「估算」，`estimated`/`pending` 时才显示 `估算` / `待更新`（`providersFlow` 断言压缩后出现「待更新」）；两者均为 `role="dialog"` + `aria-label` + Esc 关闭 + **焦点返回触发按钮**（`Modal` 通用修正，用例断言 `toHaveFocus`），`aria-expanded` 与 store 中打开的浮层一致 |
| 5 | 附件条按原型（缩略图/文件名/移除/展开 + 不支持图片警告） | COVERED | 芯片 = 「预览 <名称>」按钮（`aria-pressed`、`title` 为来源行）+ 「移除附件 <名称>」；展开显示大图 + 来源行；`attachment-warning` 文案与原型逐字一致（`role="status"` + 内联「选择模型」），并保留「不静默丢附件」（实测附件仍在、草稿保留、发送按钮禁用） |
| 6 | 发送前校验与键盘行为不退化 | COVERED | 既有用例全绿未削弱（模型已移除 / 空文本 / `/命令` / 思考档位 / 不支持图片；Enter 发送、Shift+Enter 换行、补全 ↑↓/Tab/Enter/Esc）；`composerFlow` / `restoredFlows` / `providersFlow` 等 52 个文件 441 例通过 |
| 7 | **修 #27 残留：窄栏输入区高度不再膨胀** | COVERED | 见 §2：**5 档全部 149px**（修复前 1440/1280/900 = 145、1024/720 = **179**），按钮行 **恒为单行 28px**（`rowWrapped=false`） |
| 8 | 纵向预算不退化 | COVERED | 无卡片参照态（真实用户路径：先在 `deploy` 会话拒绝待确认请求 → 切回 `main`，执行卡消失）消息区 **403px ≥ 400px**（#27 口径；修复前 408px，差值即 +4px 输入区高度）；带执行卡的 1440×900 实测 344px，满足 #29 双档下限（≥300px） |
| 9 | 只读会话禁用 + 可见提示 | COVERED | textarea / 附件入口 / 文件选择 / 发送均禁用，且 `+` 按钮带 `disabled:opacity-50`（`IconButton` 新增，浏览器截图确认视觉禁用）；可见说明行 `role="status"`：「当前是只读会话，请先调整会话权限；只读会话可以阅读与分析，不能发送消息或添加附件。」 |
| 10 | 用例覆盖 | COVERED | 新增 `test/composerAlignment.test.tsx`（8 例：名称/几何契约、meta 数值来源与计量条、粘贴图片、无图片不拦截、附件条上界与不缩放、不支持图片警告+禁发、Esc 焦点返回、只读禁用可见提示）+ `composerRules.test.ts` 新增 2 例（`pastedImageFiles` / `attachmentSourceLabel` 纯规则）；宽高契约在 `pnpm test` 内可跑（类名契约，几何以脚本实测为准） |
| 11 | 证据提交 | COVERED | `docs/evidence/ui-alignment-s4/`：`composer.json`（5 档 ×（渲染层+原型）+ 6 状态）、`renderer/` 9 张 + `prototype/` 6 张截图、`capture-composer.mjs`（可重跑 + 断言） |
| 12 | 门禁全绿 | COVERED | `pnpm turbo run typecheck test build lint --force` → **Tasks: 8 successful, 8 total**；`@pidock/shell` 54 文件 / **801 例**；`@pidock/renderer` **52 文件 / 441 例**（切片前 51/431）；`not wrapped in act` 警告 **0** |

## 2. 几何表（实测）

### 2.1 输入区高度按档位（修复前 → 修复后，对照原型 A）

| 档位 | 修复前 | 修复后 | 原型 A | 差（后 − 原型） |
| --- | --- | --- | --- | --- |
| 1440×900 | 145 | **149** | 167 | −18 |
| 1280×900 | 145 | **149** | 167 | −18 |
| 1024×800 | **179** | **149** | 167 | −18 |
| 900×800 | 145 | **149** | 167 | −18 |
| 720×760 | **179** | **149** | 167 | −18 |

跨档位极差 **0px**（≤2px 为断言），#27 的「窄栏 +34px 膨胀」消失。组成：textarea 66（原型 66）+ 按钮行 28（原型 28）+ 表单内边距 20 + 边框 2 + meta 行 15（原型 19）+ 间距。

### 2.2 其余实测

| 项 | 渲染层 | 原型 A |
| --- | --- | --- |
| `composer-wrap` 内边距（5 档一致） | —（表单 `10px 12px`） | `9px 20px 15px`（5 档一致） |
| 附件入口 | 22×28 | 28×28 命中区 / 宽 22 |
| 按钮行高（是否换行） | 28 / 不换行（全档） | 单行 |
| meta 行 | 15px | 19px / `font-size:10px` |
| 无卡片态消息区 | **403px**（≥400） | — |
| 12 个附件 | 输入区 **184px** / 消息区 **310px** | 输入区 **213px** / 消息区 **210px** |
| 只读态 | 输入区 174px / 消息区 320px | — |

## 3. 与票面的两处出入（如实记录）

1. **票面写「`composer-wrap` 内边距（≤1024 → 10px；≤720 → 12px）」不成立**：原型 A 的任务视图里 `.composer-wrap` **5 档恒为 `9px 20px 15px`**，高度恒为 167px（实测，已写入 `composer.json.prototype`）；那两条 `10px` / `12px` 属于 `.runtime-layout` / `.focus-layout` / `.subagent-workspace` 变体，不是媒体查询降级。本切片按原型实际行为实现「**不随档位改内边距**」，而不是按票面文字造一个原型没有的降级。
2. **票面写「本会话 tokens 也可点开浮层」不成立**：原型该按钮的动作是 `view:usage`（跳转 Token 用量页），不是浮层。实现按原型跳转（`navigate({view:"usage"})`，按钮 `aria-label="查看本会话 Token 用量"`）；"浮层 + Esc + 焦点返回"的断言落在上下文按钮（原型确实是 `contextDialog()`）与模型/权限/推理浮层上。

## 4. 顺带修正的既有缺陷

- **`Modal` 关闭后不还焦点**：所有弹窗（模型/权限/推理/上下文等）关闭时把焦点丢在 `body`。现记录打开时的 `document.activeElement` 并在卸载时恢复（新增用例）。这是「浮层 Esc 关闭并返回焦点」这条验收的落点。
- **`IconButton` 无 `disabled:` 样式**：只读会话的 `+` 会显示成可点击外观。补 `disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent`。
- **模型触发按钮文案过长导致窄档截断**：改为原型 `.model-trigger` 形态（模型名 + `down` 字形），提供者/模型 id/窗口留在 `title` 与 meta 行，因此 1181–1277 等档位不再截断。
- **发送按钮**：改为原型 `.send` 的 27×27 强调色方块 + `arrow` 字形（`Icon.tsx` 新增 `arrow`），可访问名仍为「发送消息」。
- **表单下方常驻说明行删除**：原型没有这一行；「仅本页预览 / 不写入业务仓库」的信息改由每个附件的 `detail` 承载（芯片 `title` + 展开行），与原型 `.image-attachment` 的 `source` 一致。

## 5. 未覆盖 / 未测（残项与去向）

- **R1 真实剪贴板路径未端到端验证**：浏览器实测用的是页面内构造的 `ClipboardEvent` + `DataTransfer`（真实 React 处理器与 store、真实渲染），**不是**操作系统剪贴板的硬件路径；jsdom 用例同理（jsdom 无 `DataTransfer`，用手写 `clipboardData` 替身）。可信度：证明处理器、命名、草稿插入与 store 效果；不证明浏览器/OS 的剪贴板权限与 `navigator.clipboard` 集成。**去向**：随 [#22](https://github.com/Leonz3n/PiDock/issues/22) 打包后在真机上手测一次粘贴。
- **R2 附件仍为内存态**：不落盘、不上传、刷新即失；`URL.createObjectURL` 产生的 blob 只在会话内有效（与切片前一致，本单不实现持久化）。
- **R3 权限/推理触发按钮的图标与箭头未对齐原型**：原型 `.permission-trigger` 有模式图标 + 箭头、`.thinking-trigger` 有箭头；本实现仍是应用内的无边框文字按钮（可访问名与原型一致）。**去向**：与 [#24](https://github.com/Leonz3n/PiDock/issues/24) 后续切片（S6/S7 的控件形态统一）一并处理。
- **R4 只读态输入区比常态高 25px**（174 vs 149，说明行 18px + 附件/提示换行）：只读是低频状态，且消息区仍 320px；未设下限。**去向**：如后续要求，随 S6 的对话区预算统一收敛。
- **R5 `compose-meta` 行高 15px vs 原型 19px**：本实现用 10px 文字 + 紧行高，数值与语义一致、更省纵向；未强行拉高到 19px（拉高会吃掉消息区）。
- **未测（by design）**：Electron GUI 重启需本地目视确认；真实文件上传/服务进程属 #13 产品缺口；B/C 变体未实现。

## 6. 门禁

```
pnpm turbo run typecheck test build lint --force
 Tasks:    8 successful, 8 total
 @pidock/shell:test:       Tests  801 passed (801)     (54 files)
 @pidock/renderer:test:    Tests  441 passed (441)     (52 files; before this slice 51/431)
 not wrapped in act: 0
node docs/evidence/ui-alignment-s4/capture-composer.mjs
 geometry assertions: ok (18 measured states)
```
