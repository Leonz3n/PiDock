# [PiDock 02d] (#37) Desktop 任务页导航与视图几何 — 真实 Electron 证据

本目录是 **真实 Electron 窗口级截图**（生产运行时接线 + 已构建 React renderer，非 Vite/Playwright、
非夹具页），记录 #37 的页面选择与视图几何契约：无任务页时的全宽 shell、真实任务页打开/激活、
多任务页面选择规则、关闭最后一页回到全宽、以及 1440×900 ↔ 720×560 的真实 resize。

- 脚本：`packages/shell/scripts/electron-issue37-task-page-layout-capture.mjs`
- PNG：`1440x900-*.png` / `720x560-*.png`（16 张，见 §5）
- 元数据：`capture-log.json`（命令、源码版本、每张 PNG 的 sha256 / 像素尺寸 / deviceScaleFactor /
  每个状态的 **视图 bounds/可见性/当前任务/页面 URL** / 捕获时的 `document.body.innerText`）

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
`location.href` 不匹配生产 renderer 即抛错退出（fail closed）。

**截图是真实的窗口级捕获。** `BrowserWindow.capturePage()` 只能捕获从未加载过的 base webContents
（实测返回 0×0），CDP `Page.captureScreenshot` 一次只能截一个 `WebContentsView`；只有
`desktopCapturer.getSources({types:["window"]})` 的窗口源会把 shell 与任务页视图按用户所见合成。
脚本按 `window.getMediaSourceId()` 精确匹配本窗口源，`thumbnailSize` 设为窗口尺寸的 2×，因此
`deviceScaleFactor≈2`。窗口位置固定在屏幕左上区域。

## 2. 与生产接线的差异（唯一省略项）

- 数据源：真实 `TaskRootIndex`（隔离默认任务根）+ 真实 `ProjectRegistry`（隔离 `userData` 的
  `projects.json`）+ `PerTaskHostRegistry`（fork 真实 Host）。
- 与 `main.ts:130-180` 一致地接线了 `ProjectTaskCreation`/`ProviderWiring`，所以渲染层不会绘制
  `真实任务创建尚未接入` 的失败态。
- **唯一省略的生产依赖是服务配方目录**（`ServiceCatalog`）：`registerIpc` 未传入它，因此
  `tasks.configureServices` 的 Host 服务归属围栏不生效。本目录四个状态的可见内容不依赖它
  （浏览器面板只走 `task/browserAction`），省略它可让 Host 在 `quitAll` 时不会因服务归属校验失败
  而违反 `PerTaskHostRegistry.quitAll/disposeAll` 封口契约。与 `#41` harness 相同的取舍。

## 3. 配置披露：`PIDOCK_TASK_BROWSER_ORIGINS`（重要）

生产环境下打开真实任务页是 **fail-closed** 的：每个任务有自己的前端来源白名单，未配置时
`page/open` 会被 `browser-gateway` 拒绝，不会创建任何页面视图。配置机制就是文档化的环境变量
`PIDOCK_TASK_BROWSER_ORIGINS`（JSON `taskId -> origins`，见 `docs/task-graph.md:133`）。

本 harness **设置了该变量**，值记录在 `capture-log.json.configuration.value`：

```json
{ "task-aaaa1111": ["http://127.0.0.1:45137"], "task-bbbb2222": ["http://127.0.0.1:45137"] }
```

其中 `http://127.0.0.1:45137` 是本 harness 自己启动的 **本机 loopback 页面服务器**（`/a`、`/b`
两个真实 HTML 页面）。这是**受支持的 operator 配置**，不是测试后门：不设置它，生产就只会拒绝
`page/open`，本目录一张页面截图都不可能有。脚本通过生产解析器 `taskBrowserOriginsFromEnv`
读回同一个变量，保证走的就是上线路径。固定端口（而非临时端口）是让页面 URL 在截图里稳定、
从而 PNG 可逐字节复现。

## 4. seeded vs. driven（重要披露）

脚本 **seeded**（真实 API / 真实序列化器写盘，非手写假 JSON）：

| 内容 | 方式 |
| --- | --- |
| 三个真实任务记录 | 生产 `task-store` 序列化器 + `git init`，写在隔离默认任务根 |
| Project「Adder」+ 仓库 `invoice-service` | `ProjectRegistry.create` |
| 任务 A / B 归属 Adder | `ProjectRegistry.claim` |
| 任务 C 明确未归属 | 无 membership |
| `/a`、`/b` 两个 loopback 页面 | 本 harness 的 `node:http` 服务器，真实 GET 加载 |

脚本 **driven**（真实生产路径）：

- `pageOpenTaskA`：**真实 Desktop「浏览器」工具面板**：填 `任务页面地址` + 点 `打开任务页面`，
  走渲染层 → preload → `shell/taskOp` → `task/browserAction` → Host → main gateway 全链路
  （见 `1440x900-browser-tool-open.png`：成功提示 `主进程窗口已打开 http://127.0.0.1:45137/a`
  与页面句柄 `page-1 · webContents 4`）。
- `pageOpenTaskB`、两次 `page/close`：通过 main 的 `browser-gateway`（human actor）驱动。
  **原因**：任务页打开后 shell 只占 380/280px、页面覆盖其余窗口，当前 Desktop 没有「在一页可见时
  切换任务并打开第二页」的入口，也**没有关闭页面控件**（`browser-pages` 未接线）。因此第二页打开
  与关闭由 main 拥有并校验的同一 gateway 发起；这是真实的生产接缝（Host 的 `task/browserAction`
  就是打到这个函数），但不是模拟鼠标点击。

**没有使用任何 Vite/Playwright/夹具 renderer，也没有把静态状态伪装成交互。**

## 5. 每个状态记录了哪些证据

`capture-log.json.shots[]` 每项含 `geometry`：

- `shellBounds`/`shellVisible`：shell `WebContentsView` 的真实 bounds 与可见性
- `pageTaskId`/`pageUrl`/`pageBounds`/`pageVisible`：当前**选中的**任务浏览器活动页
- `shellHorizontalOverflow`：shell 内 `documentElement` 的水平溢出（记录值，非断言；全部为 0）
- `bodyText`：捕获时 shell 的可见文本

状态与 PNG：

| 状态 | 1440×900 | 720×560 | 说明 |
| --- | --- | --- | --- |
| `no-page-selected`（基线，含 resize↔回） | ✅ | ✅ | 无任务页，shell 全宽（bounds 宽 = 窗口内容宽），无占位视图、无 demo Project/Task |
| `browser-tool-open` | ✅ | — | 浏览器面板真实打开任务页 A 的成功状态（UI 入口证据） |
| `task-page-open`（含 resize→1440 回） | ✅ | ✅ | 任务页 A + shell 同时可见；1440 下 shell=380 / page=1060，720 下 shell=280 / page=440 |
| `multi-task-page-b-selected` | ✅ | ✅ | 打开任务 B 页后，B 成为可见页（A 页仍打开但不显示）→ 多任务选择规则 |
| `multi-task-page-a-restored` | ✅ | ✅ | 关闭 B 页后回落到 A 页（shell 仍非全宽）→ 选择规则的第二半 |
| `last-page-closed` | ✅ | ✅ | 关闭最后一页后 shell 恢复全宽、无活动页 |

`task-page-open`（1440）与 `multi-task-page-a-restored`（1440）PNG sha256 相同：两者都是「A 页可见、
shell 380px」的同一真实状态，属预期。所有 PNG 用本 harness 连跑两次、逐字节比对一致后才提交。

## 6. 本证据**未**覆盖（UNTESTED）

- **真实人手鼠标/键盘**：脚本用程序化 DOM click（工具面板）与 main gateway（开第二页/关闭）；
  没有可信驱动去产生物理点击事件。
- **真实用户任务页**：用的是本机 loopback 上由 harness 提供的页面（operator 用
  `PIDOCK_TASK_BROWSER_ORIGINS` 配置的来源），不是用户真实业务前端；真实业务页面/远程来源未测。
- **导航失败/刷新恢复的 GUI 呈现**（`#37` box 2 的另一半）：由既有聚焦测试覆盖，**不在**本目录。
- **窗口标题栏**：截图含真实 macOS 窗口标题栏，其标题为 `Electron`（生产窗口的 base webContents
  从不加载，故沿用默认标题）；这是生产同样的行为，不是 harness 伪造。
- **SDK 会话状态**：驱动 resize/开页后 shell 出现 `sdk-sender-navigated / 重新连接`（会话订阅被撤销），
  与视图几何契约无关，未在本目录验收。
- Windows / Linux、原生 picker、凭据、真实 Host/RPC outage。
- `#24` 原型 A 的同尺寸整体视觉对照仍需用户提供。
