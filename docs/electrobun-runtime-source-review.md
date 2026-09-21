# Electrobun 运行时复核：官方源码证据

2026-09-22。范围：只读核对官方源码、文档及上游工单；本文不运行原型、不改变工单状态、不宣布任何方案通过验收。本地运行复验由另行记录的实验提供。

**原来的证据支持「Electrobun 2.0.1 的现成 macOS windowed CEF 路径未通过」，不足以支持「Electrobun + Bun Host 在技术上无解」。两个失败点都能在原生适配层找到具体原因和修复方向；尚不能把源码推断等同于修复后的验证结果。** 如果不接受维护原生补丁，Electron + Node Host 是符合统一运行时偏好的可行候选；pi 并不要求 Bun。[S1–S8]

## 版本边界

- GitHub 最新正式 release 仍是 **v2.0.1**，提交 `8d09d15db791f346e419efd452d6759750addb62`，发布于 2026-08-22。[S1]
- 调查时 `main` 是 `8659d402dc526d89ce9638038331eb2d66a01dba`。对照这两个提交，macOS 下本文涉及的 `CreateBrowserSync`、实际 `ElectrobunClient` 生命周期处理和 `CEFWebViewImpl.remove` 没有修复；共享 partition helper 仅增加 `appdata` scheme 注册。[S2]
- v2.0.1 固定 CEF `147.0.10+gd58e84d`、Chromium `147.0.7727.118`。以下 CEF 行为按这个 CEF 提交核对，不拿新版文档猜旧版行为。[S3]

## 新持久分区首次 BrowserView 为 null

Electrobun 的共享 partition helper 对新 `persist:*` 调用 `CefRequestContext::CreateContext(settings, nullptr)`，缓存返回的 context；macOS 随后立即拿它调用 `CreateBrowserSync`。这里未提供 `CefRequestContextHandler`，也没有等待初始化完成。[S4][S5]

精确版本的 CEF 源码区分两条路径：[S6]

1. 异步 `CreateBrowser` 先执行 `ExecuteWhenBrowserContextInitialized`，就绪后才安排真正的创建。
2. `CreateBrowserSync` 直接检查 `VerifyBrowserContext()`，不通过便返回 `nullptr`。

因此「新 context 第一次同步建页失败；经过时间后同一缓存 context 可以成功」与源码的初始化竞态高度吻合。源码不足以排除其他 null 原因，但明确提供了无需固定 500ms 睡眠的修复方向：使用异步 `CreateBrowser`，在 `OnAfterCreated` 绑定 browser、完成视图初始化和排队导航；或接入 `OnRequestContextInitialized` 后再创建。需要同步解决视图等待期间取消、销毁和回调到达顺序，不能只替换函数名。[S5][S6]

Windows v2.0.1 的普通嵌入视图已经使用异步 `CefBrowserHost::CreateBrowser` 和创建回调，是同仓库可参考的实现；macOS 仍走同步路径。这属于平台适配差异，不是 Bun 无法承载 Host。[S7]

GitHub 上有相关持久分区报告 #380 及自动化跟踪 #466，但报告正文还涉及历史 cache path / fallback 问题，不能直接当成本次初始化竞态的确认或修复证明。尤其不能用全局 context 代替任务分区：这样会破坏跨任务隔离。[S9]

## 移除一个视图为何会关闭整窗

macOS 的实际 `ElectrobunClient` 继承 `CefLifeSpanHandler`，`GetLifeSpanHandler()` 返回自身，但未重写 `DoClose`。另一个叫 `ElectrobunHandler` 的类确实有 `DoClose`，却不是这里 `CEFWebViewImpl` 实例化的 client，不能混看。[S5]

`CEFWebViewImpl.remove` 调用 `self.browser->GetHost()->CloseBrowser(false)`，马上清空自身 browser 引用，再异步移除 NSView。CEF 的默认 `DoClose` 返回 false；同版本 CEF 文档明确：**windowed 模式下，false 会向浏览器的顶层父窗口发送标准关闭通知，macOS 是 `performClose:`**。这解释了一个嵌入页面的移除为何可能转变为整个宿主窗口关闭，而后全部视图被清理。[S5][S8]

这不是 CEF 要求「所有嵌入视图必须一起关闭」。Windows 同版本的 client 已明确在非应用退出期间返回 true，以保留父窗口；只有应用真正退出时才允许默认父窗口关闭流程。[S7]

可靠修复需要原生适配层区分「删除一个 browser」与「退出父窗口」，处理 `DoClose`、实际子视图销毁、`OnBeforeClose` 以及引用释放。只增加 `DoClose=true` 或只在 JS 拒绝窗口关闭，不足以证明销毁完成：CEF 文档要求继续完成关闭，否则对象可能处于半关闭状态。验证必须同时证明目标 page 消失、兄弟 page 可操作、窗口存活、最后页面及最终应用退出不挂起，不能只数窗口数量。[S8]

OSR（windowless）是有依据的诊断对照：同版 CEF 明确其 `DoClose=false` 直接销毁 browser，不发送 windowed 父窗口关闭通知。但透明/OSR 的输入、弹窗、缩放、性能等需要重新验证；不能仅凭这一差异建议产品全面切换。[S5][S8]

## 统一为 Electron + Node Host 是否合理

**pi 的当前官方 npm SDK 原本就支持 Node。** 调查时 pi 提交 `7f06f9cf1626504cde95683f1c81a72a7bc7a0cb` 的 `@earendil-works/pi-coding-agent` 版本为 0.86.1，`engines.node` 是 `>=22.19.0`，导出 ESM SDK `dist/index.js`。它同时提供 Bun 编译独立二进制的脚本，这并不使 SDK 成为 Bun 专属。[S10]

Electron 官方 `utilityProcess.fork` 创建包含 Node.js 和 MessagePort 的子进程。因而可以保留当前设计的「桌面壳负责窗口；独立 Host 承载 pi、任务调度和受管执行」边界，只把 Host 运行时改成 Electron 随包 Node；无需为了统一运行时把领域工作塞进 UI 主进程，也不要求用户预装 Node。[S11]

这个方案消除额外 Bun 二进制、跨 Node/Bun 兼容性和两套运行时升级矩阵，但不是零改动：

- Electron 锁定版本的内置 Node 必须满足 pi 及依赖的 engines；ESM/资源路径、动态扩展、进程与终端能力、打包后依赖加载仍须实测。[S10][S11]
- `utilityProcess` 不提供普通 stdin 管道（文档要求 stdin 为 ignore），Host 通信宜用 MessagePort 或受控网络接口。如果另起 pi JSONL RPC 进程，需要独立设计其启动方式，不可把 utilityProcess 当作完全相同的 `child_process.fork`。[S11]
- 产品规格、CONTEXT.md 和技术栈文档当前把 Bun 写成既定 Host 运行时；采用 Node 需在选型确认后统一更新。此次源码复核不擅自改变这些决策。[S12]

结论应保留两条清晰候选：愿意承担明确、有限的原生补丁和双平台验证时，继续复核 **Electrobun + Bun Host**；若要求使用现成成熟桌面生命周期且统一服务端 JS 运行时，则评估 **Electron + Node Host**。当前证据没有理由强制选择 Electron + Bun Host。[S4–S8][S10–S12]

## 一手资料

- S1：[Electrobun v2.0.1 release](https://github.com/blackboardsh/electrobun/releases/tag/v2.0.1)。
- S2：[v2.0.1 与调查时 main 的比较](https://github.com/blackboardsh/electrobun/compare/8d09d15db791f346e419efd452d6759750addb62...8659d402dc526d89ce9638038331eb2d66a01dba)。
- S3：[Electrobun 固定 CEF 版本](https://github.com/blackboardsh/electrobun/blob/8d09d15db791f346e419efd452d6759750addb62/package/src/shared/cef-version.ts)。
- S4：[partition_context.h](https://github.com/blackboardsh/electrobun/blob/8d09d15db791f346e419efd452d6759750addb62/package/src/native/shared/partition_context.h)。
- S5：[macOS nativeWrapper.mm](https://github.com/blackboardsh/electrobun/blob/8d09d15db791f346e419efd452d6759750addb62/package/src/native/macos/nativeWrapper.mm#L4926)：实际 client 4926、生命周期 handler 5633、context/创建 6575–6683、remove 6794–6859。
- S6：[CEF d58e84d browser_host_create.cc](https://github.com/chromiumembedded/cef/blob/d58e84d/libcef/browser/browser_host_create.cc#L80)：异步等待 90–100、同步检查 128–132；[request context handler](https://github.com/chromiumembedded/cef/blob/d58e84d/include/cef_request_context_handler.h)。
- S7：[Electrobun Windows nativeWrapper.cpp](https://github.com/blackboardsh/electrobun/blob/8d09d15db791f346e419efd452d6759750addb62/package/src/native/win/nativeWrapper.cpp#L898)：DoClose 898–915、异步建页 8384。
- S8：[CEF d58e84d CefLifeSpanHandler](https://github.com/chromiumembedded/cef/blob/d58e84d/include/cef_life_span_handler.h#L173)：父窗口关闭行为 189–209、默认返回 false 277。
- S9：[Electrobun #380](https://github.com/blackboardsh/electrobun/issues/380)、[#466](https://github.com/blackboardsh/electrobun/issues/466)。上游报告属于相关背景，不是本次问题已被官方确认的声明。
- S10：[pi coding-agent package.json](https://github.com/earendil-works/pi/blob/7f06f9cf1626504cde95683f1c81a72a7bc7a0cb/packages/coding-agent/package.json)。
- S11：[Electron utilityProcess 官方文档固定快照](https://github.com/electron/electron/blob/08c729bdf3c1e02a6f34113f0a869ad0efa04530/docs/api/utility-process.md)。
- S12：[当前首版规格](../.scratch/pidock-mvp/spec.md)、[技术栈设计](implementation-stack-design.md)、[领域术语](../CONTEXT.md)。
