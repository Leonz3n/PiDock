# Electron + Node 对当前需求的适配判断

> **2026-09-22 最终选型已确认：** Electron 44+ / Node 24；AgentSession 在 utilityProcess，Chromium 视图与 CDP 管理在 main，React renderer 完全 sandbox。当前权威约束见[技术栈设计](implementation-stack-design.md)。本文保留调研/取舍过程，其中旧候选、回退或待确认文字不再作为执行指令；后续工单仍暂停。

2026-09-22。用户进一步明确：内置浏览器主要由 Agent 自主管理和控制，用于检查页面是否符合设计、排查 Bug；人主要查看、标记问题并反馈，必要时处理登录。本文是选型建议，不是新的实现工单或验收结果。

## 建议

**推荐 Electron + Node，优先于为当前需求扩展 WebviewJS + Bun。** 核心原因是可编程浏览器能力和故障证据，而非用户是否需要完整浏览器界面。Agent 主导反而更依赖稳定的页面生命周期、定位、输入、截图、console 和网络事件。

| 需求 | Electron 提供的基础 |
| --- | --- |
| 创建、关闭、导航和管理内嵌页面 | WebContentsView 与关联 webContents；以业务页面句柄绑定任务，不能仅凭当前焦点路由工具 |
| Agent 控制人看到的同一页面 | 对该 webContents 使用 debugger/CDP；不用另起一个隐藏浏览器代表可见页 |
| 布局检查与设计核对 | 同页 DOM/布局数据、capturePage 或 CDP 截图；设计基准和 Agent 判断由产品层提供 |
| 排查 Bug | console 事件、CDP Runtime/Network 等取证；工具需订阅、限界、关联到任务/运行记录 |
| 点选/框选问题反馈 | 通过受控标记层获取选区，附页面身份、截图及可取得的元素信息；仍需自行实现 |
| 持久登录隔离 | session.fromPartition('persist:…')，同任务共享，跨任务分区；实际生命周期与弹窗行为仍需回归 |
| 统一 Host 运行时 | 主进程和 utilityProcess 使用 Electron 随包 Node，Host 保留独立进程；不额外捆绑 Bun |

WebviewJS 有 WKWebView/WebView2 原生基础，但当前绑定在 macOS 持久数据存储和浏览器级调试取证方面存在缺口。继续该路线意味着补充和维护平台适配。Electron 已经提供接入这些能力的接口，让 PiDock 更专注于 Agent 工具、页面归属和反馈闭环。此判断不等于声称 WebviewJS 技术上无法实现。

## 建议进程边界

- Electron 主进程：窗口、WebContentsView、分区、浏览器控制适配器、Host 生命周期与请求路由。
- React 渲染层：工作台、浏览器查看/标记、Zustand UI 状态；浏览器页面不获得 Node 权限。
- 任务工作区 Node Agent Host：通过 utilityProcess 承载 pi 与任务执行；由受控协议调用主进程的浏览器适配器。同一工作区可包含多个仓库，不能将 Host 粒度缩成一个 Git 仓库。
- SQLite：产品数据与会话索引；pi 会话持久化先沿用其原生能力。具体数据库写入权威和调度归属在设计收口时确定。

统一 Node 指产品运行时。可选择 npm/pnpm + Vite 统一开发工具链；如果保留 Bun 作包管理器，不意味着产品内再运行一个 Bun Host。用户业务仓库仍沿用自身工具链。

## 边界与当前状态

Electron 不自带「自动判断页面符合设计」的 Agent，也不自带问题标注闭环；它提供更完整的浏览器基础。包体积/内存与 Chromium 更新是采用它的代价。

锁定 Electron 版本时需核对其 Node 满足 pi engines，并验证 utilityProcess 内 SDK、扩展和原生依赖。DevTools 可导致 debugger detach，关闭/重载等也要使工具句柄正确失效；不能把官方接口存在当成场景已通过。

本次仍未运行 Electron 验收，也未推进 20/21/02。此前 WebviewJS 实验准备仅在临时目录安装了 0.4.6 包并复制源代码；尚未启动 GUI、没有实现原生补丁或获得新的运行结果。用户转向比较 Electron + Node 后，已停止原生依赖获取并收束实验。

## 依据

- [Electron WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view)
- [Electron WebContents](https://www.electronjs.org/docs/latest/api/web-contents)：capturePage、输入及 console 等接口。
- [Electron Debugger](https://www.electronjs.org/docs/latest/api/debugger)：同一 webContents 的协议接入与 detach 行为。
- [Electron Session](https://www.electronjs.org/docs/latest/api/session)：持久分区与会话。
- [Electron utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process)：Node 子进程、MessagePort 和打包集成边界。
- [pi 与统一 Node 的源码核对](electrobun-runtime-source-review.md)：pi 0.86.1 engines 与 SDK。
- [WebviewJS 0.4.6 源码核对](webviewjs-runtime-review.md)：具体平台接口缺口及已确认能力。
