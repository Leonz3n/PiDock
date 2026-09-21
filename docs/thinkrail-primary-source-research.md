# ThinkRail 一手来源调查与 PiDock 取舍

调查日期：2026-09-21。仅依据官方仓库、官网、发布页及依赖作者发布的包；未安装或实际运行 ThinkRail。本文将源码/规格中的能力、公开交付物和待验证体验分开，不以品牌背书推断稳定性。

## 决策结论

**高度相似，通用 pi 工作台值得优先用 ThinkRail 替代自建；当前证据不足以认定它能直接替代 PiDock 的多仓库、多服务本地验证闭环。建议暂停按现有完整清单投入生产实现，先验证现成 ThinkRail 加少量可维护扩展能否满足真实任务，再决定停止独立应用或收缩为运行环境工具。** 这是本次研究建议，未修改已确认规格、工单状态或技术选型。

相似性不仅在界面：两者都以 pi 为引擎，分离 Host 与 React 界面，使用 Bun、Electrobun、worktree 和多会话。ThinkRail 已有源码与发布物，PiDock 仍处于设计/内存模拟原型阶段。PiDock 规格更细，不能由此推导产品更成熟或差异已成立。[ThinkRail 架构](https://github.com/JetBrains/thinkrail/blob/282f5a1ab8adf47af081ae10a2b2a8fd1f2afb6d/architecture.md)、[PiDock 当前权威规格](../.scratch/pidock-mvp/spec.md)、[技术栈设计](implementation-stack-design.md)、[原型说明](../prototypes/pidock-ui/README.md)

若目的只是给 pi 配上好用的桌面界面、项目/worktree、聊天、文件和终端，继续从头造完整 PiDock 的收益已经很弱。若目的仍是消除每次手写配置、必须合并部署后才能验证的阻力，则问题尚未由 ThinkRail 当前公开产品直接解决。需要保留的是解决这一问题的能力，不必预先保留独立桌面应用这种形式。[PiDock 问题定义](../.scratch/pidock-mvp/spec.md#problem-statement)

## 与当前 PiDock 的逐项比较

本表中的 PiDock 一律指已确认设计目标，不代表已经实现；ThinkRail 的证据详情和链接见下文。

| 需求 | ThinkRail 当前公开证据 | 对 PiDock 的取舍 |
| --- | --- | --- |
| pi 对话、模型、skills、上下文与会话用量 | 有对应客户端/引擎集成 | 大面积重复，不宜作为继续自建的理由；具体 Provider 配置语义仍需实测 |
| worktree、文件、终端、并发会话、审阅 | 有源码、产品规格与发布物 | 优先复用现成产品；多会话并发不自动等于 PiDock 规定的任务写操作协调 |
| 一个任务同时管理多个仓库和普通目录 | 当前是单 repo project → 单 worktree workspace | 结构性差异；多开几个项目不能自动得到统一任务归属、创建/追加/回收语义 |
| 服务配方、环境选择、本地/远程依赖、任务端口 | 未发现对应服务领域模型与受管操作 | PiDock 最重要的待验证价值；终端能运行命令不等于已消除重复配置负担 |
| Agent 与用户共用可见业务页面、接管和任务登录隔离 | 未发现对应 browser panel/control；web access 是搜索/抓取 | 不能直接替代；外部可见浏览器加扩展可能满足实际需要，是否必须内嵌值得重新评估 |
| 协议仓库生成物绑定当前任务的消费者 | 未发现产品级编排 | 先考虑可复用脚本/工具，不能仅因此推导必须自建桌面壳 |
| 手机访问、设备权限、定时任务 | ThinkRail 远程/手机和 automations 仍列 V2；设备授权模型亦不同 | 暂不能按已交付替代；PiDock 自己同样未实现，不宜为这些外围需求提前铺开产品 |
| 跨项目/Provider 的完整 Token 明细统计 | ThinkRail 有会话 token/cost 展示，cost ledger 仍列 V2 | 有差异，但相比真实运行闭环不足以单独支撑完整重建 |

本地依据：[领域术语](../CONTEXT.md)、[首版规格](../.scratch/pidock-mvp/spec.md)、[真实业务用例](pilot-synchronous-query.md)、[协议与服务核对](pilot-repository-inspection.md)。技术栈采用 React/Tailwind 的重合不表示每一组件库相同，也不证明实现方式逐项相同。

## 推荐的验证与停止条件

以下是后续试用的具体决策门槛，本次没有安装软件、启动业务服务或连接业务环境。

**先验证一条真实链路，暂不复刻全套界面。** 使用已选定的 SaaS 对账单详情用例，涉及 `front-monorepo`、`invoice-service`、`shipment-service`、`apis`。首轮沿用消费者发布的协议依赖，协议生成和本地绑定单独验证，避免一次试用混入过多变量。[既有用例及验收](pilot-synchronous-query.md)

1. 在 ThinkRail 中建立两组涉及相同仓库的并行工作，记录哪些步骤由现成功能完成、哪些依赖外部工具、哪些只能反复手工处理。不能把多个独立 workspace 自动计作同一任务编排已通过。
2. 配置本地前端/BFF/invoice/shipment 与选定环境的远程依赖；检查第二组任务的端口和依赖地址不会串到第一组。共享数据库按现有规格接受，不宣称数据隔离。
3. 用户完成登录后，让 Agent 在用户可见、可接管的页面进入消费流水并打开对账单详情；保留网络请求和服务日志，证明请求经过本任务的本地 BFF/invoice/shipment。单纯抓取页面或只查接口不算完整通过。
4. 修改第一组任务中的代码并重新启动，验证页面反映该次修改，第二组任务仍使用自身代码；再检查会话恢复、服务关闭和工作区清理的实际操作成本。
5. 若缺口可由一组可版本管理的服务配方、独立工具和 pi extension 补齐，检查它们是否能复用到新任务，且不必持续修改 ThinkRail 的 workspace/协议/UI 核心。扩展能调用工具不表示它拥有任意添加面板的稳定插件接口。

| 验证结果 | 建议 |
| --- | --- |
| 原生能力或少量一次性配置即可完成日常闭环 | 停止独立 PiDock 应用开发，采用 ThinkRail；保留已有研究与业务配方 |
| 需要一层独立、可复用的服务/任务工具，但通用交互已经够用 | 将 PiDock 收缩为运行环境工具或 pi extension；优先复用 ThinkRail 的会话与工作台 |
| 必须深改多仓库身份、服务生命周期、浏览器面板及权限，且这些确为每天的核心障碍 | 再评估向上游贡献、维护小范围 fork、独立应用三者的代价；有持续升级和冲突成本的 fork 不自动优于自建 |
| 未完成真实业务验证，或仅在演示仓库中成功 | 保持“替代性未证实”，不进入完整客户端建设，也不宣布 ThinkRail 已完全替代 |

这不是要求 ThinkRail 逐字满足 PiDock 的所有既有规格：如果改用外部可见浏览器、现有服务工具等方式就能以较低成本消除真正的阻力，应接受它并删除相应自建需求。配色、布局、框架偏好和已经花费的设计时间，不足以成为继续完整产品的理由。反过来，“ThinkRail 当前缺少某功能”也不是持续投入的充分条件；必须证明该缺口实际阻碍工作，并且单独补齐比持续手工更划算。

实施顺序建议也应据此调整：先做替代验证，再决定是否启动 [20 界面复原、02 通用会话等实现工单](../.scratch/pidock-mvp/breakdown.md)。若保留自研，应围绕 03/04/05/06/07/08 所涉及的跨仓库、服务、浏览器和真实验证能力收窄范围，而非为保留这些能力先把所有外围功能做完。这里没有自动更改工单状态。

## 样本与身份

- 官方项目为 [JetBrains/thinkrail](https://github.com/JetBrains/thinkrail)，README 使用 JetBrains incubator 标识，[官网](https://thinkrail.ai/)称 JetBrains InnovationHub project。不是另一款同名产品。
- 本次源码固定在 `282f5a1ab8adf47af081ae10a2b2a8fd1f2afb6d`。调查时 `main` 与 `v0.1.2` 标签均指向这一提交；[最新稳定发布 v0.1.2](https://github.com/JetBrains/thinkrail/releases/tag/v0.1.2) 的 API `published_at` 为 `2026-09-20T09:16:30Z`，`prerelease=false`。另有 [v0.2.0-nightly.7](https://github.com/JetBrains/thinkrail/releases/tag/v0.2.0-nightly.7)，属预发布，不代表 v0.2.0 已稳定交付。数据来源：[latest release API](https://api.github.com/repos/JetBrains/thinkrail/releases/latest)、[releases API](https://api.github.com/repos/JetBrains/thinkrail/releases?per_page=3)。这些是服务返回的元数据，不应外推发布时间以外的成熟度。
- [README](https://github.com/JetBrains/thinkrail/blob/282f5a1ab8adf47af081ae10a2b2a8fd1f2afb6d/README.md) 定义其为 pi 的 thin host：pi 拥有模型、skills/extensions、compaction、cost 和 session state，应用拥有 workspace、editor 与 wire。许可证为 [Apache-2.0](https://github.com/JetBrains/thinkrail/blob/282f5a1ab8adf47af081ae10a2b2a8fd1f2afb6d/LICENSE)，可研究、修改、分发，仍需遵守许可证条件。

## 确认的结构和能力

| 维度 | 一手证据所支持的判断 | 来源 |
| --- | --- | --- |
| Agent 引擎 | **只支持 pi，进程内 `createAgentSession`**；V1/V2 均不引入第二个 runtime。多模型供应商不等于多 Agent runtime。没有看到 ACP 客户端协议实现；其 wire 是自有版本化契约。 | [产品规格](https://github.com/JetBrains/thinkrail/blob/282f5a1ab8adf47af081ae10a2b2a8fd1f2afb6d/goal-and-requirements.md)、[架构](https://github.com/JetBrains/thinkrail/blob/282f5a1ab8adf47af081ae10a2b2a8fd1f2afb6d/architecture.md)、[契约](https://github.com/JetBrains/thinkrail/blob/282f5a1ab8adf47af081ae10a2b2a8fd1f2afb6d/packages/contracts/src/wsProtocol.ts) |
| 客户端/宿主 | Bun HTTP+WebSocket host + React UI + types-only contracts；CLI 和 Electrobun 桌面共享 host 与 web artifact。 | [架构](https://github.com/JetBrains/thinkrail/blob/282f5a1ab8adf47af081ae10a2b2a8fd1f2afb6d/architecture.md) |
| 技术栈 | Bun 1.4.0、pi 0.84.3、Electrobun 2.0.1。 | [根清单](https://github.com/JetBrains/thinkrail/blob/282f5a1ab8adf47af081ae10a2b2a8fd1f2afb6d/package.json)、[桌面清单](https://github.com/JetBrains/thinkrail/blob/282f5a1ab8adf47af081ae10a2b2a8fd1f2afb6d/apps/desktop/package.json) |
| 仓库与工作区 | project 是一个 Git repo；workspace 是一个 worktree（单 branch、cwd），也支持 default workspace 与附加既有 worktree。 | [产品规格](https://github.com/JetBrains/thinkrail/blob/282f5a1ab8adf47af081ae10a2b2a8fd1f2afb6d/goal-and-requirements.md)、[domain.ts](https://github.com/JetBrains/thinkrail/blob/282f5a1ab8adf47af081ae10a2b2a8fd1f2afb6d/packages/contracts/src/domain.ts)、[workspace 模块](https://github.com/JetBrains/thinkrail/blob/282f5a1ab8adf47af081ae10a2b2a8fd1f2afb6d/packages/server/src/workspaces/SPEC.md) |
| 通用工作台 | Monaco 文件编辑、diff/Changes、终端、并发 chats、模型选择、token/cost 展示、skills；布局可分割、支持多个窗口独立视图状态。 | [README](https://github.com/JetBrains/thinkrail/blob/282f5a1ab8adf47af081ae10a2b2a8fd1f2afb6d/README.md)、[产品规格](https://github.com/JetBrains/thinkrail/blob/282f5a1ab8adf47af081ae10a2b2a8fd1f2afb6d/goal-and-requirements.md)、[架构](https://github.com/JetBrains/thinkrail/blob/282f5a1ab8adf47af081ae10a2b2a8fd1f2afb6d/architecture.md) |
| Review/PR | 本地行级 review；经用户 `gh` push 并打开/更新同一 PR。CI/checks、应用内 merge/squash 等超出这一范围。 | [产品规格](https://github.com/JetBrains/thinkrail/blob/282f5a1ab8adf47af081ae10a2b2a8fd1f2afb6d/goal-and-requirements.md)、[PR 模块](https://github.com/JetBrains/thinkrail/blob/282f5a1ab8adf47af081ae10a2b2a8fd1f2afb6d/packages/server/src/pr/SPEC.md) |
| 规格和工作流 | 有只读 spec graph 和 pi `spec_*` 工具、基于 skills 的工作流。可配置 workflow runtime、drift detection 等仍明确留给 V2。 | [产品规格](https://github.com/JetBrains/thinkrail/blob/282f5a1ab8adf47af081ae10a2b2a8fd1f2afb6d/goal-and-requirements.md) |
| 持久化 | app 的 project/workspace 状态在 `~/.thinkrail`；session/transcript 由 pi 管理；history 读取 pi JSONL，默认发现 `~/.pi/agent/sessions/`；断线后 hydrate-then-stream，客户端不是第二事实源。 | [README](https://github.com/JetBrains/thinkrail/blob/282f5a1ab8adf47af081ae10a2b2a8fd1f2afb6d/README.md)、[架构](https://github.com/JetBrains/thinkrail/blob/282f5a1ab8adf47af081ae10a2b2a8fd1f2afb6d/architecture.md)、[history 模块](https://github.com/JetBrains/thinkrail/blob/282f5a1ab8adf47af081ae10a2b2a8fd1f2afb6d/packages/server/src/history/SPEC.md)、[AgentSessionManager](https://github.com/JetBrains/thinkrail/blob/282f5a1ab8adf47af081ae10a2b2a8fd1f2afb6d/packages/server/src/agent/AgentSessionManager.ts) |
| 发布平台 | v0.1.2 有 CLI 与桌面 assets：macOS ARM64、Windows x64、Linux x64/ARM64。macOS Intel 无预编译；签名/notarization 的限制见 README。发布物存在不等于本次已验证可运行。 | [发布页](https://github.com/JetBrains/thinkrail/releases/tag/v0.1.2)、[README](https://github.com/JetBrains/thinkrail/blob/282f5a1ab8adf47af081ae10a2b2a8fd1f2afb6d/README.md) |

## 直接影响替代性的边界

### 多仓库同一任务：当前模型没有表达

`Project` 有单一 `path`，`Workspace` 有单一 `projectId`、`branch`、`worktreePath`；架构明确 `project (git repo) → workspace (git worktree) → chats/files/terminals`。这能管理多个项目，却不是把多个仓库的 worktree 作为同一业务任务的成员协同创建、路由与回收。依据：[domain.ts](https://github.com/JetBrains/thinkrail/blob/282f5a1ab8adf47af081ae10a2b2a8fd1f2afb6d/packages/contracts/src/domain.ts)、[架构决策 6](https://github.com/JetBrains/thinkrail/blob/282f5a1ab8adf47af081ae10a2b2a8fd1f2afb6d/architecture.md)。

这是基于实际领域对象与 workspace 模块的结构判断，不是仅凭搜索不到关键词。理论上用户仍可用脚本或 Agent 在目录间工作；那不构成当前产品提供了跨仓库任务生命周期。

### 本地/远程混合服务编排：没有发现对应一等能力

终端模块的职责是 worktree cwd 中的 `bun-pty` shell、terminal catalog、共享连接与输出恢复；其说明没有服务依赖图、逐服务 local/remote 选择、env 路由生成、健康检查、端口分配或受管理服务生命周期。检查了 [终端模块](https://github.com/JetBrains/thinkrail/blob/282f5a1ab8adf47af081ae10a2b2a8fd1f2afb6d/packages/server/src/terminal/SPEC.md)、[wire 契约](https://github.com/JetBrains/thinkrail/blob/282f5a1ab8adf47af081ae10a2b2a8fd1f2afb6d/packages/contracts/src/wsProtocol.ts)、[domain 模型](https://github.com/JetBrains/thinkrail/blob/282f5a1ab8adf47af081ae10a2b2a8fd1f2afb6d/packages/contracts/src/domain.ts) 及产品范围。

因此证据支持“**当前公开产品模型未覆盖此闭环**”，不支持“Agent 无法写脚本实现”或“未来不可能添加”。官网静态布局中的 `Hooks` 文案也不能直接作为有服务编排的证明。

### 同页可见、人与 Agent 共享控制的浏览器：未发现实现

实际工作台中心 tab 联合类型只有 `file`、`diff`、`chat`、`document`、`terminal`；没有 browser tab。[布局类型源码](https://github.com/JetBrains/thinkrail/blob/282f5a1ab8adf47af081ae10a2b2a8fd1f2afb6d/apps/web/src/shell/layout/types.ts)

内置 `pi-web-access@0.13.0` 的接入明确是 `web_search` 和 `fetch_content`；host 还默认将 search 的 `workflow` 设为 `none`，理由是 browser curator 无法在其 RPC host 渲染。[Agent 模块（bundled extensions / headless-search policy）](https://github.com/JetBrains/thinkrail/blob/282f5a1ab8adf47af081ae10a2b2a8fd1f2afb6d/packages/server/src/agent/SPEC.md)、[依赖清单](https://github.com/JetBrains/thinkrail/blob/282f5a1ab8adf47af081ae10a2b2a8fd1f2afb6d/packages/server/package.json)。依赖作者发布的 [0.13.0 包元数据](https://registry.npmjs.org/pi-web-access/0.13.0) 描述的是搜索、URL 抓取、GitHub clone、PDF extraction、视频理解。

所以 `web access` 不能算 PiDock 所需的“用户看着同一业务页面，Agent 点击/输入/验证并留下可见结果”。浏览器是 ThinkRail 自身 UI 的运行容器，也不等于它提供业务浏览器控制器。本次未实际试验用户安装额外 pi browser extension 的可行性或可视化效果。

### 远程和移动：分层设计支持演进，不能算已成熟交付

README 的定位用语是 desktop-and-mobile / mobile-first；但 [产品规格](https://github.com/JetBrains/thinkrail/blob/282f5a1ab8adf47af081ae10a2b2a8fd1f2afb6d/goal-and-requirements.md) 把 remote/phone over Tailscale 明确列为 V2，[web 规格 Later](https://github.com/JetBrains/thinkrail/blob/282f5a1ab8adf47af081ae10a2b2a8fd1f2afb6d/apps/web/SPEC.md) 将 mobile single-view shell 和 PWA 留待后续。[CLI 规格](https://github.com/JetBrains/thinkrail/blob/282f5a1ab8adf47af081ae10a2b2a8fd1f2afb6d/apps/cli/SPEC.md) 也将 always-on headless `serve` 留给 V2。

[架构](https://github.com/JetBrains/thinkrail/blob/282f5a1ab8adf47af081ae10a2b2a8fd1f2afb6d/architecture.md) 已设计 endpoint 参数化、hydrate-then-stream、Tailscale ACL/device identity 外部鉴权；桌面 V1 profile 则明确 local-only。这证明架构方向，不证明远程/手机场景已经端到端验收。更不能将“远程连接 Agent host”与“业务服务 local/remote 混合路由”混为一谈。

## 迁移与成熟度尚需实测的事项

- **Pi 会话复用有设计基础，但不是 PiDock 全状态迁移保证。** ThinkRail 调用 `SessionManager.list(cwd)` / `SessionManager.open(info.path)`；pi JSONL 由 cwd 发现。仍需验证具体已有 pi 版本、cwd/worktree 路径、扩展、认证和 session 内容是否一致。没有看到 PiDock 项目、任务、多repo/service 配置导入器。[AgentSessionManager](https://github.com/JetBrains/thinkrail/blob/282f5a1ab8adf47af081ae10a2b2a8fd1f2afb6d/packages/server/src/agent/AgentSessionManager.ts)、[history 模块](https://github.com/JetBrains/thinkrail/blob/282f5a1ab8adf47af081ae10a2b2a8fd1f2afb6d/packages/server/src/history/SPEC.md)
- **pi skills/extension 可扩展性存在，但业务工作台扩展成本未知。** 仓库有 portable pi extensions、子代理扩展与独立 contracts；同时 workspace-internal workflow 被明确标为非 portable。没有依据把“添加业务服务面板、跨 repo workspace”称为无需 fork 的现成插件能力。[架构](https://github.com/JetBrains/thinkrail/blob/282f5a1ab8adf47af081ae10a2b2a8fd1f2afb6d/architecture.md)、[Agent 模块](https://github.com/JetBrains/thinkrail/blob/282f5a1ab8adf47af081ae10a2b2a8fd1f2afb6d/packages/server/src/agent/SPEC.md)
- **处于真实可下载的软件阶段，可靠性尚未在本项目环境验证。** 有稳定发布、夜间发布、单元/E2E/artifact 测试文档；这些不能替代本地真实任务验证。[README](https://github.com/JetBrains/thinkrail/blob/282f5a1ab8adf47af081ae10a2b2a8fd1f2afb6d/README.md)、[发布页](https://github.com/JetBrains/thinkrail/releases/tag/v0.1.2)
- **使用偏好差异：** README 说明基本使用事件 always-on，`--no-analytics` 只抑制额外事件；这不是本次判断核心，但若要求完全无遥测，需要另行确认/修改。[README Analytics & Privacy](https://github.com/JetBrains/thinkrail/blob/282f5a1ab8adf47af081ae10a2b2a8fd1f2afb6d/README.md)
