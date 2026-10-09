# [PiDock 02d] (#37) Desktop 任务页导航与视图几何 — 真实 Electron 证据

本目录是 **真实 Electron 窗口级截图**（生产运行时接线 + 已构建 React renderer，非 Vite/Playwright、
非夹具页），记录 #37 的页面选择与视图几何契约：无任务页时的全宽 shell、真实任务页打开/激活、
多任务页面选择规则、关闭最后一页回到全宽 shell，以及 1440×900 ↔ 1000×700 ↔ 720×560 的真实 resize。

- 脚本：`packages/shell/scripts/electron-issue37-task-page-layout-capture.mjs`（其 sha256 记录在
  `capture-log.json.generatedBySha256`，可与提交的脚本逐字节核对）
- PNG：**12 张**，每个（状态,尺寸）组合一张：`1440x900-*` 6 张、`1000x700-*` 1 张、`720x560-*` 5 张（见 §5）
- 元数据：`capture-log.json`（命令、源码版本、harness sha256、每张 PNG 的 sha256 / 像素尺寸 /
  deviceScaleFactor / 窗口 bounds / 裁剪偏移 / 每个状态的 **视图 bounds/可见性/当前任务/页面 URL** /
  **shell 列内部几何 `shellColumn`**（可失败的断言，见 §5）/ 捕获时 `document.body.innerText`，
  以及无截图的流程断言 `checks[]`）
- 复现确定性：`determinism-replay.json`（同一 harness 连续两次运行、逐文件 sha256 相同）

## 0. #49：shell 窄列的控件重叠与「空洞指标」修复（本目录已刷新）

#49 修复了本目录暴露的两个问题，所以 `1440x900` / `1000x700` / `720x560` 三档的**任务页打开态**
PNG 已重采（`no-page-selected` / `last-page-closed` 两态未变，sha256 与旧提交相同）：

- **控件重叠**：任务页打开时 shell 列只有 280–380px（`desktop-layout.ts:15`），而 Desktop 任务头
  持有一个固定约 288px 的 `shrink-0` 图标工具条，把 `flex-1` 标题挤到 0 宽：`Task workspace`
  被图标盖住、面包屑 `工作区` 逐字换行、列内出现横向滚动条。修复让表头行与工具条按原型在
  ≤1180px 换行（`prototypes/pidock-ui/style.css` `.taskheader .between/.actionset{flex-wrap:wrap}`，
  与 `TaskPage.TaskHeader` 同一约定），并让面包屑的字面片段 `shrink-0 whitespace-nowrap`、
  只有项目/任务名 `min-w-0 truncate`。
- **空洞指标**：旧 `shellHorizontalOverflow` 用 `documentElement.scrollWidth - clientWidth`，对每张图
  都是 0（真正的溢出在嵌套滚动容器里），**永远不会失败**。现在每张有任务工作区的截图都要通过
  `shellColumn` 断言：列自身的 `scrollWidth`/`clientWidth`、工具条包围盒与 `Task workspace` 眉标题
  文本框（Range 盒）**不相交**、工具条不越出列。该断言在旧布局上会失败（见 §5 末）。

## 1. 运行方式与截图来源

```bash
# 先构建（renderer build → copy-static → tsc）
pnpm --filter @pidock/shell build
# 再运行（脚本自身先清除 PIDOCK_RENDERER_URL / PIDOCK_TASK_URL，并断言加载的确为生产 file:// renderer）
packages/shell/node_modules/.bin/electron \
  packages/shell/scripts/electron-issue37-task-page-layout-capture.mjs \
  --out docs/evidence/desktop-task-page
```

`pnpm --filter @pidock/shell exec electron scripts/electron-issue37-task-page-layout-capture.mjs \
--out docs/evidence/desktop-task-page` 是等价调用；本环境里 pnpm 的 pre-run 依赖检查会重写
`pnpm-workspace.yaml`（tracked 文件），为不在证据里留下脏 tracked 文件，改用包内 electron 可执行文件
**直接调用**（`capture-log.json.command` 记录的就是实际命令）。

启动路径与生产一致：脚本从已编译的 `packages/shell/dist/main/*.js` 直接导入运行时模块，用
`createTrustedWindow("issue37","production")` + 真实 `createTaskBrowserCapability`（带 `DesktopLayout`）
+ 真实 `PerTaskHostRegistry`（`utilityProcess` fork `dist/host/host-entry.js`）接 `registerIpc`，
再 `loadTrustedViews` → 生产 `file://…/renderer/index.html`（无 fixture entry、无 Vite、无 dev override）。
`location.href` 不匹配生产 renderer 即抛错退出（fail closed），该 URL 记录在
`capture-log.json.capture.shellEntryUrl`。

**截图是真实的窗口级捕获，并裁剪到窗口内容盒。**

- `BrowserWindow.capturePage()` 只能捕获从未加载过的 base webContents（实测返回 0×0），
  CDP `Page.captureScreenshot` 一次只能截一个 `WebContentsView`；只有
  `desktopCapturer.getSources({types:["window"]})` 的窗口源会把 shell 与任务页视图按用户所见合成。
  脚本按 `window.getMediaSourceId()` **精确匹配**本窗口源（没有名称兜底：匹配不到就抛错，绝不截别的窗口），
  匹配到的源名记录在 `capture-log.json.capture.sourceName`。
- `thumbnailSize` 设为窗口 bounds × **本机显示器 scale factor**
  （`capture-log.json.capture.displayScaleFactor`；本机为 1），因此位图是设备像素，不是放大产物；
  2× 显示器上会得到 2× 位图，`deviceScaleFactor` 随之记录为 2。
- 窗口源包含真实 macOS 标题栏（本机 32pt），而标题栏不是应用内容：脚本把位图**裁剪到
  `getContentBounds()`**。所以每张 PNG 文件名里的 `<width>x<height>` 就是这张图自己的逻辑盒
  （= `setContentSize` 断言过的 CSS 内容盒），并且
  `pixelWidth === width × deviceScaleFactor`、`pixelHeight === height × deviceScaleFactor`
  （本机 12 张全部满足：1440×900 / 1000×700 / 720×560 px，`deviceScaleFactor = 1`）。
  `windowBounds`（含标题栏的整窗逻辑尺寸）与 `frameOffset` 仍逐张记录，任何读者都能自行换算。
- 裁剪偏移不是假设出来的：`shots[].pageTopEdgePixels` 记录“页区域内首个呈现页面底色的像素行”，
  它必须等于 `cropOffsetPixels.y`（本机 12 张中 8 张有可见页面的记录均为 32），否则脚本抛错、
  不写任何文件。没有可见页面的 4 张与它们共用同一个窗口/标题栏几何。
- **每个（状态,尺寸）组合只捕获一次。** 场景回到既有状态时（例如 resize 回到 1440×900、
  关闭 B 后回到 A 的页面），脚本改用**断言并记录在 `checks[]`**，不再提交外观相同的图片。
  写 `capture-log.json` 之前脚本会校验：shots 与 `--out` 下的 PNG 一一对应（文件名不重复）、
  12 张图两两 sha256 不同、目录里没有本次未写出的遗留 PNG；任一条不满足即以非零退出，
  不会留下一个“看起来更大/更全”的假证据目录。

## 2. 与生产接线的差异（唯一省略项）

- 数据源：真实 `TaskRootIndex`（隔离默认任务根）+ 真实 `ProjectRegistry`（隔离 `userData` 的
  `projects.json`）+ `PerTaskHostRegistry`（fork 真实 Host）。
- 与 `main.ts:130-180` 一致地接线了 `ProjectTaskCreation`/`ProviderWiring`，所以渲染层不会绘制
  `真实任务创建尚未接入` 的失败态。
- **唯一省略的生产依赖是服务配方目录**（`ServiceCatalog`）：`registerIpc` 未传入它，因此
  `tasks.configureServices` 的 Host 服务归属围栏不生效。本目录各状态的可见内容不依赖它
  （浏览器面板只走 `task/browserAction`），省略它可让 Host 在 `quitAll` 时不会因服务归属校验失败
  而违反 `PerTaskHostRegistry.quitAll/disposeAll` 封口契约。与 `#41` harness 相同的取舍。

## 3. 配置披露：`PIDOCK_TASK_BROWSER_ORIGINS`（重要）

生产环境下打开真实任务页是 **fail-closed** 的：每个任务有自己的前端来源白名单，未配置时
`page/open` 会被 `browser-gateway` 拒绝，不会创建任何页面视图。配置机制就是文档化的环境变量
`PIDOCK_TASK_BROWSER_ORIGINS`（JSON `taskId -> origins`，见 `docs/task-graph.md:133`）。

本 harness **设置了该变量**，值记录在 `capture-log.json.capture.configuration.value`：

```json
{ "task-aaaa1111": ["http://127.0.0.1:45137"], "task-bbbb2222": ["http://127.0.0.1:45137"] }
```

其中 `http://127.0.0.1:45137` 是本 harness 自己启动的 **本机 loopback 页面服务器**（`/a`、`/a2`、`/b`
三个真实 HTML 页面，`/a2` 与 `/a` 同源）。这是**受支持的 operator 配置**，不是测试后门：不设置它，
生产就只会拒绝 `page/open`，本目录一张页面截图都不可能有。脚本通过生产解析器
`taskBrowserOriginsFromEnv` 读回同一个变量，保证走的就是上线路径。固定端口（而非临时端口）
是让页面 URL 在截图里稳定、从而 PNG 可逐字节复现。

## 4. seeded vs. driven（重要披露）

脚本 **seeded**（真实 API / 真实序列化器写盘，非手写假 JSON）：

| 内容 | 方式 |
| --- | --- |
| 三个真实任务记录 | 生产 `task-store` 序列化器 + `git init`，写在隔离默认任务根 |
| Project「Adder」+ 仓库 `invoice-service` | `ProjectRegistry.create` |
| 任务 A / B 归属 Adder | `ProjectRegistry.claim` |
| 任务 C 明确未归属 | 无 membership |
| `/a`、`/a2`、`/b` 三个 loopback 页面 | 本 harness 的 `node:http` 服务器，真实 GET 加载 |

脚本 **driven**（真实生产路径）：

- `pageOpenTaskA`：**真实 Desktop「浏览器」工具面板**：填 `任务页面地址` + 点 `打开任务页面`，
  走渲染层 → preload → `shell/taskOp` → `task/browserAction` → Host → main gateway 全链路
  （见 `1440x900-browser-tool-open.png`：成功提示 `主进程窗口已打开 http://127.0.0.1:45137/a`
  与页面句柄 `page-1 · webContents 4`）。
- `pageOpenTaskB`、`pageNavigateTaskA`、两次 `page/close`：通过 main 的 `browser-gateway`（human actor）驱动。
  **原因**：任务页打开后 shell 只占 380/280px、页面覆盖其余窗口，当前 Desktop 没有「在一页可见时
  切换任务并打开第二页」的入口，也**没有关闭页面控件**（`browser-pages` 未接线）。第二页打开、
  对已打开页面的导航与关闭都由 main 拥有并校验的同一 gateway 发起；这是真实的生产接缝
  （Host 的 `task/browserAction` 就是打到这个函数），但不是模拟鼠标点击。
  `pageNavigateTaskA` 只导航到该任务白名单内的同源地址（`/a2`）。

**没有使用任何 Vite/Playwright/夹具 renderer，也没有把静态状态伪装成交互。**

## 5. 每个状态与每张 PNG

`capture-log.json.shots[]` 每项含：

- `width`/`height`：CSS 内容盒尺寸（= `setContentSize` 断言过的尺寸 = 文件名里的 `<width>x<height>`）
- `pixelWidth`/`pixelHeight`/`deviceScaleFactor`：位图真实像素尺寸与缩放（本机 `deviceScaleFactor = 1`）
- `windowBounds`/`frameOffset`/`cropOffsetPixels`/`pageTopEdgePixels`：整窗 bounds、标题栏偏移、
  裁剪偏移与其页顶边校验值
- `geometry.shellBounds`/`shellVisible`：shell `WebContentsView` 的真实 bounds 与可见性
- `geometry.pageTaskId`/`pageUrl`/`pageBounds`/`pageVisible`：当前**选中的**任务浏览器活动页
- `shellColumn`：每张有任务工作区的截图都会**断言**的 shell 列内部几何：`content.{scrollWidth,
  clientWidth}`（列自身的 `overflow-y-auto` 主区）、`breadcrumb.{scrollWidth, clientWidth}`、
  `toolbar` / `eyebrow` 包围盒（眉标题用 `Range` 取实际文本盒，因为被挤到 0 宽的 `flex-1` 容器
  本身量不出溢出的文字）、`toolbarOverlapsEyebrow`、`toolbarInsideColumn`、`documentOverflow`。
  任一项不满足即抛错、不写 PNG（见 §0 与 §5 末）
- `bodyText`：捕获时 shell 的可见文本

| 状态 | PNG | 实测画面（`geometry` 摘要） | sha256 |
| --- | --- | --- | --- |
| `no-page-selected`（基线） | `1440x900-no-page-selected.png` | shell 全宽 1440，无页（`pageTaskId: null`），主内容为真实 `PROJECT Adder`（2 个进行中任务、1 个仓库），无占位视图、无 demo Project/Task | `7cc1c877…893f6e` |
| 同上（最小档） | `720x560-no-page-selected.png` | shell 全宽 720，主内容同为 `PROJECT Adder` | `51837957…67d0c9` |
| `browser-tool-open` | `1440x900-browser-tool-open.png` | 真实 Desktop「浏览器」面板打开任务页 A：面板显示 `主进程窗口已打开 http://127.0.0.1:45137/a` 与页面句柄；shell 380 / page 1060，活动页 A（`/a`） | `b71db418…f261e5` |
| `task-page-open` | `1440x900-task-page-open.png` | 面板关闭后 shell 380 / page 1060，A 页可见（深蓝 `真实任务页 · A`）；`Task workspace` 标题与工具条上下分列、不重叠（#49） | `ce205ae9…9fe5d8` |
| `task-page-open-resized` | `1000x700-task-page-open-resized.png` | resize 到 1000×700：shell **360** / page **640**——360 是 `floor(1000*0.36)`，落在 280–380 之间，既不是 1440 的 clamp 380 也不是 720 的 clamp 280，证明视图按窗口跟随而不是只在两端取值 | `8948344a…44a0de` |
| `task-page-open`（最小档） | `720x560-task-page-open.png` | resize 到生产最小尺寸 720×560：shell 280 / page 440，tile 满窗、无零宽、无重叠；`shellColumn` 断言工具条在列内、不压眉标题、列内无横向溢出（#49） | `017ef728…2b6a88` |
| `multi-task-page-b-selected` | `1440x900-multi-task-page-b-selected.png` | 打开任务 B 的页面后 **B 成为可见页**（橙色 `真实任务页 · B`，`pageTaskId task-bbbb2222`、`/b`），A 页仍打开但不显示；shell 380 / page 1060 | `9345a327…372fe6` |
| 同上（最小档） | `720x560-multi-task-page-b-selected.png` | 同状态 720×560，shell 280 / page 440 | `181bd328…55abbd` |
| `multi-task-page-a-restored` | `1440x900-multi-task-page-a-restored.png` | 关闭 B 后**恢复到 A 的活页面**：目标页是 A（`pageTaskId task-aaaa1111`），URL 是 A 在后台保持打开期间导航到的 `/a2`（绿色 `真实任务页 · A · 已导航`）；shell 380 / page 1060 | `41252916…1999d3` |
| 同上（最小档） | `720x560-multi-task-page-a-restored.png` | 同状态 720×560，shell 280 / page 440 | `9c72c3e2…790f27` |
| `last-page-closed` | `1440x900-last-page-closed.png` | 关闭**最后一页**后 shell 回到全宽 1440，`pageTaskId/pageUrl/pageBounds/pageVisible` 全为 `null`（页面确实消失）；主内容仍是**已选中任务的 workspace**（`TASK WORKSPACE · 对账单详情·任务A`），不是项目列表 | `5bf2cc8e…0d329c` |
| 同上（最小档） | `720x560-last-page-closed.png` | 同状态 720×560，shell 全宽 720 | `c3ded828…b71606` |

12 张 PNG 的 sha256 **两两不同**（脚本强制校验），也就是说每张图都对应一个别的图没有的
应用状态：`task-page-open` 与 `multi-task-page-a-restored` 不再是同一张图（后者是 A 页在
被 B 遮住期间导航到 `/a2` 之后恢复可见的状态），`task-page-open-resized` 也不再等于
`task-page-open`（它是 1000×700 的第三档几何）。同一状态的两档尺寸之间、以及
`no-page-selected` / `last-page-closed` 之间也各不相同。

**#49 `shellColumn` 断言在旧布局上确实会失败。** 在只加 `data-testid`、未加换行的 renderer 上
（像素与修复前逐字节相同）运行本 harness，第一个任务工作区截图即失败：

```
ISSUE37_CAPTURE_FAILED browser-tool-open 1440x900 Error: task toolbar intersects the Task workspace heading at 1440x900 (browser-tool-open)
```

修复后同一断言在 1440×900 / 1000×700 / 720×560 三档全部通过。`shellColumn` 的原始值随每张图
记录在 `capture-log.json.shots[].shellColumn`（例如 720×560 任务页打开态：
`toolbarOverlapsEyebrow:false`、`toolbarInsideColumn:true`、
`content.scrollWidth === content.clientWidth`）。

`capture-log.json.checks[]` 记录**没有截图、只做断言**的流程回程：

- `no-page-selected resize return 720x560 -> 1440x900`：回到 1440 后 shell 恢复全宽、仍无活动页
- `task-page-open resize round trip 1440x900 -> 1000x700 -> 720x560 -> 1440x900`：回到 1440 后的
  完整 `geometry` 与 resize 前逐字段相同（shell 380 / page 1060 / A 页 `/a`），即 resize 无漂移
- `task A stayed open and kept its /a2 navigation while task B was selected`：B 可见期间 A 的页面
  仍然存活并保持在 `/a2`（`pageTaskId` 仍是 B，说明这次导航没有抢走可见页）

## 6. 本证据**未**覆盖（UNTESTED）

- **真实人手鼠标/键盘**：脚本用程序化 DOM click（工具面板）与 main gateway（开第二页/后台导航/关闭）；
  没有可信驱动去产生物理点击事件。
- **真实用户任务页**：用的是本机 loopback 上由 harness 提供的页面（operator 用
  `PIDOCK_TASK_BROWSER_ORIGINS` 配置的来源），不是用户真实业务前端；真实业务页面/远程来源未测。
- **导航失败/刷新恢复的 GUI 呈现**（`#37` box 2 的另一半）：由既有聚焦测试覆盖，**不在**本目录。
- **shell 列内部的「不可触达控件」**（`#37` box 3 的后半句）：#49 起，本目录对**列内部**也有可失败
  断言：每张有任务工作区的截图都记录并断言 `shellColumn`（工具条 vs `Task workspace` 眉标题的包围盒
  不相交、工具条不越出列、列内无横向溢出）。旧布局会触发
  `task toolbar intersects the Task workspace heading ...` 并使脚本非零退出，因此 box 3 的「最小窗口
  尺寸下没有重叠控件」在本目录覆盖的 1440×900 / 1000×700 / 720×560 三档**已验收**；其它尺寸、
  真实人手输入与真实业务页面仍未测（见上两条）。
  旧 `documentElement.scrollWidth - clientWidth` 指标始终为 0，已删除（见 §0）。
- **SDK 会话状态**：驱动 resize/开页后 shell 出现 `sdk-sender-navigated / 重新连接`（会话订阅被撤销），
  与视图几何契约无关，未在本目录验收。
- Windows / Linux、原生 picker、凭据、真实 Host/RPC outage。
- `#24` 原型 A 的同尺寸整体视觉对照仍需用户提供。

## 7. 复现与确定性

`determinism-replay.json` 记录同一 harness 版本的连续两次运行的逐文件 sha256：两次运行 12 张 PNG
**逐字节相同**（`note` 说明两次运行分别发生在 harness 变更提交前/后，但 harness 字节相同）。
校验方式：`shasum -a 256 docs/evidence/desktop-task-page/*.png` 与 `capture-log.json.shots[].sha256`
逐条比对；`capture-log.json` 自身不是逐字节稳定的（它记录 `revision`/`trackedFilesDirty`），
本目录**只**声称 PNG 可复现。

## 8. 为什么这里的 PNG 是 1440×900 而不是 2880×1864

上一版证据提交的是含 macOS 标题栏、且被放大到 2× 的整窗位图（文件名 `1440x900-*`，实际位图
2880×1864，`pixelHeight` 与 `height × deviceScaleFactor` 不一致）。现在：捕获仍走窗口源，
但位图**裁剪到窗口内容盒**（去掉 32pt 标题栏、即非应用内容），并按**显示器真实 scale factor**
请求缩略图（本机 1×），于是文件名、`width`/`height`、`pixelWidth`/`pixelHeight` 与
`deviceScaleFactor` 四者自洽（`pixel = width × deviceScaleFactor`）。`windowBounds`/`frameOffset`
仍逐张记录，因此需要与其它 bundle（例如 `#34` 的 2880×1800）按像素比较时仍可换算。
