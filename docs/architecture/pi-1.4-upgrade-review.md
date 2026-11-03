# Pi 0.87.1 → 1.4.0：更新影响与 PiDock 适配

核对日期：2026-11-02。项目从 2026-09-20 的 Pi 0.86.1 调研起步，正式依赖固定在 0.87.1；本次将 `pi-ai` 与 `pi-coding-agent` 同步固定到 npm 当前发布的 1.4.0。上游版本依据为发布 tag [`v1.4.0`](https://github.com/earendil-works/pi/tree/v1.4.0)（tag 对象 `4a080252f06caf63a525d7873c5d94d3c23887e0`），同时核对了安装包内文档、声明及本项目生产调用方。本文是技术分析与验证记录；执行与验收记录见 [#134](https://github.com/Leonz3n/PiDock/issues/134)（父规格 #1 的原生 sub-issue）。

## 结论与设计调整

**继续采用 Electron main → 每任务 Agent Host → 隔离模型 worker → Pi AgentSession。** Pi 新增的原语减少了需要自建的模型与工具基础设施，但没有替代 PiDock 的项目、任务工作区、写协调、服务管理、可见浏览器或远程设备权限。

首版范围继续遵循 [#126](https://github.com/Leonz3n/PiDock/issues/126)：远程访问已移出首版，正式桌面入口与 `task/remote*` 通道保持停用。本文关于 Gateway 和设备授权的判断仅供未来功能设计，不恢复该范围；MCP 的旧 bridge 验收口径同步更正在 [#18](https://github.com/Leonz3n/PiDock/issues/18)，不代表真实能力管理已接线。

| 上游变化 | 对 PiDock 的影响与调整 | 本次交付边界 |
| --- | --- | --- |
| 0.99 原生 MCP、codemode、tool_search；1.0–1.4 持续修复 OAuth、延迟发现、取消与关闭 | 撤销旧文档“Pi 无 MCP，所以自建协议 bridge”的方案。后续接入优先复用官方 `createMcpExtension` / `createCodemodeExtension` / `createToolSearchExtension`，PiDock 负责配置、来源、授权、状态及生命周期 | 本次升级依赖、修订设计；生产仍仅注册 Host 受管工具，不自动读取用户 `mcp.json` 或启动服务器 |
| 0.99 新增 direct / model-only / codemode / deferred / hidden 工具暴露、嵌套调用；1.2 新增 reachesTools | 活跃工具清单不再等于全部可执行工具。仅 `setActiveTools` 或顶层名称白名单不足以约束将来的 codemode/MCP；嵌套调用也须走同一授权路径 | 保持空资源 loader、`noTools: "all"`、显式工具名，并核对全部注册与活跃工具集合；后续能力接入必须扩展 Host broker 后才启用 |
| 1.1 `agent_settled.aborted`；1.2 启动钩子期间也计入 busy | 完成采用运行边界，而非低层 `agent_end`；取消直接采用明确标志，覆盖未产生 assistant 消息的阶段 | kernel 采纳并转发 `aborted`；旧测试事件可省略该新增字段；保持任务锁、waitForIdle 和关闭顺序 |
| 1.2 print 模式对最终 length 回复报告失败；1.4 修复截断工具调用恢复后的上下文破损 | 有文本不证明任务完整结束。PiDock 应保留部分回复及 usage，但不能把 Token 上限截断判为成功 | `stopReason: "length"` 映射为 `sdk-output-truncated`，失败状态写入回合日志，重启可查；不自动重放 |
| 1.3 恢复活跃工具，1.4 修复后注册工具的分支恢复 | 历史工具状态可恢复，但不能成为新增执行授权。PiDock 显式工具选择优先于历史清单 | 已有恢复、工具越界及无 broker 零工具测试在新版通过；每次创建仍核对注册/活跃集合 |
| 0.87 SessionManager 已是上下文权威；0.99 修复首个用户输入未落盘；1.4 修复 malformed/truncated tool context | 继续使用绑定到任务/会话的 SDK JSONL，不通过 renderer 消息副本重建 provider 上下文 | SDK 管理会话树与恢复，PiDock 管理绑定身份、回合 ACK/幂等与投影；未将旧 PiSessionChannel 变成第二个 SDK 对话写入方 |
| 0.99 支持 chat/image/classifier、virtual model；1.3 模型切换丢弃旧模型 thinking | 模型清单不能把所有模型类型混成聊天模型，物理调用归属不能用当前选择覆盖 | 当前明确的文本 Provider 绑定继续生效；暂不开放虚拟路由或模型侧额外调用，避免绕过凭据绑定和账本口径 |
| 1.2 忽略摘要中的 thinking；1.4 摘要使用模型输出上限，reserveTokens 仅控制触发时机 | 后续真实压缩复用 SDK，不自建固定摘要输出上限；压缩与主请求的用量分别归属 | 当前 SDK 路径显式关闭自动压缩与重试，本次不把旧模拟压缩接进生产 |
| 1.2 删除实验性 server/client/plugin 及相关包 | 早期文档里的实验 remote harness 已不存在，不能作为未来稳定网络层的接入承诺 | PiDock Gateway、设备授权和任务 API 继续由 PiDock 管理；稳定 SDK / stdio RPC 仍可用 |
| 1.3 内部包固定精确版本；1.0.1 移除 npm shrinkwrap；Node >=22.19 | PiDock 必须同步固定两个直接依赖并提交自己的 lockfile，不能靠全局 Pi 版本 | 两个包均为 1.4.0；Pi 内部包随锁文件统一到 1.4.0；开发/桌面仍维持项目 Node 24.21.0 / Electron 44.4.3 |

主要来源：[完整 changelog](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/CHANGELOG.md)、[SDK](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/sdk.md)、[MCP](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/mcp.md)、[消息与 usage](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/message-types.md)、[会话格式](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/session-format.md)、[CLI 集成的完成/截断语义](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/cli-integration.md)。

## MCP 与 codemode 的后续接入设计

官方 [SDK 示例 14](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/examples/sdk/14-codemode-mcp.ts) 明确区分 CLI 与 SDK：SDK 不默认加载这三个内置扩展，需要 resource loader 装配并 `bindExtensions()`，之后 MCP 在 `session_start` 连接。不能照搬 CLI 配置就声称桌面接通。

后续实现应沿这些边界收敛：

1. 复用官方 MCP 传输、协议、OAuth、发现及工具命名机制。配置投影只来自 PiDock 明确选择的来源；不能让全局/项目配置自动产生进程或网络连接。
2. 本地 stdio 服务的创建与退出须进入任务资源登记、退出回执和平台验收；HTTP 服务的认证按 server name + URL 隔离。上游已有关闭修复不证明 PiDock 的跨进程关闭回执已覆盖它。
3. 工具可见性与权限分别判断。官方提示 codemode 可调用非活跃工具，deferred/codemode 工具可经间接路径访问；所有直接与嵌套调用均需按实际工具及参数授权，记录 `parentToolCallId`。不能把 `readOnlyHint` 等外部声明直接提升为可信权限。
4. `models.classify()`、`models.generateImages()`、virtual model 会增加模型调用及费用。须先明确 Provider 凭据来源、物理模型归属和 SDK 账本口径，再开放这些入口。
5. 启用时验证 deferred 工具发现、冷恢复、取消连接/登录/执行、工具撤回、重名归一化、worker 退出；只靠“配置保存成功”不宣布能力已加载。

这是替换旧 bridge 方案的设计，不构成本次已实现 MCP 的声明。当前 `#117/#123` 所记录的 SDK 用量与旧账本口径问题继续保留；SDK 新增 usage 不会自动补上 PiDock 的账本写入方。

## 实现与验证

变更集中在 `packages/shell/package.json`、`pnpm-lock.yaml` 与 `src/host/sdk-text-kernel.ts` 及其现有测试。没有编辑启动前工作区里已有的 Host 生命周期、浏览器状态和 UI 原型改动。

在 Node **24.21.0** 下完成：

- shell 类型检查、脚本类型检查、lint 与正式 renderer/shell build 通过。
- 10 个定向测试文件：**147 passed，2 skipped**。覆盖真实 SDK + 本地伪造 Provider 的流式事件、usage、JSONL 恢复、工具白名单/门禁、取消、关闭、worker、Provider 绑定、回合日志、RPC。
- 新增截断回合用例先失败（旧结果为 done），修正后通过；确认部分文本保留、失败状态冷启动仍可读。正常和取消回合分别验证 `aborted: false/true`。
- 真实 Electron `electron-sdk-bridge-test.mjs` 通过：sandbox preload → main → utilityProcess → SDK → JSONL；事件顺序为 delta/message_end/agent_settled；usage 为 input=4/output=2/cacheRead=1/cacheWrite=0；取消后为 cancelled；冷恢复已完成回合为 done；quit 后拒绝新请求；contextIsolation/sandbox 均为 true。这是本地测试 Provider，不是外部真实模型质量验收。

第一次测试误用 `pnpm test -- ...`，触发整个 shell 套件并在 60 秒超时；它不算全量通过证据。随后以 `pnpm --filter @pidock/shell exec vitest run <files>` 完成上述定向验证。首次类型检查使用 shell 默认 Node 22.23.2，随后已切回项目要求的 Node 24.21.0 重跑。

本次未执行 Windows MSI、安装后启动、外部供应商在线调用、真实 MCP Server、codemode 或第三方扩展验收；现有测试的冷恢复是新版写入后再恢复，不能冒充历史 0.87.1 用户会话迁移实测。SDK 会话格式仍为 v3，但正式分发前须用备份的旧会话副本验证升级与回退，不在用户原始会话上试验。现有生产 build 的大 chunk 提示仍存在。
