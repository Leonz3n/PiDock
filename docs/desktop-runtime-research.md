# 桌面运行时选型资料核对

> **2026-09-22 最终选型已确认：** Electron 44+ / Node 24；AgentSession 在 utilityProcess，Chromium 视图与 CDP 管理在 main，React renderer 完全 sandbox。当前权威约束见[技术栈设计](implementation-stack-design.md)。本文保留调研/取舍过程，其中旧候选、回退或待确认文字不再作为执行指令；后续工单仍暂停。

核对日期：2026-09-21。范围：Bun、Electrobun 与 Electron + Bun Host，以及首版可见浏览器和安装包门槛。只读官方资料，没有构建应用、连接浏览器、下载发布包或执行平台实验。

本文支持 [首版规格](../.scratch/pidock-mvp/spec.md) 与 [01 可见浏览器控制原型](https://github.com/Leonz3n/PiDock/issues/2)。**Electrobun 作为优先验证候选，Electron + Bun Host 作为失败后的回退；不是已经通过技术验收。** Bun Host 与 React 界面可以沿用相同业务边界，不应随桌面壳切换而重写领域逻辑。

**2026-09-21 更新（实测结果）：** 工单 01 已在 macOS arm64 实测 Electrobun 2.0.1：可见 CEF 页面的直接 CDP 控制成立，但新持久 partition 的首个 CEF view 返回 null，且移除一个 CEF `BrowserView` 会清理同窗全部 CEF view 并使 CDP 不可达，因此触发本文与规格的决策关卡。后续实现按既定规则改用 **Electron + Bun Host**；本文关于 Electrobun 的官方资料核对保留为历史背景，下方「Electron + Bun Host 回退方案」成为当前路线。Electron 自身的浏览器生命周期、分区与调试接入仍须用同一场景实测，见 [可见页面控制与桌面壳验证](browser-automation-validation.md)。

## 项目身份与版本

用户提及的「ElectronBun」按 [blackboardsh/electrobun 官方仓库](https://github.com/blackboardsh/electrobun) 理解，正式名称是 **Electrobun**；它是独立桌面框架，不是把 Electron 内置 Node 替换成 Bun 的插件。

本次 GitHub 最新正式 Release 为 [v2.0.1](https://github.com/blackboardsh/electrobun/releases/tag/v2.0.1)，发布时间为 2026-08-22，对应提交 `8d09d15db791f346e419efd452d6759750addb62`。以下 Electrobun 结论均以该固定版本的仓库文档为依据；同时查看的 main 提交为 `8659d402dc526d89ce9638038331eb2d66a01dba`，不拿未发布改动替代版本事实。

**v2 默认 JavaScript 主进程已经是 Cottontail，不是 Bun。** 官方配置仍列出 `build.mainProcess: "bun"` 和 `build.bun`。PiDock 若验证 v2，必须明确选择 Bun、锁定框架与运行时版本，并在启动证据中记录实际运行时。`bunx electrobun` 或用 Bun 安装依赖只证明启动工具/包管理方式，不能证明应用主进程使用 Bun。Hutch 是构建工具，配置加载和构建 hooks 使用 Cottontail；因此采用 v2 Bun 主进程也不应描述成「整个工具链只有 Bun」。[S1][S2]

## 已确认能力与产品影响

| 事项 | 官方资料确认 | 对 PiDock 的含义 |
| --- | --- | --- |
| Bun 主进程 | 可显式选择 `build.mainProcess: "bun"`；默认 Cottontail | 满足 Bun 运行时方向有配置入口，pi 与实际打包运行仍须验证。[S2] |
| 系统浏览器 | macOS 为 WKWebView，Windows 为 WebView2；可捆绑 CEF | 系统浏览器不是统一 Chromium。任务浏览器优先验证 CEF，不能把 macOS WKWebView 当 CDP 目标。[S3][S8] |
| 可见内嵌页面 | `BrowserView` 与 `<electrobun-webview>` 支持页面、renderer、partition；后者是原生视图组合 | 有可见嵌入能力，不需要以隐藏浏览器替代。嵌入、遮罩、浮层与接管仍需按实际 UI 验证。[S4][S5] |
| 持久会话 | `partition` 文档定义为持久存储/会话分区 | 两任务可以各绑定分区；同站登录、重启持久化和弹窗继承仍是测试要求，不能只看参数便宣布隔离通过。[S4][S5] |
| CEF 调试入口 | 开发构建在回环地址选择 9222–9232 端口；canary/stable 默认禁用，需明确设置 `remote-debugging-port`，支持单次启动环境覆盖 | 存在 CDP 接入路径，但开发模式连上不等于安装版可用。需要控制端点生命周期、端口冲突、任务目标映射与访问边界。[S2] |
| 简单脚本执行 | `executeJavascript()` 不返回求值结果；需要 typed RPC 才能返回数据 | 该 API 本身不能证明语义定位、自动等待、截图和失败请求采集已具备。[S4] |
| 非可信网页 | sandbox 默认 false；设为 true 时关闭 Electrobun RPC，保留事件与导航控制 | 产品界面与任务网页要分开信任；不能给任意业务网站开放本机 Host 能力。该选项不能直接等同于完整 OS 沙箱。[S4][S5] |
| 双平台架构 | 发布矩阵明确列 macOS ARM64、Windows x64；按本机平台架构构建 | 与目标架构匹配，但仍需两种 runner 和实际目标机测试。[S3][S6] |
| macOS 分发 | 默认 DMG；提供签名、公证、staple 流程 | 工具路径已有文档，PiDock 的 Bun/CEF 组合、所有内嵌二进制与升级仍未验证。[S6][S7] |
| Windows 分发 | 默认 `Setup.zip`，内含 setup EXE 与相邻隐藏 payload | **不直接满足用户要求的独立 `.exe` 安装资产**；不能只抽出 EXE 就假设可用，需验证额外封装方案。[S6] |
| Windows 签名 | 官方明确 Windows release signing 尚未集成到 Hutch 打包流程 | 必须补充 Authenticode 签名与验证步骤；当前不能宣称发布要求已满足。[S7] |

官方 `<electrobun-webview>` 文档还指出 Windows WebView2 不支持相关遮罩和鼠标穿透操作，需要这些能力时应选择 CEF。PiDock 有工具面板、菜单和浮层，因此原型须检查页面是否遮住 React 浮层，以及窗口缩放、标签切换、面板收起后输入是否仍落在正确页面。捆绑 CEF 会改变体积和资源占用；本次不引用系统 webview 的体积宣传作为最终产品包大小。[S5]

## 自动化证据边界

Playwright 官方确认 `chromium.connectOverCDP()` 只支持 Chromium 浏览器，并明确其保真度显著低于 Playwright 原生协议连接。[S8] Electrobun 的 CEF 调试端点与 Chromium 渲染选择使其成为合理的验证路线，但所读官方资料**没有证明**以下 PiDock 组合已经可用：

- Bun 下 `playwright-core` 连接 Electrobun CEF，并可靠发现所有可见嵌入页面和分区；不能假设 `contexts()[0].pages()[0]` 就是当前任务。
- 角色/标签定位、异步等待、截图、控制台错误、失败请求在同一可见目标上完整工作。
- 多个 CEF request context 与 CDP browser context 的映射是否满足两任务持久隔离，以及浏览器级 CDP endpoint 是否具备客户端需要的命令。
- 弹窗、跨域 iframe、下载、页面关闭、开发者工具开启与断线重连的完整行为。
- 接管时停止后续自动化，恢复前重新读取页面状态；页面句柄失效后拒绝继续操作旧目标。

这里的「没有证明」不代表框架不支持，而是原型的实测任务。Bun 下能导入库不等于运行上述操作成功。若 Playwright 不兼容，可调查直接 CDP 或受限自动化适配器；需要重新评估语义定位和自动等待的实现代价，不应临时换用另一个隐藏 Chromium 来算通过。

## Electron + Bun Host 回退方案

Electron 的主进程运行 Node.js；它的 utility process 也运行 Node.js。Bun 不会因为改用 Bun 包管理器而替换这两个运行时。[S9] 回退方案应保持 Electron 负责窗口、原生集成和可见浏览器，另启动 Bun Host 承载 pi、调度、工作区及受管服务；Bun Host 可使用 Bun 官方单文件可执行产物机制，终端用户不必自行安装 Bun。[S13]

Electron 提供 `WebContentsView`，其 `webContents` 就是显示的页面引用；`session.fromPartition('persist:…')` 提供持久分区。`webContents.capturePage`、控制台事件和 `webContents.debugger` 则提供截图与调试入口。[S10][S11][S12] 这些直接 API 降低了接入不确定性，但仍不能代替 01 原型验收。

特别是 Electron 官方指出开启 DevTools 或关闭 webContents 会触发 debugger detach，所以即便回退 Electron，也必须设计控制句柄失效、暂停和重新绑定。选择 Bun 中的 Playwright/CDP，或 Electron 中的浏览器适配器，需要用同一测试场景决定；若客户端需要 Node helper，应明确记录它的职责和新增进程代价。[S12]

Electron 生态的 electron-builder 提供 NSIS 安装器配置，可作为 Windows EXE 的候选打包路线；这不表示 PiDock 的签名、升级、卸载及 Bun 子进程生命周期已得到验证。[S14]

## 下一步原型与决策门槛

1. 锁定 Electrobun v2.0.1 或另一个明确选定版本，显式选择 Bun；应用界面与任务浏览器分开，任务浏览器选 CEF，记录实际 Bun/CEF/客户端版本。
2. 按 01 工单在两个可见页面验证语义操作、异步等待、错误证据与持久会话隔离；验证接管、恢复、弹窗、iframe、下载、页面关闭和 DevTools。
3. 同时做最小发布可行性验证：macOS ARM64 DMG、Windows x64 独立 EXE、签名链与安装后启动。特别记录默认 Windows ZIP 的改造路径和签名插入点，不推迟到生产界面完成后才发现不符合分发要求。
4. 任一核心能力不能以可接受代价实现，按规格回退 Electron + Bun Host，再用相同验收场景检查；保留 Host 与 React 界面的受控接口。
5. macOS 与 Windows 分别记录结果，没有 Windows 环境时明确留待验证，不能宣布跨平台选型全部通过。

React、Tailwind CSS 与 TanStack 属于产品界面栈，不决定上述原生浏览器控制是否成立。既有 vanilla JS 草稿可继续作为视觉与行为基线；无须为了比较桌面运行时先重写整套草稿。

## 一手来源

- [S1：Electrobun v2.0.1 README](https://github.com/blackboardsh/electrobun/blob/8d09d15db791f346e419efd452d6759750addb62/README.md)
- [S2：固定版本构建配置、主进程与 CEF 调试端口](https://github.com/blackboardsh/electrobun/blob/8d09d15db791f346e419efd452d6759750addb62/docs/src/content/docs/electrobun/apis/cli/build-configuration.mdx)
- [S3：固定版本跨平台开发指南](https://github.com/blackboardsh/electrobun/blob/8d09d15db791f346e419efd452d6759750addb62/docs/src/content/docs/electrobun/guides/cross-platform-development.mdx)
- [S4：固定版本 BrowserView API](https://github.com/blackboardsh/electrobun/blob/8d09d15db791f346e419efd452d6759750addb62/docs/src/content/docs/electrobun/apis/browser-view.mdx)
- [S5：固定版本内嵌 webview API](https://github.com/blackboardsh/electrobun/blob/8d09d15db791f346e419efd452d6759750addb62/docs/src/content/docs/electrobun/apis/browser/electrobun-webview-tag.mdx)
- [S6：固定版本打包分发指南](https://github.com/blackboardsh/electrobun/blob/8d09d15db791f346e419efd452d6759750addb62/docs/src/content/docs/electrobun/guides/bundling-and-distribution.mdx)
- [S7：固定版本签名指南](https://github.com/blackboardsh/electrobun/blob/8d09d15db791f346e419efd452d6759750addb62/docs/src/content/docs/electrobun/guides/code-signing.mdx)
- [S8：Playwright BrowserType.connectOverCDP](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp)
- [S9：Electron 进程模型](https://www.electronjs.org/docs/latest/tutorial/process-model)
- [S10：Electron WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view)
- [S11：Electron Session 分区](https://www.electronjs.org/docs/latest/api/session#sessionfrompartitionpartition-options)
- [S12：Electron Debugger](https://www.electronjs.org/docs/latest/api/debugger)、[WebContents](https://www.electronjs.org/docs/latest/api/web-contents)
- [S13：Bun 单文件可执行产物](https://bun.com/docs/bundler/executables)
- [S14：electron-builder NSIS 配置](https://www.electron.build/docs/nsis)
