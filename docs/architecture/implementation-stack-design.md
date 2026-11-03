# 已确认技术栈与进程边界

当前功能规格与验收见 [#135](https://github.com/Leonz3n/PiDock/issues/135)，工单入口见 [#1](https://github.com/Leonz3n/PiDock/issues/1)，界面以 [Pencil](../design/README.md) 为准。现有代码、依赖和历史验证不表示已完成新版交付；当前仅整理文档与工单，产品实现仍暂停。

## 产品与配置边界

工作空间 → 任务 → 会话是三个管理层级。工作空间保存可复用 Git / 普通目录来源、环境变量及分支约定；任务选择来源并保存实际目录与基线，Git 默认自动准备独立 worktree，已有 Git 目录模式仍在首版。普通目录与显式使用的已有工作目录访问原文件。工作空间变量默认继承，任务可覆盖，私有凭据与共享值分开。

首版还包含真实 Agent 对话、必要文件 / 命令工具、Provider / MCP / Skills 的 UI 管理、定时任务、会话与任务生命周期，以及日间 / 夜间 / 跟随系统外观。旧文档中的 Project 对应当前工作空间管理单元；实现中的 `Project ID`、`projectId`、注册表和磁盘格式保留既有身份语义，文档术语校准不意味着已迁移数据或重命名代码接口。

能力管理与应用设置的归属和首版入口见 [设计约定](../design/README.md#当前设计约定)。Pi Agent 原生配置保持单一写入来源，PiDock 保存自己的外观与界面语言等应用偏好；MCP 依赖扩展装配不等于提供 Extensions 用户管理。实现时对照固定 SDK 版本核实配置格式、路径、装配和重载能力；画板示例不是 API 契约，保存文件不等于运行时已加载。

工作空间变量继承不恢复按环境组织的服务模板、依赖图、端口分配或编排。内置浏览器 / 页面标记、业务联调、独立文件 / 差异工作台、复杂用量报表、远程与移动端延后；内置终端按 #95 撤销。Git 分支规范提供命名与推送目标，实际提交 / 推送 / PR 由明确操作触发并显示目标，不因任务完成而隐式推送。

## 技术栈与版本

| 层 | 已确认选择与职责 |
| --- | --- |
| 桌面 | Electron 44.x；窗口、原生集成、Host 生命周期与受控桥接 |
| 本机运行时 | Electron 随包 Node 24；用户无需额外安装 Node / Bun |
| Agent | Pi AgentSession；目标同步精确固定 `pi-coding-agent@1.5.0` 和 `pi-ai@1.5.0`，当前清单与 lockfile 仍为 1.4.0；实际升级归 #134 |
| Host | 每任务工作区独立 Node utilityProcess；隔离模型 worker 承载 SDK 执行 |
| Renderer | React 19 / TypeScript / Vite；sandbox、contextIsolation，关闭 Node 集成 |
| 界面状态 | Zustand；仅管理 UI 与 Host 数据投影 |
| 长列表 / 代码展示 | TanStack Virtual / Shiki；按实际数据规模使用，不默认引入其他 TanStack 库 |
| 持久化 | SQLite 保存产品元数据和索引；Pi 原生会话正文保持单一事实来源 |
| 工具链 | Node 24.21.0、pnpm、Turborepo；精确依赖以 package.json / lockfile 为准 |

仓库历史验证使用 Electron 44.4.3，其 [DEPS](https://github.com/electron/electron/blob/v44.4.3/DEPS) 包含 Node 24.21.0。Electron 与随包 Node 作为整体升级；升级需重核 SDK engines、原生依赖与两平台安装包。开发机 nvm 不进入产品分发。历史浏览器使用 WebContentsView / CDP，终端使用 xterm.js / PTY；保留的实现不恢复其首版产品范围。

## 进程与权限

```text
Electron main
├── 窗口、工作空间注册表、任务发现与身份核验
├── 最小 typed IPC 路由与权限 / 资源归属协调
└── 每任务工作区一个 Node utilityProcess（Agent Host）
    ├── 多个会话的状态与执行协调
    ├── 隔离 SDK 模型 worker → Pi AgentSession
    └── Host 受管 Git / rg / 文件 / 命令工具

React renderer（sandbox）
└── 工作空间 / 任务 / 会话 / 设置与状态投影
```

main 管理原生资源和任务 Host；Host 持有任务范围、工具执行、取消和资源回收。SDK worker 声明工具，真实效果通过 Host 受管边界执行，不在 renderer 执行本机操作。一个任务可含多个仓库，多个会话仍共享任务执行协调；不同任务使用独立 Host。

renderer 使用 `sandbox:true`、`contextIsolation:true`、`nodeIntegration:false`，通过最小 preload / contextBridge 请求能力，不直接访问 Node、SQLite、文件系统或任意 IPC channel。main ↔ Host 可使用 MessagePort / typed RPC；所有跨进程数据进行运行时校验，并校验发送方、任务、会话与资源身份。需处理取消、事件顺序、进程退出后的在途请求和具名错误。TypeScript 与进程分离都不等同于 Agent shell 的操作系统沙箱。

有副作用操作遵循任务写操作权；共享 / 重叠真实目标还遵循 [ADR 0003](../adr/0003-shared-directory-write-coordination.md) 的真实路径协调，尤其不能把每进程一张表视为已实现跨 Host 协调。外部编辑器写入按 [ADR 0006](../adr/0006-external-editor-writes-exempt-from-coordination.md) 豁免。

定时任务只在应用运行期间调度，关窗可后台运行，明确退出 / 休眠不执行、不补跑。同任务已有未结束执行时跳过，每次触发创建独立会话，沿用固定任务工作区。退出先中止 Agent，再回收所属子进程和 SDK；恢复不重放副作用。既有归档按 #117 的已交付口径只停止 Agent 回合，不把历史服务 / 终端进程伪装成已停止；清理与明确退出分别执行资源回收。

## Pi 1.5 目标基线与接入

本轮仅调整设计与工单，实际依赖仍为 1.4.0。1.5 的破坏性变更、设计差额和验收分配见 [Pi 1.5 升级设计](pi-1.5-upgrade-design.md)，升级由 [#134](https://github.com/Leonz3n/PiDock/issues/134) 承接并阻塞 #138 及其 SDK 下游。1.4 已交付证据保留在 [历史适配报告](pi-1.4-upgrade-review.md)。

- 工具参数使用 pi-schema 的 JSON Schema 校验与转换；Host 保留严格语义校验，审批、指纹与执行绑定同一份实际参数。普通 SDK 不依赖扩展 loader 的 TypeBox 兼容别名。
- 模型与推理档位按 1.5 实际能力提供，显式选择不被上游新默认覆盖。保留请求／响应模型与费用来源；展示费用时区分实报总额、估算及未知。
- MCP 使用 stdio／Streamable HTTP，保留原生 OAuth 注册模式和凭据归属；首版显式配置 direct 受管工具子集，不自动引入 codemode。项目资源信任不等同于工作空间登记。
- 升级核验会话写失败、命令取消／截断／UTF-8、Windows 路径去重和真实 renderer 流式负载；上游 TUI 或 pi.exec 修复不证明 PiDock 自有路径已经通过。

- MCP 优先复用 Pi 原生扩展，撤销自建协议 bridge 的旧依据。SDK 仍需显式装配扩展并绑定会话；已记录的生产空资源 loader 与 Host 受管工具集合不代表真实 MCP / Skills 已接通，恢复接入前核对实际代码。
- 核对注册工具与活跃工具；若启用 deferred / codemode，间接调用同样经过 Host 授权、凭据绑定、任务协调及资源回收。首版不要求启用 codemode 或虚拟模型。
- `agent_settled` / `waitForIdle` 表示运行结束，使用 `aborted` 区分取消；最终 `length` 保留文本 / usage，以 `sdk-output-truncated` 失败，不自动重放。
- Pi JSONL 保存会话树与模型上下文；PiDock 保存绑定、ACK、幂等与展示投影。SDK usage 不自动证明旧用量账本接通，完整报表延后，基本上下文与调用状态仍需准确。
- Pi 1.2 删除旧实验 server / client / plugin；本机 SDK / stdio RPC 不成为远程领域 API。#126 撤销的远程入口及 `task/remote*` 通道保持原控制。

## 状态与持久化

Zustand 管理导航、面板、输入草稿和 Host 确认后的数据投影，不调度任务、不持有最终权限或第二套写锁。事件按会话身份与顺序应用，断线后取快照或续接；组件重挂载不自动重试有副作用操作。

Pi 原生正文与 PiDock 索引分别保持单一写入归属，多个 Host 不未经设计争写全局数据。工作空间身份与任务归属沿用 [ADR 0001](../adr/0001-local-project-registry.md)，缺失 / 损坏明确报错，不能合成身份或回落演示夹具。草稿经 Host 保存文字与引用来源，恢复需核验来源；旧 localStorage 草稿迁移边界见 #117 / #133，不声称已自动迁移。

## UI 与工程验收

布局、导航、控件位置、日夜主题按 [Pencil 设计说明](../design/README.md)，颜色采用 [主题数据](../design/appearance.tokens.json)。现有 renderer 可复用组件与领域适配；旧 HTML 原型、旧 tokens、历史截图及已关闭 UI 切片不构成新版实现要求。

正式桌面使用真实 Host；模拟数据集中于可替换的演示 / 测试适配层。未接入能力显示实际状态，不用样例或静态成功状态冒充完成。覆盖双尺寸、两种主题与系统跟随、键盘焦点、中文输入法、浮层 / 滚动和草稿保留；验证场景见 [首版验证计划](../mvp-validation-plan.md)。

pnpm 管理唯一 workspace / lockfile，turbo 编排 dev / build / typecheck / test / lint，Vite 构建 renderer。常驻开发任务 persistent 且不缓存，可重复检查声明真实输入 / 输出；退出清理所属开发进程。CI 使用相同固定版本与 frozen-lockfile，安装包脱离 workspace 链接验证依赖完整。业务仓库保留自己的工具链。

Windows 内部未签名 MSI 剩余验收见 #22；对外签名、公证、Release 与 macOS 分发门槛见 #80，继续暂缓。历史运行时 / 浏览器 / 终端完整设计通过 [Git 历史](https://github.com/Leonz3n/PiDock/blob/3ae10dd9b1133b32068cf563424554861a56407e/docs/implementation-stack-design.md) 追溯，不能据其旧验证顺序恢复暂停功能。
