# Electrobun 替代 Electron 与未来内置浏览器评估

调研日期：**2026-11-06（环境 UTC 日期）**。范围：官方文档、源码、release 与 PiDock 当前实现的只读核对；不实施迁移、不新增 ADR、不创建工单、不运行桌面 PoC。本文是选型研究，不改变首版范围或既有技术决策。

## 结论与名称确认

用户写的 `electronbun`，结合 Electron 替代与本仓库既有研究，本文按 **Electrobun（blackboardsh/electrobun）** 理解；这是推定的拼写纠正，未发现本次需求指向另一个叫 electronbun 的框架。Electrobun 官方默认主运行时为 Bun，另有实验性 Cottontail，并由 Hutch 构建打包。[E1]

**建议 PiDock 继续使用 Electron；目前不适合把 Electrobun 作为可直接替换的生产主线。** Electrobun 确实能承载独立的真实网页视图，也有 CEF、持久分区、导航和下载事件，不能简单断言“做不了内置浏览器”。但未来若要达到 T3 Code / Codex 的共享可见页面、登录、多标签、下载、权限及 Agent 同页控制，PiDock 要依赖的是一套浏览器宿主与安全边界，迁移对象远超过窗口壳。[E2–E5][T1–T4][O1–O2][L1–L5]

当前有三个实质性门槛：

1. **CEF 的操作系统沙箱问题。** Electrobun v2.0.6 三平台源码均设置 `CefSettings.no_sandbox = true`；Linux 还添加 `no-sandbox` 参数。其 `sandbox:true` 的官方含义主要是禁用应用 RPC，仍保留事件桥。它不能直接替代 PiDock 的 Electron renderer sandbox 安全承诺。对需要登录并浏览任意不可信站点的产品，应先解决、核验此项，再讨论替换。[E3][E6][E7][N1]
2. **已有 macOS CEF 生命周期与首次分区风险尚不能销项。** 最新正式版与本次检查的 main 仍保留旧研究指出的相关源码结构，详见后文。本轮没有运行它们，因此结论是“风险未获消除证据”，不是“已复现最新版故障”。[E6][E8][L6]
3. **Agent 同页控制需要重新适配。** Electrobun 有 CEF 调试端口，但没有证据表明其 TypeScript API 可直接替换 Electron `webContents.debugger`、会话管理及 PiDock 的身份绑定。Playwright 的 CDP 连接也不等同于完整 Playwright 协议兼容。必须在真实可见视图上验证 OOPIF、弹窗、下载、截图、接管及目标权限。[E2][E4][P1][L2–L4]

若探索动机是包体、启动或内存，建议只批准一个**独立、限时、可丢弃的 CEF PoC**，先验证这些收益是否仍存在。以“不含 CEF 的极小壳”对比含 Chromium 的 Electron，会避开本需求最重要的成本。官方明确说明 CEF 会显著增加下载与安装体积；本文没有实测可引用的 PiDock 等价包体或性能数字。[E4]

## 版本、证据等级与旧结论的更新

| 对象 | 本次核实基线 | 能证明的范围 |
| --- | --- | --- |
| Electrobun 正式版 | GitHub latest：**v2.0.6**，2026-11-04 发布；tag commit `c9e637c4e8acc8d53fc4a1703346196b004a00d8` | 本文主要源码和随版本文档依据。[E0] |
| Electrobun main | `59b151571deb80697a8fc49be454cd765f1fd9d7` | 另核对 macOS 原生实现；不将 main 当已发布版本。[E8] |
| 随 Electrobun 固定的 CEF | `156.0.7+g47dbc1d`，Chromium `156.0.8078.17` | 包内版本常量；不由版本号推定漏洞状态或生产稳定性。[E5] |
| PiDock 当前代码 | HEAD `a955d11fd5a2e4ccdcf1d74b273ec9aab28fa9d8`；Electron **44.4.3**、Pi 包 **1.5.0**、node-pty **1.1.0** | 以 `packages/shell/package.json` 为准。部分导航/架构文字仍写 Pi 1.4.0，不能据此覆盖清单事实。[L1] |
| Electron 上游 | latest release **45.2.3**，2026-11-04 发布 | 用于说明 PiDock 固定版不等于最新；本文不建议顺带升级。[N0] |
| T3 Code | main `508f869cb3d3ac07a6d81963da5054e1af0d8f51`；桌面 package 为 0.1.7 / Electron 44.10.1；latest release v0.1.7 | 功能实现按该 main 快照，不能推定全部已进入 v0.1.7 安装包。[T0–T1] |
| Codex / ChatGPT 桌面内置浏览器 | 官方产品文档的搜索索引摘录 | 能证明公开行为，不能证明内部采用哪一个 Electron 视图 API。[O1–O2] |

**本轮实际执行的验证**：读取仓库规则、架构、历史报告与相关源码；通过 GitHub API 查询 release/tag/main；下载 Electrobun v2.0.6、T3 main 源码到 `/tmp/pidock-runtime-research/`；读取官方 Electron / Playwright 文档并核对源码路径。**没有**安装/启动 Electrobun、编译 CEF、运行 PiDock 浏览器或测量包体/性能/沙箱进程。因此下文除明确标为历史实验外，均为**官方文档事实或源码推断**，不是当前运行验收。

2026-09-22 的两份归档研究使用 Electrobun 2.0.1 / CEF 147；其中 OSR 关闭/重开、Cookie/localStorage 隔离等是历史实验结果。不能把“最新还是 2.0.1”或“main 未变化”的旧时间描述沿用到现在，也不能把旧 OSR 实验提升为新版跨平台验收。[L6]

## “像 T3 Code / Codex”应如何转成需求

**T3 Code 有可核对的实现。** 当前源码的 `HostedBrowserWebview.tsx` 使用 Electron `<webview>`，不是 `WebContentsView`；`Manager.ts` 用 `webContents.fromId()` 找到 guest，检查类型为 `webview` 和 `hostWebContents` 归属，并持有 debugger 做控制。它还有自己的 CDP relay、下载处理及 session 权限策略。因此可参考的是完整宿主工作，而不是复制某个标签即可获得浏览器。[T1–T4]

T3 的 `BrowserSession` 对 scope 派生 partition，默认 scope 为 `shared`，也支持 profile namespace 和非持久分区；这**不能证明“每任务自动隔离”**。其预览 webPreferences 明确采用 `contextIsolation=false,sandbox=true,nodeIntegration=false`，与 PiDock 当前 `contextIsolation:true` 不同，不能未经边界评估照搬。CDP relay 还对部分协议方法直接返回 ACK；“提供 CDP 接口”不能自动理解为完整 Chrome 等价语义。[T2–T4]

**Codex 的官方产品描述可以确立行为基准。** 当前官方文档描述用户与 Agent 看同一页面、独立于常用浏览器的 profile、任务需要时直接登录；可打开页面、点击、输入、检查呈现状态、截图并验证结果；Developer mode 提供受控 CDP。官方帮助还写明可跨标签、下载文件、等待用户登录，并面向 macOS / Windows。它们支持未来浏览器的产品需求，却没有公开证明内部具体 `WebContentsView` / `<webview>` API、每任务隔离实现或所有平台架构相同。[O1–O2]

取证限制：两个 OpenAI 官方页面直接抓取均返回 **403**；上述内容来自同一调研中父代理取得的**官方页面搜索索引摘录**，不是读取了私有代码或安装包。公开 `openai/codex` 仓库的 CLI / app-server 实现也不能直接充当闭源桌面浏览器 UI 的证明。[O1–O3]

基于这些行为与 PiDock 现有隔离设计，建议将未来需求分成下列验收项；它们是**本报告提出的门槛**，不是宣称竞品全部采用同一策略：

| 门槛 | PiDock 应验收的行为 |
| --- | --- |
| 可见浏览与标签 | 地址栏、真实导航/重定向、前进后退、加载/失败状态、多个可独立销毁的标签；Agent 和人看同一页。 |
| 登录与弹窗 | OAuth / `window.open` / `target=_blank` 的父子归属、同任务 profile、`window.opener` / `postMessage`、弹窗独立关闭；外部协议需受控。 |
| 状态与隐私 | 同任务标签共享登录，不同任务或显式 profile 隔离 Cookie/storage；重启恢复、清除 profile、临时会话销毁都可验证。 |
| 下载与权限 | 文件真实落盘、文件名/目标目录/完成或失败、取消与任务归属；摄像头、麦克风、剪贴板、地理位置、通知及本地网络权限有策略。 |
| Agent 操作 | 在授权的可见 target 上定位、点击、输入、滚动、截图、console/network 取证，覆盖跨源 iframe；人工接管立即暂停，导航后旧操作失效。 |
| 不可信站点隔离 | 无本机 RPC/文件协议越权，无跨任务 target 控制；确认浏览器 OS sandbox，而非仅禁用 JS bridge；对页面内容诱导执行保持 Host 授权边界。 |
| 桌面体验与恢复 | 中文 IME、焦点/快捷键、DPI/多屏/缩放、浮层遮挡、崩溃恢复、退出回收；至少先覆盖 macOS arm64 与 Windows x64。 |

## Electron 与 Electrobun：能做什么、还缺什么证据

| 能力 | Electron / PiDock 现状 | Electrobun v2.0.6 的官方证据与限制 |
| --- | --- | --- |
| 真实嵌入网页 | Electron 有 `WebContentsView`；PiDock 已用它托管任务页。[L2][N2] | `BrowserView` 是 native/CEF view，`<electrobun-webview>` 只是 DOM 布局锚点，网页不是宿主 DOM 子节点。具备多视图基础，但没有“每标签一个 OS 进程”的承诺。[E2–E3] |
| 前进/后退/重载 | `webContents.navigationHistory` 等正式 API。[N2] | 原生 SDK 有历史/重载操作；官方映射表明确 **没有 TS history methods**，不能把底层能力当现成 TS API。需要补桥或使用 CDP，成本纳入 PoC。[E2] |
| 页面脚本 | Electron `executeJavaScript` 可异步返回值，debugger 也可执行 CDP。[N2] | `executeJavascript()` 不返回求值结果，未有 native browser/frame 时可能丢弃；需页面就绪屏障。对不可信页不能为取回结果打开通用应用 RPC。[E2–E3] |
| 弹窗 | PiDock 使用 `setWindowOpenHandler`、`did-create-window` 与身份登记。[L2] | macOS CEF 的 `OnBeforePopup` 发 `new-window-open` 事件后 `return true` 取消原生 popup。自行按 URL 重建 view 不足以证明原始 opener、named window、`about:blank` 登录流程等语义保留。[E6] |
| Cookie/profile | Electron session、Cookie API、清缓存/清 storage 和权限 handler 有公开接口；PiDock 用 workspace/task 派生持久 partition。[N3][L2] | CEF helper 缓存 `persist:*` request context；`persist:default` 特殊使用 global context；空或其他非持久名称每次新建临时 context。不能假设同名临时分区像 Electron 一样共享。Cookie 管理/清理的产品等价还需适配；不能直接复用 Electron profile 文件。[E9][N3] |
| 下载 | Electron `will-download` / DownloadItem 支持宿主管理；T3 有自己的落盘策略。[N3][T2] | 有开始/进度/完成/失败事件；macOS CEF 内置保存 Downloads 并处理重名。事件可用不等于具备产品要求的任意目标目录、暂停/取消与任务授权 API。[E2][E6] |
| 权限 | Electron session 可设置 request/check/display-media 等策略；应用仍必须配置，框架并非自动安全。[N1][N3] | 最新源码确有 CEF 权限 handler 和原生提示，不能沿用“无权限支持”的旧猜测；但 PiDock 的按任务、来源、权限类型策略能否完整接管尚未验证。[E6–E7] |
| Agent 控制/CDP | PiDock 在同一 `webContents` 上执行 debugger/CDP 输入、截图与取证，不另起隐藏浏览器。[L3–L4] | CEF dev 自动暴露可用本地调试端口；stable/canary 默认关闭，需显式配置。需要建立 view↔target 映射、授权 relay、事件顺序和断线恢复。本文未验证 CEF156 对 Playwright、Browser/Target 域及多分区的完整兼容。[E4][P1] |
| 对外部内容隔离 | PiDock 设置 sandbox/contextIsolation，关闭 Node；Electron 官方建议远程内容隔离、限制导航及窗口创建。[L2][N1] | `sandbox` 默认 false；开启只禁用应用 RPC，事件桥仍在。默认 `views` 协议可用、`appData` 默认禁用；后者若开启，即使导航到远程页也允许访问 app-owned 数据，应对不可信 view 显式关闭文件型协议。[E2–E3] |

### 最重要的安全差异：两种 sandbox 不是同一件事

在 v2.0.6 的 macOS `nativeWrapper.mm`、Windows `nativeWrapper.cpp`、Linux `nativeWrapper.cpp` 中，CEF 初始化均显式设置 `settings.no_sandbox = true`。Linux 默认命令行另含 `no-sandbox` / `disable-gpu-sandbox`。本次另取 main 的 macOS 文件，相关设置仍在。[E6–E8]

**源码可以证明框架配置禁用了 CEF sandbox；本轮没有进程级检测，不能进一步宣称每一种 native renderer 的系统沙箱状态。** 原生 WKWebView / WebView2 / GTK WebKit 各有自己的进程模型；这里的阻塞点特指计划用于一致 Chromium / CDP 的 Electrobun CEF 路径。Electrobun 文档自己也提醒 tag sandbox 不是全面安全保证。Electron 官方则将 renderer 的 Chromium sandbox 与 `contextIsolation` / Node 开关分别解释。[E3][N1]

因此，单独把 `sandbox:true` 写进 Electrobun view 配置，不能作为“与当前安全边界等价”的验收。需要上游或可维护补丁提供支持的 sandbox 构建/启动链，再验证有效 token / sandbox 状态、辅助进程、文件/网络与 IPC 边界；无法做到时，不建议承载开放互联网的已登录页面。CDP 也应仅通过经任务和 target 校验的本机控制边界开放，不能把进程全局调试端口直接交给不可信页或任意 Agent 参数。[E4][E6–E8][L4–L5]

### 旧 macOS 两个问题是否已修复

本次在 v2.0.6 及 main 对照，仍看到：

- 实际用于网页的 `ElectrobunClient` 返回自身 `CefLifeSpanHandler`，却没有 `DoClose` override；文件内另一个 DevTools client 的 `DoClose` 不能当成它的修复。`CEFWebViewImpl.remove` 仍调用 `CloseBrowser(false)`。[E6][E8]
- 新 partition helper 仍以 `CefRequestContext::CreateContext(settings, nullptr)` 创建 context，macOS 随后同步 `CreateBrowserSync`，未见 `OnRequestContextInitialized` 等待链。[E6][E8–E9]

这些与旧报告解释的危险路径一致，**但 CEF 已从 147 升到 156**，不能仅凭代码结构断言新版运行必然重现相同故障。旧报告对 CEF147 默认关闭行为的源码解释和 OSR 绕行实验仍有诊断价值；当前 CEF156 的真实 windowed 关闭、首次新 profile 创建和退出行为要重新运行。尤其不能以固定 500ms 预热或透明 OSR 开关作为已解决生命周期的依据。[E5][L6]

## CEF 与系统 WebView：不能同时取最小体积和统一控制语义

| 平台 | 默认 native renderer | 对 PiDock 的影响 |
| --- | --- | --- |
| macOS | WKWebView；可与 bundled CEF 混用 | 选 native 可减少捆绑浏览器体积，但不能假设 Electron Chromium CDP 实现可复用；选 CEF 才有本文研究的统一 Chromium 路径，需重验 lifecycle/OSR/IME。[E4] |
| Windows | WebView2，文档称由系统更新；可与 CEF 混用 | native 是 Chromium 系，但不是 Electrobun 跨平台统一 CDP 适配的证明；官方明确 webview masks / input passthrough 需要 CEF。还要验证运行时可用性、登录、权限与安装更新。[E4] |
| Linux | GTK WebKit；打包 CEF 时进程选择 CEF | **同一进程不能混用 native 与 CEF children**。GTK/WebKitGTK 等系统依赖与发行版差异需单列；不能复制 macOS/Windows 混合方案。官方支持表列 Ubuntu24.04+，其他 GTK3/WebKitGTK4.1 发行版属社区支持。[E1][E3–E4] |

Electrobun overlay 是独立原生层，宿主 CSS `z-index` 无法直接覆盖；mask 用挖洞方式处理，透明窗口/输入 passthrough 有平台约束。因此“React 中可以像 iframe 放一个标签”并不保证 PiDock 的菜单、标记、右键、滚动与浮层现成可用。[E3–E4]

**建议候选 PoC 直接选 CEF。** 若换 native 引擎，需把跨平台浏览器控制作为另一项独立技术选择，从零证明，而不能称为保留现有 CDP 能力的低成本换壳。[E3–E4][L3]

## 包体、更新、安全维护与 Node 生态

Electrobun 的真实优势是可选择系统 WebView、Bun 主运行时及自己的构建/更新机制；官方没有提供针对本仓库同等浏览器功能的可信体积/耗时基准。CEF 加入后仍需分发浏览器库、helper、资源和 locales，若为了兼容再带 Node，收益会进一步变化。应比较签名后的等价产物：下载/安装大小、冷启动至 UI 与首个 browser-ready、空闲/多页 RSS、增量更新大小，而非引用最小 Hello World 数字。[E1][E4][L1]

v2.0.6 更新体系提供 HTTPS 静态托管、完整压缩包与可选 delta、SHA-256/尺寸校验、失败回退 full bundle 和 staged activation。官方明确 **manifest 中的 hash/digest 不是 manifest 签名**，仍应使用平台签名；新更新流程要同时测试首次升级与后续升级。PiDock 当前是 electron-builder 的 mac DMG / Windows MSI 管线，迁移需要重做安装、签名/公证、更新来源信任、用户数据保留与失败恢复，不是换一项依赖。[E10][L1]

安全维护也不是“系统 WebView 永远新 / CEF 永远旧”的二选一：native 跟随各平台机制，CEF 则固定在 app 中，需要产品发版才能更新相应组件；Electron 同样随 app 分发 Chromium/Node，官方要求保持新版本。本文没有做 CVE 扫描，也没有证据可承诺任一框架的修复 SLA。应为浏览器/Bun/Node/CEF/native 依赖规定可接受的补丁时延，并对目标平台安装包实测。[E4–E5][N1]

**Node 兼容性不能只看 TypeScript 能否编译。** PiDock 的 utilityProcess、模型 worker、MessagePort、`node-pty`、SQLite/本机文件能力及 Pi/MCP/扩展加载都在实际运行边界内。Bun 的 Node 兼容文档应作为迁移核对清单；不是 Electron API 的替代合同。本文对 Bun 文档直接抓取返回403，未据此认证任一具体依赖兼容或不兼容。[B1–B2][L1][L7–L8]

尤其 `terminal-pty-driver.ts` 的 `resolvePtyRuntime()` 会以 Electron `process.execPath` 加 `ELECTRON_RUN_AS_NODE=1` 启动 Node worker。未来终端虽然不在首版范围，这条保留实现的运行时依赖依然存在；迁移应显式选择随包 Node 或验证 Bun + node-pty，不能默认移除 Electron 后本机 Node 就会存在。该文件本身也标注 Electron 路径存在未实测边界，不能把源码存在当验收。[L8]

## 结合 PiDock 的迁移落点

现行架构将内置浏览器列为延后范围，但源码保留了真实浏览器与自动化。本文只评估未来替换风险，不据此恢复首版功能。清单中的 Pi1.5.0 与架构文字的旧版本描述有漂移，迁移基线必须依源码和 lockfile重新冻结。[L1][L9]

| 当前落点 | 可保留的边界 | 替换工作及风险 |
| --- | --- | --- |
| `main/task-browser.ts`、`task-partition.ts` | workspace/task 身份、持久分区、标签/弹窗归属 | `WebContentsView`→Electrobun `BrowserView`/CEF；重写创建、布局、焦点、弹窗、销毁和 profile 管理；保持不同任务的持久状态不合并。[L2][E2][E9] |
| `main/browser-gateway.ts`、`task-browser-surface.ts` | `BrowserSurface` 窄接口、任务动作校验、接管、取证过滤 | 从此处做 adapter 最合适；接口仍带数字 `webContentsId`，要建立不透明页面身份到 native view / CEF target 的映射，不能简单重命名后信任。[L4–L5] |
| `main/task-automation.ts`、`agent-control.ts` | 同一可见页面、导航 epoch、接管暂停、输入/截图/证据语义 | Electron debugger→本机受控 CEF CDP adapter；处理 target/frame/process 变化、DevTools 竞争、关闭/重建、异常与取消。[L3–L4][E4] |
| Electron main / preload / renderer | React、领域类型、最小权限接口、运行时 payload 校验 | 重写窗口/IPC/preload；不可信 webview 禁止应用 RPC，事件仍需做身份及内容校验。React 可复用不等于 preload 可直接迁移。[E3][L9] |
| `rpc/host-client.ts` 与 Host/worker | `HostTransport` 已是 `postMessage/on` 小接口，领域 Host 可继续隔离 | utilityProcess 生命周期、MessagePort/worker 通信要重建；独立 Node Host 与纯 Bun Host 分别估价，不将运行时统一当先验收益。[L7][L9] |
| 打包与本机依赖 | workspace/pnpm、领域持久数据格式 | Hutch/Bun/CEF 资源、node-pty、本机 worker、SDK/扩展打包、签名与更新全部验证；不直接搬 Electron browser profile 文件。[L1][L8][E10] |

若继续探索，建议先保留 Node Host，仅替换抛弃式 PoC 的桌面/浏览器 adapter，分开测量“换壳收益”和“Bun Host 兼容成本”。最终是否随包 Node，要由等价体积和依赖验证决定；这是一条实验顺序建议，不是新架构决定。[L7–L9]

## 有界 PoC 与替换准入

建议预算 **最多 5 个工程日**，限独立临时目录，固定 Electrobun v2.0.6 / CEF156 与 Bun 具体版本；保留 Electron44.4.3 等价基线。目标先是 macOS arm64、Windows x64；若 Linux 是承诺支持的平台，必须另加 Linux gate，不能用另外两平台通过代替。时间上限到期只输出通过/失败/未验证和证据，不自动延长或迁入主线。

| 顺序 | 验收与明确失败条件 |
| --- | --- |
| 0：安全与可维护性 | 先证明 CEF OS sandbox 的支持路径及实际生效、远程页无应用 RPC/本机文件协议越权，CDP 仅可操控授权 target。若必须维持 `no_sandbox=true`，或依赖无维护计划的原生 fork，**停止替换 PoC**。不能用 sandbox tag 的单测冒充系统验证。 |
| 1：创建/关闭/隔离 | 两任务各两页；新持久 profile 冷启动至少20轮；每平台关闭/重开100轮；兄弟页 target/状态不变；正常退出、beforeunload、最后页关闭、renderer crash均不误关主窗、不挂起；Cookie/IndexedDB/LocalStorage重启后同任务保持、跨任务不串。 |
| 2：完整浏览流程 | 实际前进后退/重定向、OAuth弹窗及opener通信、target=_blank、下载真实落盘/取消/失败、权限允许/拒绝/清除、外部协议确认；缺任何约定必须记为不通过，不以请求发生代替下载成功。 |
| 3：可见页面 Agent | 在同一可见 target 完成输入、点击、跨源 iframe、截图和 console/network 证据；接管后无后续自动输入；导航后旧 epoch 被拒；越权 task/page/target、恶意事件桥 payload、DevTools断开均受控。若用Playwright，单独验证connectOverCDP，不能另起隐藏浏览器代替。 |
| 4：桌面/打包/收益 | 真实中文IME、键鼠、焦点、菜单/标记覆盖、DPI、多屏与OSR性能；脱离开发环境运行签名安装包，测升级/回退/数据保留和必要Host依赖。输出等价下载/安装大小、启动/RSS/输入延迟与基线差值。 |

PoC 成功只说明可进入完整迁移评估。生产替换还要求所有必需门槛通过、没有安全倒退、原生补丁责任可承担，以及包体或资源收益足以抵偿维护成本。若主要收益只有“偏好 Bun API”，目前不足以抵偿已有 Electron 浏览器与 Host 适配资产。[L1–L5]

当前最有价值的后续工作是**保留 Electron 主线并维护 BrowserSurface/HostTransport 边界**；等未来浏览器需求恢复时，直接按上述清单评估新增功能。Electrobun 可保留候选身份，前提是先处理 CEF sandbox 和生命周期，再用数据证明收益。

## 一手来源与本地依据

以下外部资料均在2026-11-06检索/读取。GitHub链接优先固定commit/tag；在线官方文档可能后续变化。上文的建议、门槛与成本判断属于本报告分析，链接证明其依赖的事实。

### Electrobun

- **E0**：[v2.0.6 release](https://github.com/blackboardsh/electrobun/releases/tag/v2.0.6)、[tag API](https://api.github.com/repos/blackboardsh/electrobun/git/ref/tags/v2.0.6)、[latest release API](https://api.github.com/repos/blackboardsh/electrobun/releases/latest)。
- **E1**：[v2.0.6 README：运行时、工具链、平台支持](https://github.com/blackboardsh/electrobun/blob/c9e637c4e8acc8d53fc4a1703346196b004a00d8/README.md)。
- **E2**：[BrowserView 文档固定快照](https://github.com/blackboardsh/electrobun/blob/c9e637c4e8acc8d53fc4a1703346196b004a00d8/docs/src/content/docs/electrobun/apis/browser-view.mdx)、[TS BrowserView源码](https://github.com/blackboardsh/electrobun/blob/c9e637c4e8acc8d53fc4a1703346196b004a00d8/package/src/sdks/main/core/BrowserView.ts)、[在线 API](https://docs.electrobun.dev/electrobun/apis/browser-view/)。
- **E3**：[Webview Tag Architecture 固定快照](https://github.com/blackboardsh/electrobun/blob/c9e637c4e8acc8d53fc4a1703346196b004a00d8/docs/src/content/docs/electrobun/guides/architecture/webview-tag.mdx)、[在线文档](https://docs.electrobun.dev/electrobun/guides/architecture/webview-tag/)。
- **E4**：[Bundling CEF 固定快照](https://github.com/blackboardsh/electrobun/blob/c9e637c4e8acc8d53fc4a1703346196b004a00d8/docs/src/content/docs/electrobun/apis/bundling-cef.mdx)：引擎选择、体积、调试端口、Linux混用限制。
- **E5**：[CEF / Chromium版本常量](https://github.com/blackboardsh/electrobun/blob/c9e637c4e8acc8d53fc4a1703346196b004a00d8/package/src/shared/cef-version.ts)。
- **E6**：[macOS nativeWrapper.mm](https://github.com/blackboardsh/electrobun/blob/c9e637c4e8acc8d53fc4a1703346196b004a00d8/package/src/native/macos/nativeWrapper.mm)：实际ElectrobunClient约6045行；下载6442；lifespan/popups6821；权限6962；no_sandbox7376；CreateBrowserSync7905；remove8091。
- **E7**：[Windows nativeWrapper.cpp](https://github.com/blackboardsh/electrobun/blob/c9e637c4e8acc8d53fc4a1703346196b004a00d8/package/src/native/win/nativeWrapper.cpp#L7164)、[Linux nativeWrapper.cpp](https://github.com/blackboardsh/electrobun/blob/c9e637c4e8acc8d53fc4a1703346196b004a00d8/package/src/native/linux/nativeWrapper.cpp#L2720)、[共享CEF权限名称解析](https://github.com/blackboardsh/electrobun/blob/c9e637c4e8acc8d53fc4a1703346196b004a00d8/package/src/native/shared/permissions_cef.h)。
- **E8**：[main快照 macOS nativeWrapper.mm](https://github.com/blackboardsh/electrobun/blob/59b151571deb80697a8fc49be454cd765f1fd9d7/package/src/native/macos/nativeWrapper.mm)。本轮只针对本文关键路径对照，不宣称审计了全部main。
- **E9**：[partition_context.h](https://github.com/blackboardsh/electrobun/blob/c9e637c4e8acc8d53fc4a1703346196b004a00d8/package/src/native/shared/partition_context.h)。
- **E10**：[v2.0.6 Updates文档](https://github.com/blackboardsh/electrobun/blob/c9e637c4e8acc8d53fc4a1703346196b004a00d8/docs/src/content/docs/electrobun/guides/updates.mdx)、[Updater API](https://github.com/blackboardsh/electrobun/blob/c9e637c4e8acc8d53fc4a1703346196b004a00d8/docs/src/content/docs/electrobun/apis/updater.mdx)。

### Electron、Playwright 与 Bun

- **N0**：[Electron45.2.3 release](https://github.com/electron/electron/releases/tag/v45.2.3)。
- **N1**：[Electron安全建议](https://www.electronjs.org/docs/latest/tutorial/security)、[44.4.3 sandbox说明](https://github.com/electron/electron/blob/v44.4.3/docs/tutorial/sandbox.md)。
- **N2**：[44.4.3 WebContentsView](https://github.com/electron/electron/blob/v44.4.3/docs/api/web-contents-view.md)、[webContents API](https://github.com/electron/electron/blob/v44.4.3/docs/api/web-contents.md)。
- **N3**：[44.4.3 session API](https://github.com/electron/electron/blob/v44.4.3/docs/api/session.md)、[DownloadItem](https://github.com/electron/electron/blob/v44.4.3/docs/api/download-item.md)。
- **P1**：[Playwright connectOverCDP](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp)：只支持Chromium，官方说明相较Playwright协议连接保真度更低。
- **B1–B2**：[Bun Node兼容性](https://bun.com/docs/runtime/nodejs-compat)、[child process](https://bun.com/docs/runtime/child-process)。本轮直抓403，作为后续检查入口，**未据这些链接认定PiDock依赖已兼容**。

### T3 Code 与 OpenAI

- **T0**：[T3 v0.1.7 release](https://github.com/pingdotgg/t3code/releases/tag/v0.1.7)、[main快照desktop package.json](https://github.com/pingdotgg/t3code/blob/508f869cb3d3ac07a6d81963da5054e1af0d8f51/apps/desktop/package.json)。
- **T1**：[HostedBrowserWebview.tsx](https://github.com/pingdotgg/t3code/blob/508f869cb3d3ac07a6d81963da5054e1af0d8f51/apps/web/src/browser/HostedBrowserWebview.tsx)。
- **T2**：[preview/Manager.ts](https://github.com/pingdotgg/t3code/blob/508f869cb3d3ac07a6d81963da5054e1af0d8f51/apps/desktop/src/preview/Manager.ts)：guest归属核验约1762；debugger控制约1008起；下载约3656起。
- **T3**：[BrowserSession.ts](https://github.com/pingdotgg/t3code/blob/508f869cb3d3ac07a6d81963da5054e1af0d8f51/apps/desktop/src/preview/BrowserSession.ts)、[WebviewPreferences.ts](https://github.com/pingdotgg/t3code/blob/508f869cb3d3ac07a6d81963da5054e1af0d8f51/apps/desktop/src/preview/WebviewPreferences.ts)。
- **T4**：[CdpRelay.ts](https://github.com/pingdotgg/t3code/blob/508f869cb3d3ac07a6d81963da5054e1af0d8f51/apps/desktop/src/preview/CdpRelay.ts)、[DesktopBrowserHost.ts](https://github.com/pingdotgg/t3code/blob/508f869cb3d3ac07a6d81963da5054e1af0d8f51/apps/desktop/src/preview/DesktopBrowserHost.ts)。
- **O1**：[OpenAI Codex app browser文档](https://developers.openai.com/codex/app/browser)。官方页面搜索索引摘录；直接抓取403。其当前内容包含ChatGPT桌面共享浏览器描述，本文不把产品命名变化推断成新的内部架构。
- **O2**：[OpenAI桌面内置浏览器帮助](https://help.openai.com/en/articles/20001277-using-the-built-in-browser-in-the-chatgpt-desktop-app)。官方页面搜索索引摘录；直接抓取403。
- **O3**：[openai/codex官方仓库](https://github.com/openai/codex)：其公开范围不能证明闭源桌面浏览器内部视图选型。

### PiDock 本地依据

- **L1**：[shell package.json](../../packages/shell/package.json)、[electron-builder配置](../../packages/shell/electron-builder.config.cjs)。
- **L2**：[task-browser.ts](../../packages/shell/src/main/task-browser.ts)、[task-partition.ts](../../packages/shell/src/main/task-partition.ts)。
- **L3**：[task-automation.ts](../../packages/shell/src/main/task-automation.ts)。
- **L4**：[task-browser-surface.ts](../../packages/shell/src/main/task-browser-surface.ts)、[agent-control.ts](../../packages/shell/src/main/agent-control.ts)。
- **L5**：[browser-gateway.ts](../../packages/shell/src/main/browser-gateway.ts)。
- **L6**：[2026-09-22源码复核](electrobun-runtime-source-review.md)、[历史实测复核](electrobun-runtime-recheck.md)。
- **L7**：[rpc/host-client.ts](../../packages/shell/src/rpc/host-client.ts)。
- **L8**：[terminal-pty-driver.ts](../../packages/shell/src/host/terminal-pty-driver.ts)。
- **L9**：[现行技术栈与进程边界](../architecture/implementation-stack-design.md)、[文档归属规则](../README.md)。
