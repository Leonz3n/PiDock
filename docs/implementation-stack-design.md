# 已确认技术栈与进程边界

2026-09-22 确认技术栈与进程边界。当前首版范围以 [父规格 #1](https://github.com/Leonz3n/PiDock/issues/1) 和 [2026-11-02 首版收口 #135](https://github.com/Leonz3n/PiDock/issues/135) 为准；旧迁移快照不作为冲突要求的执行依据。

## 当前首版范围（2026-11-02）

- 产品层级为 **项目 → 任务 → 会话**；任务工作区是文件与运行上下文，不增加顶层“工作空间”。
- 保留定时任务、Provider/MCP/Skills 的 UI 管理、真实 Agent 对话与必要文件/命令工具，以及会话归档、恢复、删除。
- **已有 Git/普通目录与任务独立 worktree 两种方式均须在首版交付。** 可先完成已有目录再做 worktree，但后者不是首版之后的计划。worktree 的创建、失败恢复、重开和清理仍须验收。
- 共享原目录不等于文件隔离；任务级执行协调与共享真实路径写协调仍保留，遵循 ADR 0003。
- 服务编排、环境模板、端口与协议绑定、内置浏览器及业务联调、独立文件/差异工作台、复杂报表、通用扩展安装管理延后。内置终端按 #95 撤销，远程和移动端按 #126 延后。
- 调度只在应用运行期间执行，关窗可后台运行，明确退出或休眠不执行、不补跑；同一任务未结束时跳过定时触发。每次触发新建独立会话，结果可继续聊。
- main / per-task Host / SDK worker / sandbox renderer 边界保留；生产接线、权限、持久化、取消及资源回收仍须真实验证。功能范围收缩不代表安装和发布门槛已通过。

下文保留完整技术设计。浏览器/CDP、服务、xterm/PTY、移动端及旧页面复刻的描述仅作历史设计或未来参考，不恢复为当前首版必做项；内置终端也不因保留旧设计而重新启用。此次同步规格，不恢复其他暂停实现工单。

## 技术栈

| 层 | 已确认选择 | 职责 |
| --- | --- | --- |
| 桌面 | Electron 44+ | 窗口、原生集成、Chromium 视图管理 |
| 本机运行时 | Electron 随包 Node 24 | main 与 utilityProcess 统一运行时 |
| 语言和 UI | TypeScript、React 19 | 沙箱中的工作台界面 |
| Agent | Pi AgentSession | 使用 @earendil-works/pi-coding-agent，在 Node utilityProcess 中运行 |
| Host 进程 | Electron utilityProcess | 每个任务工作区独立 Agent Host；一个工作区可含多个仓库 |
| 内置浏览器 | WebContentsView + Chrome DevTools Protocol | main 持有真实视图及 CDP 接入，Agent 通过受控接口调用 |
| 界面状态 | Zustand | UI 状态及 Host 数据的展示投影 |
| 长列表 | TanStack Virtual | 会话、日志等长列表渲染；小集合不强制虚拟化 |
| 持久化 | SQLite | 产品元数据、任务和会话索引；pi 原生会话正文保持单一事实来源 |
| 终端界面 | xterm.js | 渲染与输入；PTY 属于受管执行侧 |
| 代码展示 | Shiki | 片段与文件代码高亮；不承担可编辑代码组件职责 |
| 包管理与 workspace | pnpm | 统一依赖、锁文件及工作区包关系 |
| 开发任务编排 | Turborepo（turbo） | 开发、构建、类型检查、测试与 lint 的任务图和缓存 |

渲染层构建使用 Vite，本地开发使用 Node 24.21.0 + pnpm + Turborepo。视觉规范与已确定的 Tailwind 样式方案延续。pnpm/turbo 精确版本、SQLite/PTY 驱动和其余依赖补丁版本在实现时锁定。Git 首版优先 CLI，文件搜索使用 rg/受管子进程；业务仓库使用其自身工具链。

## 本地开发与 workspace 管理

2026-09-22 用户补充确认使用 **pnpm + Turborepo**。pnpm 负责依赖和 workspace，turbo 负责编排任务；Vite 继续承担 renderer 的开发服务器与构建。

- 根目录通过 `pnpm-workspace.yaml` 管理包关系，统一 `pnpm-lock.yaml`，根 package.json 的 `packageManager` 锁定 pnpm 精确版本；开发 Node 固定 24.21.0。具体 workspace 目录随实现划分，保持 main、renderer、Agent Host 与共享协议的边界，renderer 不能因共享包引入 Node 能力。
- 根目录提供 `pnpm dev`、`pnpm build`、`pnpm typecheck`、`pnpm test`、`pnpm lint` 入口，经 turbo 调度相应 workspace 任务。turbo 的依赖图与实际包依赖一致，构建输出和影响结果的输入/环境变量明确声明。
- 开发服务器、Electron 和 Host 的常驻开发任务设为 persistent 且不缓存；可重复的构建/检查任务按真实输出配置缓存。根开发命令退出或重启时清理本次启动的所属进程，不能遗留重复 Host。
- CI 使用同一 pnpm 版本和 `pnpm install --frozen-lockfile`，复用开发任务入口；Electron 安装器仍需独立验证运行依赖与资源完整性，不能依赖 workspace 链接在开发机上恰好可用。
- 此要求仅适用于 PiDock 自身开发；用户业务仓库保留自己的包管理器和构建方式。pnpm/turbo 属于开发工具，不进入产品的 Agent 执行协议或代替 Electron utilityProcess。

该要求纳入既有工单：20 建立 workspace/任务入口及 renderer 基线，02 接入 main/Agent Host 的构建与启动，15 验证 CI 和分发。当前仅更新要求，不开始安装或改造现有未完成 worktree。

## 版本契约

Electron 自带 Node，不能将两者独立升级。2026-09-22 官方 npm latest 为 **44.4.3**；其固定版本 [DEPS](https://github.com/electron/electron/blob/v44.4.3/DEPS) 声明 **Node 24.21.0**、Chromium **152.0.7977.130**。这证明用户指定组合有可选版本，不代表已安装或通过 PiDock 验收。

首个实现应锁定经过验证的 44.x 补丁版；44+ 不写成无限制依赖范围。后续主版本升级须核对内置 Node、pi engines、SQLite/PTY 等原生依赖，以及两平台安装包。记录 main 和 utilityProcess 的实际 process.versions。

## Pi 1.4 接入约束（2026-11-02）

Pi 直接依赖同步精确固定为 `@earendil-works/pi-coding-agent@1.4.0` 与 `@earendil-works/pi-ai@1.4.0`，随项目 lockfile 分发。完整依据与验证见 [Pi 更新适配报告](pi-1.4-upgrade-review.md)；本节覆盖旧 Pi 调研中与其冲突的技术假设。

- 保持 main / 每任务 Agent Host / 隔离 SDK 模型 worker / sandbox renderer 的现有边界。Pi 的 TUI、终端状态报告与全局 CLI 更新不进入 PiDock 产品界面；按 #95 已撤销的内置终端不因上游变化恢复。
- MCP 协议接入优先复用 Pi 原生扩展，撤销自建 MCP bridge 的旧方案。SDK 需要显式装配扩展并绑定会话生命周期；当前生产仍使用空资源 loader 与 Host 受管工具集合，未自动启用 MCP、codemode 或第三方扩展。
- 继续核对全部注册工具与活跃工具。以后启用 deferred/codemode 时，嵌套调用也必须经过同一权限门禁、任务协调和资源回收；不能仅依赖顶层工具名过滤。
- 以 `agent_settled` / `waitForIdle` 作为运行结束边界，采纳 `aborted` 标志区分取消。最终 `length` 回复保留文本与 usage，但回合标为 `sdk-output-truncated`，不自动重放。
- Pi JSONL 继续承载会话树与模型上下文，PiDock 承载绑定、ACK、幂等与展示投影；SDK 新增的模型、工具内调用和摘要 usage 不自动等同于已接通 PiDock 账本。
- Pi 1.2 已删除旧实验 server/client/plugin，未来远程接入仍须走 PiDock 领域 API 与设备授权。远程访问已按 #126 移出首版，本次升级不恢复桌面入口与 `task/remote*` 通道；SDK/stdio RPC 只作为本机适配边界。

## 固定进程边界

**AgentSession 放 Node utility process，Chromium/CDP 管理留 Electron main，React renderer 完全 sandbox。** Chromium 网页本身在 Chromium 渲染子进程运行；main 管的是视图/session 生命周期和调试连接。

1. **Electron main**：拥有窗口、WebContentsView、session 分区、CDP 连接和 Agent Host 生命周期；提供按任务/页面限定的浏览器操作接口，协调权限、资源归属和 Host 路由。
2. **Node utilityProcess**：每个任务工作区独立运行 Agent Host，承载 pi AgentSession、工具执行及取消/恢复。经受控 RPC 请求 main 操作任务浏览器；不直接持有 webContents，不绕过统一审批与执行协调。
3. **React renderer**：仅负责界面与交互，显式 sandbox:true、contextIsolation:true、nodeIntegration:false。通过最小 preload/contextBridge 请求能力；不直接访问 Node、SQLite、PTY、文件系统或 CDP。
4. **任务网页 renderer**：独立信任范围，启用沙箱且关闭 Node 集成，不加载产品 UI 的本机能力桥。任务网站脚本和人工标记数据均按外部输入处理。

IPC 使用自定义 typed RPC，main↔Host 可使用 MessagePort；renderer 只调用窄接口，不暴露原始 ipcRenderer、任意 channel 或任意 CDP 方法。必须做运行时数据校验、发送方/任务/页面归属校验，并有错误、取消、事件订阅及进程退出后在途请求处理。TypeScript 不能替代运行时校验；进程隔离也不等于将 Agent shell 置于操作系统沙箱。

## Main 与 Agent Process 的内部结构

用户确认的模块结构如下；Agent Process 按既定「任务工作区 → 独立 Agent Host」边界创建，进程内可容纳多个 Pi AgentSession。

```text
Electron Main
├── WindowManager
├── BrowserManager
├── CDP Controller
├── IPC Router
└── Agent Process（每任务工作区一个 Node utilityProcess）
    ├── Pi AgentSession A
    ├── Pi AgentSession B
    ├── Pi AgentSession C
    ├── Git
    ├── rg
    ├── filesystem
    └── terminal / PTY

React Renderer（sandbox）
├── 工作台 / Zustand / TanStack Virtual
├── 代码展示 / Shiki
└── 终端界面 / xterm.js
```

| 模块 | 归属与职责 |
| --- | --- |
| WindowManager | main；自有窗口、工作台布局与窗口生命周期 |
| BrowserManager | main；任务到页面/分区的映射，创建/关闭/恢复 WebContentsView 及弹窗 |
| CDP Controller | main；针对 BrowserManager 持有的页面管理调试连接、操作、取证、detach 与句柄失效 |
| IPC Router | main；限定 typed RPC 方法，校验发送方与任务/会话/页面身份，路由请求及事件 |
| Agent Process | utilityProcess；管理工作区内的 AgentSession、Git/rg/文件/终端工具及其取消和资源清理 |

多个会话共享该工作区工具服务，但请求始终携带会话身份与权限；不能因为在同一进程就共享执行授权。有副作用的工具遵循任务写操作权，UI 和 Agent 不能各自启动一条绕过协调的终端/文件写入路径。跨任务继续使用独立 Agent Process；图中的 A/B/C 不代表把所有任务装进同一全局进程。

浏览器工具路径为 AgentSession → typed RPC → IPC Router → BrowserManager/CDP Controller → 对应 webContents。浏览器事件与证据返回原任务/会话。终端 shell/PTY 在 Agent Process 侧管理，输出与输入通过受控接口连接 renderer 的 xterm.js；renderer 不创建本机终端进程。

本机已验证 nvm 中的 Node **24.21.0** 可执行，作为开发环境基线。开发机 nvm 不进入产品分发路径；安装后的 main/utilityProcess 使用 Electron 自带 Node。此处仅记录环境与结构，不修改全局 Node 默认版本。

## Agent 浏览器与人工反馈（未来范围）

Agent 可自行创建、打开、导航、重载、关闭和恢复任务页面，读取 DOM/布局及截图，对照设计要求并排查 Bug。用户主要查看，点选元素或框选区域、附说明发送给当前任务 Agent；标记附页面身份、URL、截图和能取得的元素信息。页面变化后需重新定位，不能复用过期坐标。

main 通过实际 WebContentsView.webContents 的 debugger/CDP 获取语义操作、等待、截图、console/异常及网络证据；默认优先进程内调试连接，避免另开常驻 TCP 调试端口。工具输出有界并绑定任务、页面和运行记录。人看到、标记和 Agent 操作的是同一页面实例。

session.fromPartition('persist:…') 按任务分配，同任务标签页和登录弹窗共享、跨任务隔离。关闭页面不清除登录状态。关闭/重建视图、DevTools detach、iframe、弹窗、下载和重启恢复必须实测。Electron 提供基础接口，设计判断、语义操作适配及标记闭环仍由 PiDock 实现。

## 状态与持久化

Zustand 负责导航、面板、输入草稿等 UI 状态以及经 Host 确认的数据投影；renderer 不调度任务、不判断最终权限、不维护第二套写锁。事件按会话身份与顺序更新，断线后获取快照或续接；不因组件重挂载自动重试有副作用的操作。

TanStack 只确认 Virtual。删除全家桶优先覆盖的约束，不默认要求 Router、Query、Table、Form 或 Store。额外组件应由实际需求说明理由。

SQLite 保存产品状态及索引，pi 会话正文先保留 SDK 原生持久化，避免两个独立可写真相源。驱动、迁移、写入归属和崩溃恢复在实现时固定；多个 Agent Host 不能未经设计各自争写全局权威数据。

## UI 设计与实现边界

[PiDock.pen](design/PiDock.pen) 是唯一的 UI 设计基准，画板索引和关键交互见 [设计说明](design/README.md)。旧 HTML 原型、候选设计及其交付包已移除；历史截图只记录当时的实现，不能作为新界面要求。

现有 React 19 / TypeScript / Zustand / TanStack Virtual 渲染层可以继续演进。可复用展示组件与领域适配，但布局、导航、控件位置及日夜主题需对照 Pencil 设计调整。颜色采用配套 [appearance.tokens.json](design/appearance.tokens.json)，不沿用旧候选的 tokens；不使用绿色，π 居中。

模拟数据和模拟执行集中在可替换的适配层，不散布到组件中成为生产业务逻辑。正式桌面路径连接真实 Host，未接入功能按真实状态呈现。UI 状态由 renderer 管理，Git、配置读写、调度与权限执行沿用既有 Host 边界。

验收覆盖 1440×900 和 720×560、日间 / 夜间模式、中文输入法、键盘与焦点、浮层遮挡、滚动及草稿保留。TanStack Virtual 只提供列表虚拟化能力；长列表按实际规模验证。设计稿检查不能替代真实桌面集成或双平台安装验收。

本次清理设计资料不启动产品实现；功能范围及执行安排继续以 GitHub #1、#24、#135 的最新说明为入口。移动端属于独立布局范围，不直接缩小桌面画板。

## 验证入口与来源

- 工单 20：React 19/TypeScript/Zustand/TanStack Virtual/Shiki 的正式渲染层基线；保留该 worktree 的现有未提交内容，恢复时按新设计调整。
- 工单 21：Electron + Node 版本、utilityProcess/沙箱边界、可见页面控制/隔离/生命周期及标记取证的技术验证。
- 工单 02：Pi AgentSession 在 utilityProcess 中接入真实任务、基础权限和恢复。
- 工单 06：Agent 自主管理浏览器、设计检查/Bug 证据和人工标记反馈闭环。
- 工单 15：完整 Electron/Host/原生依赖资源的双平台签名、安装和发布验收。

工单依赖与验收约束已更新，**均不代表现在启动实现**。

官方依据：[Electron 44.4.3 DEPS](https://github.com/electron/electron/blob/v44.4.3/DEPS)、[utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process)、[sandbox](https://www.electronjs.org/docs/latest/tutorial/sandbox)、[contextIsolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation)、[WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view)、[Debugger](https://www.electronjs.org/docs/latest/api/debugger)。历史取舍见[Electron + Node 适配判断](electron-node-fit-review.md)及 Electrobun/WebviewJS 复核报告。
