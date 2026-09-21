# Pi 扩展管理与远程访问能力调研

调研日期：2026-09-21。本文只读核对 `badlogic/pi-mono` 的官方文档与源码，固定到提交 [`890f920`](https://github.com/badlogic/pi-mono/tree/890f920884f6d21fc7617d236ef9e1cc5d7a0ef8)。当前源码中的 npm 包名为 `@earendil-works/pi-coding-agent`。本文未安装第三方包、未连接 MCP Server，也未运行实验性远程 harness；实现时应固定 Pi 版本并做兼容性测试。

## 结论

| 能力 | Pi 的真实边界 | PiDock 结论 |
| --- | --- | --- |
| Skills | **原生支持**。Pi 实现 Agent Skills 标准，可从用户、项目、package、settings 和 CLI 路径发现技能，并支持 `/skill:name` 与 reload；技能内容可带脚本并指示模型执行任意动作。[Skills](https://github.com/badlogic/pi-mono/blob/890f920884f6d21fc7617d236ef9e1cc5d7a0ef8/packages/coding-agent/docs/skills.md) | 可以做来源、作用域、启停、校验错误和冲突可见的管理界面；编辑/创建仍是 PiDock 提供的文件管理体验，不是 Pi 已有的桌面管理器。 |
| Extensions | **原生支持**。TypeScript extension 可注册工具、命令、Provider，拦截生命周期和工具调用，并能动态启停工具；extension 以当前用户的完整系统权限执行任意代码。[Extensions](https://github.com/badlogic/pi-mono/blob/890f920884f6d21fc7617d236ef9e1cc5d7a0ef8/packages/coding-agent/docs/extensions.md) | 可以管理安装、作用域、启停、状态和 reload；必须把它视为可执行软件，而不是无害配置。 |
| Packages / “Plugins” | **原生支持 Pi Packages**，可通过 npm、git 或本地路径安装、移除、更新和列出，并可组合 extensions、skills、prompts、themes 及逐类过滤。[Pi Packages](https://github.com/badlogic/pi-mono/blob/890f920884f6d21fc7617d236ef9e1cc5d7a0ef8/packages/coding-agent/docs/packages.md) | 产品术语建议用“扩展包（Pi Package）”，不要把稳定 Pi Package 与源码中的实验性 presentation plugin 混为一谈。 |
| MCP | **无内置 MCP**。官方 README 明确写明 “No MCP”，并建议通过 extension 增加 MCP 支持。[Philosophy](https://github.com/badlogic/pi-mono/blob/890f920884f6d21fc7617d236ef9e1cc5d7a0ef8/packages/coding-agent/README.md#philosophy) | 可实现，但应由 PiDock 提供一个受控 MCP bridge extension；不能把“MCP 原生支持”写进产品说明。 |
| 本机嵌入 | **原生支持**进程内 `AgentSession` SDK；官方推荐同一 Node.js/TypeScript 进程直接使用 SDK。[SDK](https://github.com/badlogic/pi-mono/blob/890f920884f6d21fc7617d236ef9e1cc5d7a0ef8/packages/coding-agent/docs/sdk.md) | PiDock 后端优先直接嵌入 SDK，并在自己的领域层管理项目、任务和多个会话。 |
| 子进程接入 | **原生支持**基于 stdin/stdout 的 JSONL RPC，可发起对话、读取消息/会话树、排队、取消、压缩、切换会话和查询命令。[RPC mode](https://github.com/badlogic/pi-mono/blob/890f920884f6d21fc7617d236ef9e1cc5d7a0ef8/packages/coding-agent/docs/rpc.md) | 可作为 worker 进程隔离边界，但它不是 HTTP/WebSocket 服务，也不包含网络认证、设备管理或项目/任务 API。 |
| 远程/服务器模式 | **目前无可依赖的稳定成品**。官方 remote harness 明确为 development-only，只在源码 checkout 的 `source` condition 下提供，且不进入 npm 包和独立二进制。[Development](https://github.com/badlogic/pi-mono/blob/890f920884f6d21fc7617d236ef9e1cc5d7a0ef8/packages/coding-agent/docs/development.md#experimental-remote-harness) | 手机远程访问需要 PiDock 自己的 Agent Host、Web API、实时通道、认证授权和代理服务，不能直接暴露 Pi RPC 或依赖实验 harness。 |

因此，用户提出的两组功能都能实现，但含义不同：资源管理主要是对 Pi 稳定 SDK/包机制做产品化；MCP 和手机远程控制则是 PiDock 新增的系统能力。

## 资源管理应如何接入

Pi 已经暴露了足够的程序化接口，不需要通过解析 CLI 文本来实现管理页：

- `DefaultResourceLoader.reload()` 与 `getExtensions()`、`getSkills()` 可刷新并取得资源及 diagnostics；`createAgentSession()` 返回 extension 加载结果和错误。[ResourceLoader](https://github.com/badlogic/pi-mono/blob/890f920884f6d21fc7617d236ef9e1cc5d7a0ef8/packages/coding-agent/docs/sdk.md#resourceloader)
- `SettingsManager` 支持读写全局/项目的 packages、extensions、skills 路径；写入是异步持久化，关键操作后需 `flush()` 并展示 `drainErrors()`。[Settings management](https://github.com/badlogic/pi-mono/blob/890f920884f6d21fc7617d236ef9e1cc5d7a0ef8/packages/coding-agent/docs/sdk.md#settings-management)
- 导出的 `DefaultPackageManager` 具备 `installAndPersist`、`removeAndPersist`、`update`、`listConfiguredPackages` 和进度回调，能够支撑安装队列与状态反馈。[PackageManager API](https://github.com/badlogic/pi-mono/blob/890f920884f6d21fc7617d236ef9e1cc5d7a0ef8/packages/coding-agent/src/core/package-manager.ts)
- Pi Package 可以按资源类型和路径过滤，`pi config` 已有启停入口，证明配置模型存在，但 PiDock 仍需设计自己的图形界面与事务边界。[Package filtering](https://github.com/badlogic/pi-mono/blob/890f920884f6d21fc7617d236ef9e1cc5d7a0ef8/packages/coding-agent/docs/packages.md#package-filtering)

建议管理页统一显示以下字段：显示名、资源类型、来源 URI、版本或 git ref、全局/项目作用域、信任状态、启用状态、加载状态、错误、包含的工具/命令，以及最近更新时间。Package 是安装与更新单元，Skill/Extension 是运行资源，两层不要折叠成一张含义模糊的列表。

首版支持已安装资源清单、npm/git/本地源安装、版本固定、启停、移除、更新检查、错误详情和手动 reload。项目级资源必须沿用 Pi 的 project trust 语义：项目只有被信任后，Pi 才加载项目 settings、安装缺失 package 并执行项目 extension。[Project trust](https://github.com/badlogic/pi-mono/blob/890f920884f6d21fc7617d236ef9e1cc5d7a0ef8/packages/coding-agent/docs/usage.md#project-trust)

资源变更由 PiDock 控制面串行执行，在无活动 tool call 的会话边界 reload，并将“配置已写入”“包已安装”“运行时已加载”作为三个独立状态。安装或更新失败不能留下界面显示已启用但运行时仍为旧版本的假状态。

## MCP 实现边界

Pi 没有 MCP client、MCP Server 配置模型或 MCP 管理 UI。可行方案是一个由 PiDock 维护的 MCP bridge extension：连接配置由 PiDock 保存；extension 按 MCP 协议发现工具，把 JSON Schema 映射为 `pi.registerTool()`，调用时转发给对应 Server。Pi 支持启动后动态注册工具以及用 `setActiveTools()` 启停，适合在连接变化后更新当前会话的工具集合。[Dynamic tools](https://github.com/badlogic/pi-mono/blob/890f920884f6d21fc7617d236ef9e1cc5d7a0ef8/packages/coding-agent/docs/extensions.md#dynamic-tool-loading)

首版只桥接 MCP tools。MCP prompts、resources、sampling、elicitation 等不是 Pi 工具注册的同义概念，应逐项设计，不能宣称自动兼容全部 MCP 能力。传输和生命周期应遵循 MCP 的 client-host-server 边界，由 PiDock 作为 host 隔离 Server，并明确本地 `stdio` 与远程 Streamable HTTP 的凭据和信任差异。[MCP architecture](https://modelcontextprotocol.io/specification/2025-06-18/architecture)

每个 MCP Server 配置至少包含稳定 ID、显示名、传输、启动命令或 URL、凭据引用、工作目录、环境变量白名单、全局/项目作用域、启用状态、超时和可用工具清单。工具名需要加 Server 命名空间并检测冲突；Server 断开时立即停用对应工具，不能让模型继续看到不可调用的旧 schema。

## 远程控制建议架构

PiDock 应把远程能力建立在自己的领域模型上，而不是把 Pi 会话文件或 stdin/stdout RPC 暴露到公网：

```text
手机浏览器
  │ HTTPS + authenticated realtime channel
  ▼
Remote Gateway / Relay
  ▲ outbound WSS（桌面主动建立）
  │
PiDock Agent Host（桌面常驻控制面）
  ├─ Project / Task / Session API
  ├─ policy、审计、设备授权
  └─ Pi worker（AgentSession SDK 或本机 RPC 子进程）
```

桌面端主动建立出站连接可以穿过多数 NAT，避免让用户开放本机端口。Relay 只负责认证后的路由、短期离线信令和连接状态；项目目录、Provider 凭据、MCP secret、完整文件内容和 extension 代码默认留在桌面。若 Relay 需要缓存消息，应把保存范围、保留期和加密边界做成明确策略，而不是默认同步所有会话。

稳定 Pi RPC 已经具备远程 UI 所需的部分会话原语，例如 `get_state`、`get_messages`、`get_entries`、`get_tree`、`prompt`、`steer`、`follow_up`、`abort` 和事件流。[RPC commands](https://github.com/badlogic/pi-mono/blob/890f920884f6d21fc7617d236ef9e1cc5d7a0ef8/packages/coding-agent/docs/rpc.md#commands) 但项目、任务、工作区、设备、权限和审计属于 PiDock；应由 PiDock API 聚合后向手机提供稳定 DTO，不让移动端依赖 Pi 的内部 session 格式。

官方实验 harness 即使已有 Unix socket 和可选 relay 代码，也不适合作为捷径：它被明确排除在发布物外；其服务清单还把“authenticated workspace authorization”和“authenticated plugin policy”列为后续工作。[Experimental service status](https://github.com/badlogic/pi-mono/blob/890f920884f6d21fc7617d236ef9e1cc5d7a0ef8/packages/coding-agent/src/experimental/services/README.md)

实验性的 `pi-client` 虽可适配 WebSocket 等有序字节传输，但 `pi-server` 当前只提供 Unix socket preset，peer authentication 和业务 service 均由应用实现，协议本身也明确没有兼容性保证。[Client](https://github.com/badlogic/pi-mono/blob/890f920884f6d21fc7617d236ef9e1cc5d7a0ef8/packages/client/README.md)、[Server](https://github.com/badlogic/pi-mono/blob/890f920884f6d21fc7617d236ef9e1cc5d7a0ef8/packages/server/README.md)、[Protocol](https://github.com/badlogic/pi-mono/blob/890f920884f6d21fc7617d236ef9e1cc5d7a0ef8/packages/protocol/README.md)。PiDock 可以在内部保留传输适配层，未来评估替换底层，但不能让移动端直接依赖该协议。

### 分阶段范围

1. **远程只读**：设备配对、查看在线状态、项目/任务列表、会话记录、当前运行状态和通知。
2. **受限交互**：发送普通消息、steer/follow-up、停止运行、创建或切换会话；所有动作进入同一任务队列并保留来源设备。
3. **审批与轻量管理**：只开放已有策略允许的确认、任务状态调整和低风险操作。Skill、MCP、extension 安装更新及 shell/文件写入等高风险动作默认要求桌面本机确认。
4. **更完整控制**：经过独立威胁建模后，再考虑远程终端、文件浏览、package 安装和高风险工具审批。

## 安全要求

- **Extension/Package 是代码执行边界**：官方说明 extension 以完整系统权限运行，skill 也能诱导模型执行代码；安装前展示来源、固定版本/ref、资源清单和权限风险，默认不自动更新。[Package security](https://github.com/badlogic/pi-mono/blob/890f920884f6d21fc7617d236ef9e1cc5d7a0ef8/packages/coding-agent/docs/packages.md#install-and-manage)
- **隔离 Agent worker**：不要让第三方 extension 与桌面 UI、设备令牌和 Relay 凭据处在同一高权限进程。最少使用独立子进程与最小环境变量；更强隔离可结合容器或 OS sandbox。Pi 明确没有内置 sandbox，extension 与 Pi 进程权限相同，真正隔离必须来自操作系统、虚拟机或容器。[Security](https://github.com/badlogic/pi-mono/blob/890f920884f6d21fc7617d236ef9e1cc5d7a0ef8/packages/coding-agent/docs/security.md#no-built-in-sandbox)
- **设备而非共享密码**：采用短时配对码或扫码建立每设备密钥，令牌可撤销、短期有效并绑定设备；支持查看和踢出设备。Relay 与桌面都校验用户、设备、任务及动作权限。
- **不暴露原始执行接口**：公网 API 不接受任意 session path、cwd、extension 路径、shell 字符串或未校验 MCP 配置。所有请求使用 PiDock 的稳定 ID，并在桌面端重新授权和解析。
- **远程动作可追溯**：记录设备、用户、任务、会话、动作、策略结果和关联运行 ID；敏感输入、凭据与工具结果按字段脱敏，审计记录不能成为新的 secret 副本。
- **连接失效要保守**：桌面离线、Relay 重连、客户端重复提交时使用幂等键和序号；不能因为重放而重复发送 prompt、重复批准工具或重复安装 package。
- **最小化远程数据**：移动端默认只得到渲染所需的会话和状态，不返回本机绝对路径、环境变量、Provider/MCP token 或完整仓库索引。

## 对 PiDock 规格的直接建议

新增一个“能力”一级页面，下面分“Skills”“MCP Servers”“Extensions”“Packages”四个视图；Package 负责安装来源和版本，其他三个视图负责运行时资源与连接状态。首版不提供公共市场，只允许明确来源并展示可验证的版本信息。

新增“远程访问”设置，配置的是 PiDock Relay/自托管 Gateway 与设备，而不是“Pi 远程服务器”。运行时仍在用户桌面，手机是受限客户端。首版承诺查看与简单对话管理，不承诺在手机上获得等同本机的 shell、文件和扩展安装权限。

实现顺序建议为：先抽出本机 Agent Host API 和统一事件流，再接资源管理，随后做只读远程与设备配对，最后开放受限写操作。这样桌面 UI 与手机 UI 复用同一套授权后的领域 API，也避免把 Pi 实验接口固化成产品协议。

## 2026-09-21：Tailscale 与代理服务器配置补充调研

### 结论先行

Tailscale 可以实现 PiDock 的手机远程访问，并且适合作为首版的网络层方案，但它不等于前文所说的 PiDock 业务 Relay：

- **个人或小团队 MVP 推荐 `Tailscale Serve`**。PiDock Agent Host 只监听本机回环地址，由 Serve 在 tailnet 内提供 HTTPS。手机必须安装 Tailscale、登录同一 tailnet（或接受设备共享），随后可直接用浏览器打开 `https://<设备名>.<tailnet>.ts.net`。这种模式不需要用户填写 `https://relay.example.com`，也不需要 PiDock 自建公网代理。
- **不希望手机安装 Tailscale时，可用 `Tailscale Funnel` 做实验或个人部署**。手机只需普通浏览器，但 URL 对整个互联网可达；Funnel 不提供 Tailscale 身份 headers，因此 PiDock 必须自己完成登录、设备配对、授权、CSRF 防护、限流和审计。Funnel 目前仍标为 beta，且有端口、带宽和平台限制，不建议作为唯一的商业远程入口。[Funnel](https://tailscale.com/docs/features/tailscale-funnel)
- **面向普遍用户或需要离线只读时，仍需 PiDock 托管／自建 Gateway + Relay**。桌面主动建立出站 WSS，手机访问公网 HTTPS；Relay 可以按明确策略缓存少量状态。Tailscale 可以用于 Relay 到内部运维端点的私网连接，但不能替代设备配对、消息路由、离线状态、业务授权或审计。

DERP 也不能当作 PiDock Relay。DERP 用于协助 NAT 穿透，并在不能直连、也没有 peer relay 时盲转发已加密的 WireGuard 数据包；它不理解 PiDock 的用户、任务或消息，也不做存储转发。[DERP servers](https://tailscale.com/docs/reference/derp-servers)

### 方案 A：Tailnet 私有访问 + Serve（推荐 MVP）

网络路径是“手机 Tailscale → tailnet → 桌面 Tailscale Serve → `127.0.0.1` 上的 PiDock Host”，不是“手机 → 公网 Relay → 桌面长连接”。建议配置步骤如下：

1. 桌面和手机安装 Tailscale，并加入同一 tailnet；管理员在设备管理中启用 device approval 后，新手机在获批前不能收发 tailnet 流量。[Device approval](https://tailscale.com/docs/features/access-control/device-management/device-approval)
2. 在 Tailscale DNS 设置中启用 MagicDNS 与 HTTPS。MagicDNS 为 tailnet 设备注册名称；HTTPS 使用公开受信任证书，完整设备域名会进入 Certificate Transparency 公共日志，因此设备名不能包含项目、客户或其他敏感信息。[MagicDNS](https://tailscale.com/docs/features/magicdns)、[HTTPS certificates](https://tailscale.com/docs/how-to/set-up-https-certificates)
3. PiDock Agent Host 只监听回环地址，例如 `127.0.0.1:4318`，不得同时监听 LAN 或公网地址。
4. 在桌面启动持久 Serve 反向代理：

   ```shell
   tailscale serve --bg 127.0.0.1:4318
   ```

   Serve 自动在 tailnet 内提供 HTTPS，`--bg` 配置在设备或 Tailscale 重启后会恢复。代理目标只支持 `http://127.0.0.1`；可用 `tailscale serve status --json` 检查状态。[Serve CLI](https://tailscale.com/docs/reference/tailscale-cli/serve)
5. 收紧 tailnet policy。默认新 tailnet 可能是 allow-all；应使用 grants（官方优先推荐）或 ACL，只允许指定用户／组访问 PiDock 桌面的 `tcp:443`。以下仅为结构示例，实际用户与目标 selector 由安装向导生成并在保存前校验：

   ```json
   {
     "groups": {
       "group:pidock-users": ["owner@example.com"]
     },
     "tagOwners": {
       "tag:pidock-host": ["owner@example.com"]
     },
     "grants": [
       {
         "src": ["group:pidock-users"],
         "dst": ["tag:pidock-host"],
         "ip": ["tcp:443"]
       }
     ]
   }
   ```

   桌面节点还需实际分配 `tag:pidock-host`；若不希望把个人桌面改为 tagged node，首版可改用具体设备 alias 作为目标。Grants 是 deny-by-default，但没有任何自定义访问策略时 Tailscale 会应用默认 allow-all，因此安装检查不能只确认“已连上 tailnet”。[Grants syntax](https://tailscale.com/docs/reference/syntax/grants)、[ACL behavior](https://tailscale.com/docs/features/access-control/acls)
6. 手机在 Tailscale 已连接的情况下，用 Safari/Chrome 打开 Serve 输出的 `https://<设备名>.<tailnet>.ts.net`。若只在浏览器输入该私有地址、但手机没有加入并连接 tailnet，则无法访问；“普通浏览器、无需安装 Tailscale”属于 Funnel 或公网 Relay 方案。

Serve 反向代理会向本机后端注入 `Tailscale-User-Login`、`Tailscale-User-Name` 和可选头像，并先移除客户端伪造的同名 headers。后端必须只监听 localhost，否则能够绕过 Serve 直接访问后端的人仍可自行伪造这些值。tagged **来源设备**没有用户 identity headers；被分享设备的外部用户则可能带身份 headers。[Serve identity headers](https://tailscale.com/docs/features/tailscale-serve#identity-headers)

这些 headers 可以作为低风险功能的登录身份来源，但不能代替 PiDock 的领域授权。PiDock 仍需校验用户是否能查看该 Project／Task／Session、当前动作是否允许、会话执行权和高风险操作是否需要本机确认，并记录远程用户、来源设备（若可得）、动作与结果。Tailscale device approval 只批准设备加入 tailnet，不等同于 PiDock 的设备配对，也不能表达“能聊天但不能开终端”。需要区分浏览器设备、逐设备撤销或恢复码时，仍应保留 PiDock 自己的配对与会话机制。

PiDock 的事件流可以继续使用 WebSocket。Tailscale 当前 Serve 实现使用 Go 标准 `httputil.ReverseProxy` 转发 HTTP 请求；不过官方 Serve 文档没有把 WebSocket 写成明确的兼容性承诺，因此发布前必须用所固定的 Tailscale 客户端版本验收连接升级、长时间空闲、网络切换和自动重连，并保留 SSE/轮询恢复路径。[Serve proxy source](https://github.com/tailscale/tailscale/blob/3014ad828eff09c2ce9bbcb6ae132d700abbb0d7/ipn/ipnlocal/serve.go#L954-L1000)

### 方案 B：Funnel 公网直达（无需手机安装 Tailscale）

PiDock Host 仍只监听 `127.0.0.1:4318`，桌面端可用：

```shell
tailscale funnel --bg 127.0.0.1:4318
```

Funnel 通过公开 DNS 和 Funnel relay 把公网流量转到本机，手机不需要 Tailscale 客户端。它要求 MagicDNS、HTTPS 和 tailnet policy 中的 funnel node attribute，只能使用 tailnet 的 `*.ts.net` 域名、端口 `443`／`8443`／`10000` 和 TLS，并受不可配置的带宽限制；Serve 与 Funnel 不能在同一端口同时保持私有和公开，后配置者决定该端口最终是私有还是公开。macOS 上使用 Funnel 还要求 Tailscale 的开源发行变体。[Funnel requirements and limitations](https://tailscale.com/docs/features/tailscale-funnel#requirements-and-limitations)

Funnel 是传输入口，不是访问控制。它明确不注入 Serve 的 identity 或 app-capability headers，所以必须在任何项目、任务和对话数据返回前完成 PiDock 登录和设备授权。建议公网模式至少具备短时登录、绑定设备的可撤销凭据、速率限制、重放保护、CSRF／Origin 校验、敏感动作二次确认和完整审计；不能只依赖一个不可猜 URL 或共享密码。

### 方案 C：PiDock 自建／托管 Relay（适合产品化）

配置沿用当前原型的代理地址思路，但字段应明确为“PiDock Gateway 地址”，例如 `https://remote.example.com`，而不是“Pi 远程服务器”。桌面用一次性配对流程注册安装实例，换取可轮换的设备凭据，再主动建立 `wss://remote.example.com/agent`；手机登录 `https://remote.example.com` 后只访问授权的 PiDock DTO 和命令。公网 Gateway 负责用户认证、设备注册、路由、限流与审计，桌面 Host 对每个请求再次做任务和动作授权。

如果 Gateway 需要在桌面离线时展示内容，只能缓存产品明确声明的最小只读快照，并定义端到端或静态加密、保留时间、删除、租户隔离和日志脱敏；离线时不能继续运行本机 Agent、批准工具或控制本机服务。Tailscale Serve、Funnel 和 DERP 都不提供这种业务离线能力。

### 产品配置应随模式变化

当前原型只有一个“代理服务器”输入框，容易把三种机制混为一谈。实现时应先选择连接模式，再显示对应字段：

| 模式 | 用户配置 | 手机要求 | PiDock 应用认证 |
| --- | --- | --- | --- |
| Tailscale 私有访问 | 检测本机 Tailscale、显示 Serve URL、引导 HTTPS／policy／设备审批；**无 Relay URL** | 安装并连接 Tailscale | 可用 Serve 身份建立登录，但仍需项目／动作授权和审计；逐设备权限需要 PiDock 配对 |
| Funnel 公网入口 | 检测 Funnel 可用性、显示公开 URL 与 beta／公开暴露警告 | 普通浏览器即可 | **必须完整实现**，不能依赖 Tailscale identity headers |
| PiDock Gateway | Gateway URL、桌面实例配对、连接状态、凭据轮换 | 普通浏览器即可 | **必须完整实现**，Gateway 与桌面双重授权 |

推荐首版先实现方案 A，并把“远程访问”设置做成可诊断的引导：检查 Tailscale 是否运行、当前 tailnet、MagicDNS/HTTPS、Serve 状态、目标是否仅监听 loopback、`tcp:443` 是否按最小权限开放，以及手机连通性。方案 B 只放在高级／实验入口；方案 C 等领域 API、授权模型和审计稳定后再实现。这样最快得到可用的手机查看与简单对话，同时不会过早承担公网身份系统和 Relay 运维。

### 在线与中继边界

- Serve/Funnel 都要求桌面、Tailscale daemon 和 PiDock Host 在线；桌面休眠、掉线或应用退出后，手机不能继续操作。
- DERP 或 Funnel relay 只转发在线流量，不保存 PiDock 会话供离线查看。DERP 即使在 Tailscale coordination server 暂时不可用时能利用客户端缓存的 DERP map，也不意味着离线桌面可访问；新增设备、策略更新等控制面动作仍可能受影响。[DERP availability](https://tailscale.com/docs/reference/derp-servers#availability-and-downtime)、[Coordination server outage](https://tailscale.com/docs/reference/coordination-server-down)
- 网络切换可能让实时连接重建。远程 prompt、停止、审批等写动作必须带幂等键和事件序号；UI 应明确显示“已提交”“桌面已接收”“执行中”，不能把 WebSocket 已发送误认为 Agent 已执行。
