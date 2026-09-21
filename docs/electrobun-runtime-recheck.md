# Electrobun + Bun 路线复核

> **2026-09-22 最终选型已确认：** Electron 44+ / Node 24；AgentSession 在 utilityProcess，Chromium 视图与 CDP 管理在 main，React renderer 完全 sandbox。当前权威约束见[技术栈设计](implementation-stack-design.md)。本文保留调研/取舍过程，其中旧候选、回退或待确认文字不再作为执行指令；后续工单仍暂停。

2026-09-22。按用户要求只复核工单 01，不推进 20、21 或其他后续工单。本次不冻结新架构，不修改 Host 实现。

## 结论

**不能认定 Electrobun + Bun Host 不可行。原始失败属实，但上一轮从「默认路径未通过」直接转为「必须回退 Electron + Bun Host」，结论过强。**

同一 Electrobun 2.0.1 / Bun 1.4.0 / CEF 147 的 macOS arm64 原型，仅将主窗口设为 `transparent: true`，就能绕过单页关闭带走整窗的问题；原有自动化场景及 10 次关闭/重开验证通过。该设置在框架内部启用 CEF OSR（windowless/off-screen rendering），页面仍绘制在用户窗口里，CDP 控制的是这一个实际视图，不是另开隐藏浏览器。

这证明存在可行路径，**不代表生产方案已通过**。首次分区初始化仍依赖原型预热与 500ms 延迟；OSR 的真实鼠标/键盘/中文输入法、焦点、浮层、缩放、性能及 Windows 尚未验收。原生修复方向有源码依据，但本次没有编译修复后的框架。

建议保留两个候选：

1. **Electrobun + Bun Host**：需要接受原生生命周期修复或 OSR 适配的维护成本，并补齐分区就绪处理与双平台验证。
2. **Electron + Node Host**：若不希望维护桌面框架补丁，优先采用此统一运行时回退。pi 官方 SDK 支持 Node，不存在为 pi 必须额外保留 Bun 的理由。

**Electron + Bun Host 不再作为自动执行的既定回退。** 主线此前写入的回退文字暂作历史决策，等待选型确认后统一修订；本次没有启动替代方案实现。

## 实测对照

复核在原型的独立临时副本执行，没有改动工单 01/20 的工作区。基础分支为 `codex/01-visible-browser` @ `c54d45e`。第一轮运行原始 `bash scripts/demo.sh`：6 项测试通过，原有 CDP/重启验证通过，同时再次观察到 2 个首次分区创建 null，单页关闭后 4 个 CEF view 被清理、CDP 不可达。

| 对照 | 改动 | 结果 | 能说明什么 |
| --- | --- | --- | --- |
| 原始默认 windowed 模式 | 无 | 关闭 A primary 后 CDP 断开，整窗退出 | 原报告的失败事实可复现 |
| 排除应用退出回调 | 仅去掉原型窗口 close 回调中的 site.stop/process.exit | 同样退出，并收到主窗口 close 事件 | 不是原型显式 process.exit 单独造成 |
| 拦截父窗关闭 | 在上一个对照上给 will-close 设置 allow:false | target 数量 4 → 3 → 4 | 证实父窗口关闭通知是关键链路；拒绝所有窗口关闭会破坏正常关窗，不能作为成品方案 |
| CEF OSR | 恢复原始代码，只给主窗口加 transparent:true | target 数量 4 → 3 → 4，进程存活 | 公开配置可绕过该关闭路径，无需改 Bun 或切 Electron |
| OSR 扩展回归 | 同一配置，复跑原有完整场景，再执行循环 | 10 次关闭/重开通过；兄弟 target ID 不变；各页可通过 CDP 读取正确隔离的 Cookie/localStorage | 不只是 CDP 端口还活着；其他真实页面及登录状态得到保留 |

OSR 完整场景包含语义填写、异步内容、同任务共享/跨任务隔离、登录弹窗与独立关闭、接管暂停/恢复、同源 iframe、console/失败请求、截图、DevTools 后继续控制、应用重启持久化。下载仍只验证请求发生，未验证最终文件落盘。人工操作在原型中是模拟输入，不等于实机鼠标/IME 验收。

循环检查还确认关闭的 target 消失、重开产生新 target、兄弟三个 target 保持原 ID；这没有测量长期原生资源泄漏，也没有覆盖 beforeunload 拒绝关闭、关闭最后标签后重建和系统正常退出。测试结束使用脚本终止原型进程，不能把清理成功当作正常退出验收。

## 两个故障的源码解释

详见带固定版本官方引用的[源码复核](electrobun-runtime-source-review.md)。

- **单页关闭变整窗关闭**：macOS 实际使用的 CEF client 没有覆盖 `DoClose`。该版本 CEF 在 windowed 模式下默认向顶层父窗口发送 `performClose:`；windowless 模式不走同一父窗关闭路径。源码与拦截父窗/切 OSR 两组对照一致。Windows 同版已有保留父窗口的处理，可参考，但还需完成 `OnBeforeClose` 和资源回收；不能只补一行 return true 就宣称修复。
- **首次持久分区创建 null**：框架创建新的 request context 后立即调用同步 `CreateBrowserSync`，未等待 context 就绪。该版本 CEF 的异步创建路径会等待初始化。可靠方向是异步创建/就绪回调及排队、取消处理；固定延迟预热仍不可靠。OSR 没有修复这一点。

调查时最新正式版本仍为 2.0.1，所查 main 也未修这两条 macOS 路径，因此不能建议「简单升级即可」。上述都是原生适配层问题，未发现它们由 Bun Host 引起的证据。

## 统一运行时的含义

Electron 主进程自带 Node，Host 可放在 `utilityProcess` 中继续保持独立进程和受控接口，避免把 pi、调度与服务管理塞进窗口主进程。这样不需要另外捆绑 Bun。需锁定满足 pi engines 的 Electron/Node 版本，再验证 SDK、扩展、终端与打包后加载；本次没有实测 Electron + Node。

“统一 Bun / Node”应指产品服务端 JavaScript 的运行时。浏览器仍有其 JavaScript 引擎；Electrobun v2 的构建工具还有 Cottontail。使用 Bun 作为包管理器与运行时统一是两个决定。

## 证据与复跑

- [机器可读结果](evidence/electrobun-recheck-2026-09-22/results.json)：各对照 target、原有 OSR CDP/持久化结果、10 轮关闭重开状态及分区/弹窗结果。
- [OSR 实验补丁](evidence/electrobun-recheck-2026-09-22/osr-recheck.patch)：相对原始抛弃式原型的透明窗口单项改动，以及回归脚本。只作复现附件，不是产品实现。
- 本机完整临时实验位于 `/tmp/pidock-electrobun-recheck`，可清理；复现不依赖保留该目录。

在具备原 README 所列 macOS arm64 / Bun / Hutch 离线缓存的环境中，将 `c54d45e` 的 `prototypes/visible-browser` 复制到独立实验目录（保持原工作区不动）。在该目录执行：

```sh
# 先复现原始失败
bash scripts/demo.sh
# 再应用本报告附件（替换为附件的绝对路径）
git apply /absolute/path/to/osr-recheck.patch
bash scripts/demo.sh
```

补丁后的脚本要求关闭后 CDP 仍可达，并以具体 target 身份和存储检查 10 轮；失败会非零退出。不要与其他使用 4319/9222 端口的程序同时运行。脚本退出后本次确认两端口无监听。
