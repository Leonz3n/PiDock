# 可见页面控制与桌面壳验证

验证日期：2026-09-21。工单：[01 可见页面控制与桌面壳技术验证](https://github.com/Leonz3n/PiDock/issues/2)。

抛弃式原型、原始证据与可重复脚本**未合入产品基线**，保留在分支 `codex/01-visible-browser` 的 `prototypes/visible-browser/` 下。下文中的证据与脚本路径都指该分支；本文只把验证结论和受影响设计带回主线。

> **2026-09-22 复核更正：** 原始失败已复现，但「Electrobun + Bun 不可行并自动回退 Electron + Bun」的推论撤回。相同版本的 OSR 配置已通过 10 次关闭/重开及原有自动化场景；分区初始化仍待可靠修复。后续工单暂停，架构待确认；详见[运行时复核](electrobun-runtime-recheck.md)。下文保留首次实验及其历史决策，不作为继续执行的选型指令。

## 原始决策（已被上方复核收窄）

**Electrobun 2.0.1 + Bun 主进程 + CEF 不通过 PiDock 的桌面集成关卡；后续产品实现回退到 Electron + Bun Host，并复用本原型的同一验收场景。**

直接 CDP 控制可见 CEF 页面这一部分成立：语义定位、等待、截图、console、失败请求、iframe、分区隔离、重启持久化和 DevTools 后继续控制均已实测。但两个页面生命周期缺陷触发决策关卡：

1. 新持久 partition 的首个 CEF `BrowserView` 稳定返回 null。只有先创建一个预热 view、等待约 500ms，再创建正式 view 才能得到四个 target；SDK 没有 request-context ready 屏障。
2. 在主窗口对一个 CEF `BrowserView.remove()` 会清理同窗全部 CEF 视图并令应用/CDP 退出。因此“关闭一个任务不影响另一个、关闭后重开”失败。独立探针确认关闭登录 `BrowserWindow` 本身正常：popup target 消失，四个主任务 target 保留。

这些不是业务适配层可可靠隐藏的边缘行为，而是首版标签关闭、任务切换和弹窗生命周期的核心路径。Electron 回退设计受影响处是桌面窗口和可见页面适配器；Bun Host、任务/页面句柄、partition 命名、控制协议和 React 界面边界保持不变。Electron 侧必须用 `WebContentsView`、`session.fromPartition()` 和 `webContents.debugger` 重跑本报告场景，不能把文档能力当通过。

## 实际组合

- 构建配置显式为 `build.mainProcess: "bun"`；控制面 `renderer: "native"`，任务页 `renderer: "cef"`，CEF 随包分发。
- 构建机：macOS arm64；主机 Bun 1.4.2，Hutch 0.24.3，Electrobun 2.0.1。
- 打包后的主进程是 arm64 Mach-O `Contents/MacOS/bun`；运行日志报告 **Bun 1.4.0**。这说明构建机 Bun 版本不等于 Electrobun 随包运行时版本。
- CEF/Chrome 147.0.7727.118，CDP Protocol 1.3。
- 同一 1200x840 窗口顶部为系统 WKWebView 控制面，下方四个可见 CEF `BrowserView`。A/B 各有 primary/secondary 页面句柄。
- Task A 使用 `persist:pidock-probe-task-a`，Task B 使用 `persist:pidock-probe-task-b`；任意业务页面均设置 `sandbox: true`。

`BrowserView.executeJavascript()` 不返回求值结果，无法承载定位结果、等待和断言。本原型直接连接可见 CEF 页自身的 `webSocketDebuggerUrl`，用 `Runtime.evaluate`、DOM 可访问标签查询、轮询等待、`Page.captureScreenshot`、`Runtime.consoleAPICalled` 和 `Network.responseReceived`。没有启动隐藏浏览器，也没有用系统 webview 的成功替代任务页。

## 验证结果

| 行为 | 结果 | 证据/边界 |
| --- | --- | --- |
| 四个可见任务页与系统控制面共存 | 通过但需规避 | CDP 只列出四个 `task=` CEF target，不包含 `views://control`；首次 partition view 失败，需预热 + 500ms 延迟。 |
| 语义登录与异步等待 | 通过 | 按 `<label>` 找输入和按钮；等待页面状态和异步文本。 |
| 同任务共享、任务间隔离 | 通过 | A 两页共享 Cookie/localStorage，B 两页共享另一值，A/B 不覆盖。 |
| 重启持久化 | 通过 | 杀掉应用后重启，四页分别恢复 `task-a-popup` / `task-b`。 |
| 登录弹窗 | 通过 | `new-window-open` 由主进程建立复用 A partition 的可见 CEF popup；登录通过 `storage` 事件回到原页。独立关闭后 popup target 为 0，四个任务 target 保持为 4。 |
| 人工暂停/恢复 | 通过 | pause 后控制器拒绝下一语义操作；人工改输入值；resume 后重新读取页面得到 `manual-user-edit`。 |
| iframe | 通过 | 同源 iframe 内按钮和 DOM 结果通过同一可见 target 操作。 |
| 下载 | 部分通过 | 点击真实 attachment 链接，站点计数确认请求到达；CEF CDP 未发出该 attachment 的 `Network.responseReceived`，且未核验最终落盘文件。 |
| DevTools | 通过 | 调用 CEF view 的 `toggleDevTools()` 后，原 CDP session 仍可读取页面标题。 |
| 关闭/重开单页 | **失败** | `BrowserView.remove()` 后 9222 拒绝连接，另一个任务也消失；不能执行原位重开。HTTP close 请求返回 200 后复现。 |
| console 与失败请求 | 通过 | 有界记录预期 console error 和 `/api/failure` HTTP 503。 |
| 截图 | 通过 | 两个任务的 PNG 均由对应可见 target 的 `Page.captureScreenshot` 生成。 |

机器可读结果（分支 `codex/01-visible-browser`，下同）：`prototypes/visible-browser/evidence/logs/cdp-validation.json`、`restart-validation.json`、`partition-init-probe.json`、`popup-close-probe.json`、`close-probe.json`、`runtime-measurements.json`。截图：`prototypes/visible-browser/evidence/screenshots/task-a.png`、`task-b.png`。两个关闭探针记录 HTTP 状态、关闭后的 CDP 可达性和 CEF cleanup 数量；partition 探针记录两次 `CreateBrowserSync returned null`。原始 `.log` 是 demo 每次重建的本地诊断产物，不提交以避免无界噪声。

## 应用包体积与启动

同机实际 development `.app` 测量：

| 构建 | 解包体积 | 三次启动标记 |
| --- | ---: | --- |
| Electrobun 2.0.1、Bun 主进程、native-only 临时对照 | 67,960 KiB（66.4 MiB） | WKWebView `loadHTMLString completed`：322 / 320 / 321ms |
| 本原型，捆绑 CEF | 378,416 KiB（369.5 MiB） | 四个任务 CDP target ready：982 / 1313 / 976ms |

CEF framework 单项为 305,776 KiB（298.6 MiB），其余 helper/资源也包含在完整差值中。两种启动标记含义不同，数据用于工程量级判断，不声称是严格 UI 首帧 benchmark；也不是压缩 DMG 或安装器体积。因此工单中的“安装包体积”组合项保持部分完成。

## 调试监听面

开发构建新增两个 loopback listener：`127.0.0.1:4319` 为受控站点/原型控制 API，`127.0.0.1:9222` 为 CEF CDP。实测未出现对应的非 loopback listener。9222 可读取页面、Cookie、页面内容并执行脚本，属于高权限本机接口；产品中不得常开。若 Electron 方案需要调试证据，应使用进程内 `webContents.debugger`，避免开放 TCP；确需端口时必须随机化、只绑定 loopback、限制生命周期并阻止其他本机进程越权连接。

## 平台与分发

macOS arm64 只实测了未签名 development `.app`：`build/dev-macos-arm64/PiDock Visible Browser Probe-dev.app`。未产出、未安装、未签名 DMG，不能勾发布通过。Electrobun 原路线的正式路径是 stable 构建产出 DMG，对 app 内 Bun、CEF framework 和 helper 完整 codesign，使用 Apple Developer ID notarize 并 staple；本次因运行时路线失败而停止在发布前。

Windows x64 **未实测**，没有构建、安装、CEF、WebView2、持久分区或签名通过结论。Electrobun 2.0.1 默认 `Setup.zip`（setup EXE 加相邻隐藏 payload）不能当单一 EXE 交付，也不能只抽出 setup EXE。回退后的候选路径是 electron-builder NSIS 单一安装 EXE，将 Bun Host 可执行文件作为资源打包，在 Windows runner 上 Authenticode 签名并用 `Get-AuthenticodeSignature`、安装/卸载/升级和离线 payload 检查验收。macOS 回退路径相应为 Electron DMG、嵌套 Bun Host 全量签名、公证和 staple。实际发布验收仍归工单 15。

## 重现

在 `codex/01-visible-browser` 分支、macOS arm64 执行：

```bash
cd prototypes/visible-browser
bash scripts/demo.sh
```

脚本先测试和构建，再执行初始 CDP 场景、登录弹窗独立关闭、应用重启持久化场景，最后执行预期失败的单 view 关闭探针。完整先决条件和手工观察命令见原型 README。当前环境的 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` 会代理 localhost，脚本已显式清除；遗漏这一点会得到与框架无关的连接失败。
