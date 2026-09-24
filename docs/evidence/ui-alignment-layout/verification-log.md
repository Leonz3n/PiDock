# [UI 对齐 02] (#26) 布局健壮性证据

切片：窄视口/默认窗口下侧栏与工具面板压垮对话区。基线：`prototypes/pidock-ui/style.css`（只读）
的 `@media(max-width:1180px/960px/850px/720px)` 多档降级。

## 1. 重跑方式

```bash
# 1) 渲染层 dev server（已在本机 4335 运行）
pnpm --filter @pidock/renderer dev

# 2) 量测 + 截图 + 断点核对（需要 dist 存在，先 build）
pnpm --filter @pidock/renderer build
node docs/evidence/ui-alignment-layout/capture-layout.mjs
```

脚本产物写回本目录（不写 `/tmp`）：`renderer/*.png`、`geometry.json`、`css-breakpoints.json`。
依赖：`packages/renderer/node_modules/playwright-core` + `~/Library/Caches/ms-playwright/chromium-1243`
（脚本内为绝对路径，`RENDERER_BASE` 可用环境变量覆盖）。量测宽度：1600 / 1280 / 1180 / 1024 / 960 /
800 / 720（1180 与 800 为档位边界探针，只量不截图）。

## 2. 逐盒结论

| # | 验收项 | 结论 | 证据（实测值） |
| --- | --- | --- | --- |
| 1 | 基准档（≥1180）：侧栏 226px；工具面板约 43% + `min-width:350px`；对话列占剩余且可滚动 | COVERED | 1600：侧栏 **226**、面板 **562**（43% × 1306）、对话列 **728**；1280：226 / 424 / 546。消息列是 `role="log"` + `overflow-auto`，高度 253 / 205 |
| 2 | 1180 档（960–1180）：侧栏 192px；面板 min 310px、约 40%；对话列不低于 320px | COVERED | **1180**（边界含值）：侧栏 **192**、面板 **368**（40% × 920）、对话列 **536**；1024：192 / **310**（min 生效）/ **438** |
| 3 | ≤960 折叠为 64px 图标轨：导航文案/计数/分组标题/任务列表/用户信息/`+` 隐藏，图标居中，可访问名保留 | COVERED | 960 与 800 与 720：侧栏 **64**；`visibleLabelTexts=[]`（文案被裁到 `sr-only`）；9 个导航按钮 + 「需要处理」在**每一档**都仍能被 `getByRole('button', {name})` 解析（`accessibleNames` 全为 1）；计数徽标/工作区卡/分组标题/任务列表/用户信息带 `below-mid:hidden`（`css-breakpoints.json` + jsdom 用例） |
| 4 | ≤720 纵向堆叠：对话区 `min-height:550px` 在前，工具面板 100% 宽（`min-height:500px`）在后 | COVERED | 720：对话列 **616**（=全宽）、面板 **616**（全宽，位于对话之下）、消息区自然高度 2473（页面滚动）；`renderer/720-both-scrolled.png` 可见「对话在上、工具面板在下」；`task-body` 带 `below-stack:block/flex-none/space-y-3` |
| 5 | 子代理面板 40%/min 340/max 520；≤850 → min 300/45%；≤720 堆叠，不再把对话列挤成 0 | COVERED | 仅开子代理时面板宽：1600 **520**（max 生效）、1280 **394**、1180 **368**、1024 **340**（min 生效）、960 **340**、800 **309**（45% × 686）、720 **616**（堆叠全宽）。两面板同开时二者同处一条右栏（`subagentInRail=true`），对话列从未归零 |
| 6 | 对话列 `min-w-0`，任何视口无横向溢出 | COVERED | 每档每状态 `noHorizontalOverflow=true`（`docScrollWidth <= docClientWidth`）；另加 30 个「路由 × 视口」扫描（10 页 × 1600/1024/720）**0 溢出**；`task-workspace` 带 `min-w-0`（jsdom 用例 + 源码） |
| 7 | 主进程窗口 `minWidth:720, minHeight:560`，默认尺寸调整到基准档 | COVERED（代码）/ RESIDUAL-UNTESTED（运行时） | `packages/shell/src/main/runtime.ts:65-77`；见 §4 决策 1 与 §5 残留 1 |
| 8 | 多视口截图 + 几何 JSON（五档、两种状态） | COVERED | `renderer/{1600,1280,1024,960,720}-{tools,both}.png` 10 张 + `720-both-scrolled.png`；`geometry.json`（7 档 × 3 状态：侧栏宽、面板宽、对话列宽、消息区高度、溢出布尔、`mediaMatches`、可访问名计数） |
| 9 | 既有用例零回归 + 新增各档用例 | COVERED | renderer **44 文件/378 例 → 45/384**（新增 `src/test/responsiveLayout.test.tsx` 6 例）；既有文件仅 `Shell.tsx`/`ShellSidebar.tsx`/`TaskPage.tsx` 的样式与结构改动，**未删改任何既有断言** |
| 10 | `pnpm turbo run typecheck test build lint --force` 全绿 | COVERED | **8/8 tasks**；`@pidock/shell` 54 文件/801 例；`@pidock/renderer` 45 文件/384 例；无 lint/typecheck 报错；`not wrapped in act` 0（`/tmp/pidock-uialign/gate-s0.log`） |

### 断点落地核对（`css-breakpoints.json`）

构建产物 `packages/renderer/dist/assets/index-*.css` 中 `@media(max-width:NNNpx)` 依次出现
**1180 → 960 → 850 → 720**（顺序即级联顺序，窄档覆盖宽档）；每个档位内都能找到对应的工具类
（1180：`w-[192px]`/`w-[40%]`/`min-w-[310px]`；960：`w-16`/`sr-only`/`hidden`/`min-w-[290px]`/
`justify-center`/`px-2`；850：`w-[45%]`/`min-w-[300px]`；720：`block`/`w-full`/`min-h-[550px]`/
`min-h-[500px]`），`missingUtilities: []`。这同时证明**没有**落到 Tailwind 默认的 640/768/1024/1280。

## 3. 门禁

```
Tasks:    8 successful, 8 total（--force，无缓存）
@pidock/shell:    Test Files 54 passed (54)   Tests 801 passed (801)
@pidock/renderer: Test Files 45 passed (45)   Tests 384 passed (384)
```

## 4. 决策记录

1. **默认窗口尺寸**（#26 决策 1）：`WINDOW_OPTIONS` 由 `1024×768` 改为 **`1440×900`**，并加
   **`minWidth: 720` / `minHeight: 560`**。理由：1024 必然落在 1180 降级档，用户看不到基准档；
   720/560 是原型定义了布局的最窄档（≤720 的堆叠档），更窄的宽度原型未定义。这是原型之外的产品
   决策，已在源码注释与本文件写明。
2. **断点体系**（#26 决策 2）：在 `packages/renderer/src/styles/tokens.css` 用 `@custom-variant` 写
   显式 `@media (max-width: …)`（原型语义，含边界值），而非 `@theme --breakpoint-*` 的 min-width
   语义；命名 `below-wide/below-mid/below-narrow/below-stack` 对应原型的 1180/960/850/720。原型只
   有「基准 + 向下覆盖」，因此不需要 min-width 变体。
3. **单条右栏（取舍）**：原型 A 从不同时把工作台与子代理侧栏摆在对话旁边（子代理侧栏在
   `.subagent-workspace` 内，工作台在 `.runtime-section`/`.focus-main` 内）。实现里两者原本是两个
   独立列（43% + 40%，再加两条 16px 间距）：1440 档只剩约 163px 给对话列，1024 档（可用 730px −
   380 − 360 − 32）直接归零。因此改为**一条右栏**：
   开工具面板时为工具几何（43%/min 350），只开子代理时为子代理几何（40%/min 340/max 520），两者
   同开时用工具几何并把子代理面板叠在同一列的上方。`subagent-sidebar` 这个 testid 保留在子代理面
   板外层，既有用例不受影响。
4. **图标轨的可访问名用 `sr-only`**：原型在 ≤960 用 `display:none` 隐藏 `.navtext`，那会让按钮失去
   可访问名。实现改为 `below-mid:sr-only`——图标轨上只见图标，可访问名（含计数）仍在 a11y 树里，
   证据见每档 `accessibleNames` 全为 1。这是对原型的**有意偏离**（可访问性），非视觉差异。
5. **`sr-only` 而非 `aria-label`**：若把导航按钮改成 `aria-label={label}`，S1 既有用例
   `navItemLabels()` 读到的名字会从「需要处理3」变成「需要处理」而失败；`sr-only` 既保留可访问名又不
   动既有断言。
6. **外壳页内边距**：按原型 `.page` 的三档（`30px 34px` → ≤960 `25px` → ≤720 `20px`）同步，避免窄档
   白白吃掉 28px 可用宽度。

## 5. 未测 / 残留

1. **Electron 运行时未验证**：`minWidth/minHeight` 与 1440×900 默认值只做了代码改动与门禁验证；沙箱
   内不能重启 GUI 实例（当前在跑的 dev 实例仍是旧主进程代码，窗口 368×736）。「Electron 是否真的
   阻止拖到 720 以下」**未实测**。
2. **纵向挤压未解决（属 S2 范围）**：工具面板+子代理同开时，1024 档消息区仅 **74px**、800 档仅
   **26px**——原因是任务头部 11 个文字按钮会竖排换行（`renderer/1024-both.png` 可见）。本切片只处理
   宽度档位，头部结构属 S2「任务工作区头部」，已量测记录，未修。
3. **底部摘要栏未按原型降级**：原型 `.switcher` 在 ≤1180 `max-width:130px`、≤960 隐藏 `.state`、≤720
   `gap:2px;padding:6px`，本切片**未改**（不在 #26 验收项内，且会隐藏真实「Agent 控制中」信息）。
   需父流程决定是否另开切片。实测 720 下摘要栏未造成溢出。
4. **jsdom 不评估媒体查询**：新增用例断言的是「档位类挂在正确元素上」与 `aria-label`/`sr-only` 语义；
   真实档位行为以 `geometry.json`（Chromium 实测）为准，两者互不替代。
5. **只测了 Chromium**：Safari/Windows WebView 的 flex 行为与 `sr-only` 渲染未验。
6. **两面板同开时的先后顺序**：子代理面板在右栏上方、工具面板在下方，这是实现选择（原型无对应布
   局），未做用户验证。
