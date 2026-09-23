# [UI 对齐 01] #25 收尾修复轮证据日志

本文件记录 #25 收尾修复轮实际运行后写入的产物与结论：原型 A 与渲染层同尺寸截图、机器可读的样式/文案事实、真实浏览器内的键盘路径验证，以及四道检查的真实输出。命令均在仓库根 `/Users/adber/workspace/github/PiDock` 执行，Node 经 PATH 固定为 24.21.0（`/private/tmp/pidock-pnpm/node_modules/.bin` + nvm v24.21.0）。

- 实现基线（S1 提交）：`2f43f81 feat(renderer): align app shell and navigation with prototype A (#25)`
- 本轮修复提交：本目录所在提交（`git log -1 --format=%H -- docs/evidence/ui-alignment-s1/verification-log.md`），父提交为 `2f43f81`
- 截图环境：1600×1000 视口、`deviceScaleFactor: 2`（即 3200×2000 像素）、headless Chromium（`~/Library/Caches/ms-playwright/chromium-1243`，Chrome for Testing）、`playwright-core`（`packages/renderer/node_modules`）
- 被截图的两个真实服务：原型 `http://127.0.0.1:4319/?variant=A`、渲染层 Vite dev `http://127.0.0.1:4335`

## 1. 产物清单

| 文件 | 内容 |
| --- | --- |
| `prototype/prototype-A.png` | 原型 A 全屏（1600×1000 @2x） |
| `renderer/shell-attention.png` | 渲染层 `/attention`（需要处理） |
| `renderer/shell-task.png` | 渲染层 `/projects/atlas/tasks/release?session=main` |
| `renderer/shell-env.png` | 渲染层 `/env`（环境与服务） |
| `shell-facts.json` | 四页面的侧栏/面包屑/底栏文本、三个 `data-nav-group` 段、`switcherPresent`、页面报错 |
| `shell-verification.json` | 原型与渲染层的计算样式、运行中圆点光环、任务卡内按钮数、键盘路径结果 |
| `capture-shell-shots.mjs` | 生成截图的脚本（可重跑） |
| `verify-shell-facts.mjs` | 生成本目录两份 JSON 的脚本（可重跑） |

两个脚本都要求上述两个服务在 4319/4335 运行；脚本内绝对路径指向本机 `playwright-core` 与 Chromium 缓存，换机器需改路径。

## 2. 机器可读事实（`shell-verification.json`）

### 2.1 底栏（要点 5：底栏配色以原型为准）

原型 `.switcher` 与渲染层 `[data-testid="shell-summary"]` 的浏览器实际取值：

```text
prototype .switcher : background rgb(41,49,66)  border rgb(59,70,92)  color rgb(236,238,243)
                      radius 10px  padding 6px 10px  gap 8px  font 10px  bottom 10px
prototype .state    : color rgb(181,191,212)
renderer  summary   : background rgb(41,49,66)  border rgb(59,70,92)  color rgb(181,191,212)
                      radius 10px  padding 6px 10px  font 10px  bottom 10px
                      shadow rgba(21,26,37,0.133) 0 4px 15px 0
```

结论：除原型分隔用的 1px `.sep`（本产品底栏不是布局切换器）外，颜色/圆角/内边距/阴影/字号/位置全部与原型**实际生效值**一致。原型文件里 `#262d3e/#384157/#eceef3/#adb4c4` 是 `style.css` 首段的基础规则，同文件后段的评审修订块（`.switcher{background:#293142;border-color:#3b465c}`、`.switcher .state{color:#b5bfd4}`，同优先级、后者生效）已覆盖它们。评审 P2 的该项比对的是被覆盖的旧值，因此**本轮不改配色**（改回旧值反而会引入偏差）。

### 2.2 运行中任务卡圆点（要点 1）

```text
class    : h-1.5 w-1.5 shrink-0 rounded-full bg-[#425a93] shadow-[0_0_0_3px_#425a9312]
computed : background rgb(66,90,147)  box-shadow rgba(66,90,147,0.07) 0 0 0 3px  size 6×6
```

原型 `.dot.live{background:#425a93;box-shadow:0 0 0 3px #425a9312}`。非运行任务仍为 `bg-[#9aa4ab]`（原型 `.dot`）。

### 2.3 侧栏文案单一来源（要点 2）

三个 `data-nav-group` 段在三条路由上取值一致：

```text
workspace : 项目总览 / 环境与服务 / Token 用量
tasks     : (新建任务 +) / 普通发布前检查 … / 已归档
system    : 需要处理 3 / 定时任务 / 能力管理 / 远程访问 / 本机设置 / 模型与 Provider
```

渲染层 DOM 中不再出现硬编码的十个路由文案：`ShellSidebar.tsx` 的导航项只带 `route`，文案取自 `stores/navigation.ts` 的 `ROUTE_LABELS`（`grep` 结果 0 处硬编码）。`shell-facts.json` 的 `switcherPresent` 在三个渲染层页面均为 `false`，在原型 A 为 `true`（A/B/C 布局切换器只属于原型）。任务卡内按钮数 `[0,0,0]`：列表里没有 `⋯` 按钮。

### 2.4 键盘路径（要点 3，真实浏览器）

先把焦点给任务卡（`document.activeElement.dataset.taskNav === "release"`），再按键：

```text
ContextMenu : [role="dialog"][aria-label="重命名任务"] 出现
              “重命名任务 | 关闭 | 名称 | 重命名不影响任务工作区目录、分支与工作副本。 | 保存”
Shift+F10   : 未产生 contextmenu 事件，未打开对话框
F10         : 未产生 contextmenu 事件
```

结论：Chromium 把 ContextMenu 键合成到聚焦元素上的 `contextmenu` 事件，真实浏览器里能打开重命名对话框；headless Chromium 不合成 Shift+F10（记为未验证，见 §5）。单元测试 `shellNavigation.test.tsx > opens the task rename from the keyboard and keeps the card free of a ⋯ button` 走的就是这条事件路径（jsdom 没有键→事件映射，user-event 14 的 `contextmenu` 只由指针右键派发）。

## 3. 四道检查（`--force`）

```text
$ pnpm turbo run typecheck test build lint --force
 Tasks:    8 successful, 8 total
 Cached:    0 cached, 8 total
 Time:    10.10s
 exit=0

@pidock/shell:test:    Test Files  54 passed (54)
@pidock/shell:test:         Tests  801 passed (801)
@pidock/renderer:test: Test Files  44 passed (44)
@pidock/renderer:test:       Tests  378 passed (378)
```

渲染层 `test` 输出内 `not wrapped in act` 计数为 `0`（修复前一轮为 377，见 §4）。渲染层用例数从 377 增至 378，增量是本轮新增的键盘路径用例；既有断言未删改。

## 4. 逐项结论

| 要点 | 结论 | 证据 |
| --- | --- | --- |
| 1 运行中圆点缺光环 | COVERED | §2.2，`ShellSidebar.tsx` 圆点类名 |
| 2 导航文案重复硬编码 | COVERED | §2.3，`ShellSidebar.tsx` 取 `ROUTE_LABELS`，0 处硬编码 |
| 3 右键无键盘路径测试 | COVERED（单元 + 真实浏览器 ContextMenu 键） | §2.4，`shellNavigation.test.tsx` 新用例 |
| 4 新增外壳组件触发 act 警告 | COVERED | `providersFlow`/`managementFlows`/`attentionFlow`/`sessionCoordinationFlow`/`composerFlow` 直接改 store 与二次 `renderApp` 的写法包进 `act`/`actStore`；计数 377→0 |
| 5 底栏配色与原型不一致 | NOT APPLICABLE（原型实际生效值已一致） | §2.1，比对 `style.css` 首段与后段修订块 |
| 6 证据落盘到仓库 | COVERED | 本目录 |

## 5. 未完成 / 未验证（不得当作已完成）

- `Shift+F10` 在 headless Chromium 中不合成 `contextmenu`，未在本环境验证；ContextMenu 键已验证。
- 品牌标记形状（原型 A 为实心圆角方块 + 白色 π，当前为圆形 paper + 蓝色 π）未改，`scripts/verify-brand.mjs` 仍断言圆形；属待决事项。
- 侧栏用户 chip 仍显示 `本机工作区`（原型显示真实用户名如 `Leonz3n`）；`LocalSettings` 无该字段，未新增数据来源。
- Host 侧 `task-lifecycle.ts:565` 的「归档与清理」文案不在渲染层范围，未改。
- 未做逐像素比对（本目录只有同尺寸截图与计算样式事实，没有 diff 图或像素差阈值）。
- 渲染层证据截图来自 Vite dev 服务（内存 Host 投影，页面右上角「内存模拟数据 · 未连接 Host」），不是打包后的 Electron 运行；打包运行、真实 Host 数据属另行验收。
