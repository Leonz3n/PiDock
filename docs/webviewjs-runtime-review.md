# WebviewJS + Bun 候选复核

> **2026-09-22 最终选型已确认：** Electron 44+ / Node 24；AgentSession 在 utilityProcess，Chromium 视图与 CDP 管理在 main，React renderer 完全 sandbox。当前权威约束见[技术栈设计](implementation-stack-design.md)。本文保留调研/取舍过程，其中旧候选、回退或待确认文字不再作为执行指令；后续工单仍暂停。

2026-09-22。只读核对官方项目及其 Wry 依赖，未安装依赖、运行应用或推进工单。准确项目是 **`webviewjs/webview` / `@webviewjs/webview`**；当前 npm latest 和 GitHub release 都是 **0.4.6**，发布于 2026-09-20，tag 指向 `0b1854f957fde6754b7e47236b0afd18d3b72a22`。[S1][S2]

**它值得作为 Bun 桌面壳候选；旧设计笔记将它概括为「单窗口、无分区、无多视图、无调试」不准确。** 当前版本明确支持 Bun、原生子视图、共享 WebContext、脚本执行和 DevTools。不过，「自有 React 界面可以运行」与「满足任务浏览器的双平台持久隔离、截图和同页自动化」仍是不同结论；后一项尚有具体 API 缺口。[S2–S6]

## 已确认能力与边界

| 方面 | 最新官方证据 | 对 PiDock 的含义 |
| --- | --- | --- |
| Bun | README 声明 Node/Bun/Deno first-class support；N-API 原生绑定；CLI 选择 Bun 时使用 `bun build --compile`。 | 可以让壳与 Host 都使用 Bun；`engines.node >=24` 不意味着运行时必须混入 Node。[S2][S3] |
| 原生引擎 | macOS 使用 WKWebView；Windows 使用 WebView2；Linux 使用 WebKitGTK。 | 是系统 webview 壳，不是捆绑 Chromium 的跨平台统一浏览器。macOS 不能直接复用 CEF CDP 路径。[S2][S4] |
| 多视图 | `createWebview({child:true,x,y,width,height})`、`setBounds`、`dispose` 已公开；macOS 源码使用 Wry `build_as_child`。 | 「单窗口轻量绑定」不能作为否决理由。原生视图遮挡、缩放、关闭、输入及生命周期仍需实测。[S5] |
| 存储上下文 | `app.createWebContext({dataDirectory})`，创建视图可复用 `webContext`。 | Windows 底层确实将目录传给 WebView2 环境；**macOS 不能由此推出隔离，见下文**。[S6][S7] |
| 同页控制 | `evaluateScript`、`evaluateScriptWithCallback`、preload、导航和页面加载事件。 | 能在用户当前可见的那个 webview 执行 JS，具有自建 Agent 页面适配器的基础；不是「不可自动化」。[S5] |
| 调试与取证 | `openDevtools` 等已公开；`allowsAutomation` 文档明确目前只在 Linux 生效。检索当前公开接口和 Rust 绑定未见截图、统一 CDP 连接/target 路由或浏览器输入协议 API。 | 打开 DevTools 不等于 Playwright 可连接；页面内 JS 点击不等于完整浏览器级输入、跨域 iframe 控制或截图。双平台同页自动化仍需补原生能力或额外方案验证。[S5][S6] |
| 弹窗 | `new-window` 事件及同步导航 guard；Rust 回调丢弃 `NewWindowFeatures`，返回 Allow/Deny。 | 有拦截基础，但尚不能证明 OAuth opener 语义、同任务存储继承和弹窗句柄绑定满足要求。[S5] |
| 分发 | CLI 能编译独立可执行文件，但 README 明确不是 installer/full app bundler，不处理完整跨平台安装、签名、公证。`.node` 原生插件按 OS/架构构建。 | 可交付给不预装 Bun 的机器不等于已经有 macOS DMG、Windows 单一安装 EXE。WebView2 runtime、原生插件和前端资源均需纳入发布验收。[S2][S3][S4] |

## macOS 持久隔离：文档与底层实际行为不同

WebviewJS 的 WebContext 文档说不同 context 用于 isolated profiles，并称 `dataDirectory` 是持久目录。实现仅调用 `wry::WebContext::new(path)`，随后 `WebViewBuilder::new_with_web_context`；当前公开配置和 Rust 代码未暴露 `data_store_identifier` 或调用 Darwin 的 `with_data_store_identifier`。[S6]

它的 Cargo.toml 依赖 Wry `0.55.1`（semver 范围；仓库未提交 Cargo.lock，因此不能将此核对冒充发布二进制依赖指纹）。核对对应官方 tag 的源码发现：[S7]

- Wry 明确说明 **WKWebView 不支持 `data_directory`**；替代入口是 `WebViewBuilderExtDarwin::with_data_store_identifier([u8;16])`。
- 该入口支持 **macOS 14+** 的持久 `WKWebsiteDataStore::dataStoreForIdentifier`。
- 未提供 identifier、又不是 incognito 时，创建配置走 **`WKWebsiteDataStore::defaultDataStore`**。仅传不同 `WebContext.dataDirectory` 不能进入自定义数据存储分支。
- `incognito:true` 走 nonPersistentDataStore，不能满足重启保留登录状态。

因此，**当前现成 JS API 不能证明 PiDock 所需的 macOS「不同任务持久隔离、同任务多页共享」**。这不是 WebKit 在技术上永远不支持，而是 WebviewJS 尚未接出已存在的底层入口。若接受扩展 Rust/N-API 绑定，可加入稳定的任务 UUID → data store identifier，并限定 macOS 最低版本，再实测 cookie/localStorage/IndexedDB、重启和弹窗继承。这是明确、可验证的补齐方向，不是已经完成的修复。[S6][S7]

## 选型含义

若 WebviewJS 只承载自有 React 控制面，它已经有合理的官方能力依据，可避免 Electron + Bun 双运行时。若它同时承载当前规格要求的任务浏览器，就需要先验证上述持久隔离补齐及同页自动化/截图路径。另开一个受控外部浏览器可以成为不同产品方案，但不自动满足「内嵌且 Agent 与用户操作同一页面」的现有要求。[S2–S7][S8]

不能因缺少现成 API 就断言底层无解，也不能因支持 evaluateScript、WebContext、DevTools 就宣布已经满足完整浏览器控制关卡。此时适合保留候选并明确验证范围，不能据此直接启动后续实现工单。

## 一手资料

- S1：[v0.4.6 release](https://github.com/webviewjs/webview/releases/tag/v0.4.6)、[npm 元数据](https://registry.npmjs.org/@webviewjs%2fwebview)。
- S2：[固定版本 README](https://github.com/webviewjs/webview/blob/0b1854f957fde6754b7e47236b0afd18d3b72a22/README.md)、[package.json](https://github.com/webviewjs/webview/blob/0b1854f957fde6754b7e47236b0afd18d3b72a22/package.json)。
- S3：[编译独立可执行文件](https://github.com/webviewjs/webview/blob/0b1854f957fde6754b7e47236b0afd18d3b72a22/docs/guides/building-executables.md)。README 的明确限制补充了本文档的乐观概述。
- S4：[macOS 平台说明](https://github.com/webviewjs/webview/blob/0b1854f957fde6754b7e47236b0afd18d3b72a22/docs/platform/macos.md)、[Windows 平台说明](https://github.com/webviewjs/webview/blob/0b1854f957fde6754b7e47236b0afd18d3b72a22/docs/platform/windows.md)。Windows 文档声称缺失运行时会自动安装；此次未复核发布安装路径，不能当离线安装已验收。
- S5：[Webview API](https://github.com/webviewjs/webview/blob/0b1854f957fde6754b7e47236b0afd18d3b72a22/docs/api/webview.md)、[Rust webview 实现](https://github.com/webviewjs/webview/blob/0b1854f957fde6754b7e47236b0afd18d3b72a22/src/webview.rs)、[JS 类型定义](https://github.com/webviewjs/webview/blob/0b1854f957fde6754b7e47236b0afd18d3b72a22/index.d.ts)。
- S6：[WebContext API](https://github.com/webviewjs/webview/blob/0b1854f957fde6754b7e47236b0afd18d3b72a22/docs/api/web-context.md)、[Rust WebContext 实现](https://github.com/webviewjs/webview/blob/0b1854f957fde6754b7e47236b0afd18d3b72a22/src/web_context.rs)。
- S7：[WebviewJS Cargo.toml](https://github.com/webviewjs/webview/blob/0b1854f957fde6754b7e47236b0afd18d3b72a22/Cargo.toml)；Wry 0.55.1 提交 `a5bf203a1c8dbb3583588382538d6521655222a8` 的 [Darwin 扩展说明](https://github.com/tauri-apps/wry/blob/a5bf203a1c8dbb3583588382538d6521655222a8/src/lib.rs#L1533)、[WKWebView 数据存储分支](https://github.com/tauri-apps/wry/blob/a5bf203a1c8dbb3583588382538d6521655222a8/src/wkwebview/mod.rs#L220)、[WebView2 数据目录](https://github.com/tauri-apps/wry/blob/a5bf203a1c8dbb3583588382538d6521655222a8/src/webview2/mod.rs#L287)。
- S8：[当前首版规格](../.scratch/pidock-mvp/spec.md)。
