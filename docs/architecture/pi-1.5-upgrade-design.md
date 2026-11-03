# Pi 1.4.0 → 1.5.0：设计与工单调整

**目标基线为 Pi 1.5.0；仓库实际依赖仍为 1.4.0，尚未升级或运行新版产品验收。** 本轮仅更新设计与 GitHub tickets，产品实现继续暂停。既有 [1.4 适配报告](pi-1.4-upgrade-review.md) 保存历史交付证据。

核对上游发布 tag [`v1.5.0`](https://github.com/earendil-works/pi/tree/v1.5.0)，对应提交 `f9a26365568127461c47a07a37dcb42c140a3ac5`；已确认 npm 的 `pi-ai`、`pi-coding-agent`、`pi-schema` 均发布 `1.5.0`，engines 均为 Node `>=22.19.0`。本次读取该 tag 的源码、文档与 coding-agent / ai / agent / mcp / schema changelog，并静态对照本项目生产 SDK kernel、工具定义及 Host broker。未安装新版依赖、未执行其安装脚本或连接真实 Provider / MCP。

## 设计结论

继续采用 Electron main → 每任务 Agent Host → 隔离 SDK worker → AgentSession。Pi 1.5 不替代 PiDock 的工作空间身份、跨 Host 写协调、授权、幂等和资源归属。Node 24.21.0 / Electron 44.x 目标不因本次 SDK 发布自动变更。

[#134](https://github.com/Leonz3n/PiDock/issues/134) 承接实际 1.5 升级及兼容性验证，保留 1.4 已交付记录；[#138](https://github.com/Leonz3n/PiDock/issues/138) 增加 #134 为直接阻塞项。其下游 SDK 功能因此在新基线上交付。工作空间、已有目录及 worktree 等非 SDK 切片不新增无关阻塞。历史会话备份的兼容矩阵仍由 [#154](https://github.com/Leonz3n/PiDock/issues/154) 验证，Windows 安装仍归 [#22](https://github.com/Leonz3n/PiDock/issues/22)。

| 上游变化 | PiDock 的设计调整 | 承接工单 |
| --- | --- | --- |
| 工具参数统一使用 pi-schema；普通 JSON Schema 也会转换类型；TypeBox 专有校验不再执行 | SDK 参数处理与 Host 授权分开：审批、指纹、真实路径校验和执行必须绑定同一份实际参数；Host 保留严格的字段、范围与语义检查 | #134、#140、#150 |
| pi-ai 主入口移除 Type / Static / TSchema，AgentTool 泛型改变 | 同步锁定 SDK 包，核对实际调用方和工具定义类型。CLI 扩展 loader 的兼容别名不代表普通 worker 导入仍兼容 | #134 |
| 模型目录切换到 models.dev v2，新模型、推理 off 与模型切换修复 | 聊天选择器过滤 realtime / image-only；显示名称与 ID 分开，按模型能力生成推理档位和窗口。新默认模型不覆盖用户明确选择 | #138、#139、#152 |
| Usage.cost.totalFromProvider；具体 responseModel 元数据 | 保留请求模型、实际响应模型及费用来源；费用若展示，标明实报或估算，不把未知当零；不扩展成完整账本工程 | #139、#154 |
| 增量解析工具参数和流式渲染优化 | 半成品参数仅用于预览，不能审批或执行；验证大参数、中文分块、事件顺序和取消。React / Shiki 不自动获得上游 TUI 缓存优化 | #140、#145、#154 |
| MCP OAuth clientRegistration 与 URL 校验更新 | 支持并保留原生 auto / dcr / cimd 等配置，明确认证状态、回调及取消；HTTP(S) 授权 URL 白名单，不执行服务器提供的其他协议 | #150 |
| exec 缓冲上限、截断标记、UTF-8、强制结束和 macOS 取消修复 | 对实际 Host 命令链补输出边界、超时／取消和不执行后续命令的验收；上游 pi.exec 修复不等于自有执行器已修复 | #140、#153、#22 |
| Windows 路径大小写、Skills 重复加载、保存拒绝信任优先级修复 | 保留来源与身份核验；Windows 盘符变体不重复加载／隐藏会话，警告与同名冲突区分；不能用工作空间登记代替项目资源信任 | #151、#154、#22 |
| SessionManager 写入失败回滚内存条目 | 覆盖磁盘写失败后的历史／父链一致性、冷恢复和不可重放；不推定跨 PiDock ACK／JSONL／执行日志已形成事务 | #134、#146、#153、#154 |
| CLI 扩展更新通知、自更新命令、TUI blocked 状态及原生 sandbox 示例移除 | 首版仍无 Extensions 管理／SDK 自更新入口；后台等待审批继续以 Host 状态为准；进程分离仍不是 OS 沙箱 | #149、#150、#153 |

## 工具参数与授权

[pi-ai 1.5 changelog](https://github.com/earendil-works/pi/blob/v1.5.0/packages/ai/CHANGELOG.md)、[校验实现](https://github.com/earendil-works/pi/blob/v1.5.0/packages/ai/src/utils/validation.ts)、[pi-schema 转换规则](https://github.com/earendil-works/pi/blob/v1.5.0/packages/schema/README.md#coercion) 说明：

- 校验使用 `compile(schema, { coerce: true, unresolvedRefs: "reject" })`，对复制后的参数进行转换，不直接改写原始 transcript 工具调用。
- 必填字符串的 `null` 可变为 `"null"`，整数的 `"3.5"` 可变为 `3`，单值可包为数组，不接受 null 的可选属性可能被删除。这些不是 Host 的授权承诺。
- TypeBox `Refine`、自注册 `Format.Set`、codecs 等不再提供原先的运行语义；不能以 schema 通过代替真实路径、身份、命令范围与权限检查。未知字段须按 Host 契约处理。
- 普通 SDK 导入不能依赖扩展 loader 为旧扩展提供的 TypeBox 兼容导出。底层 `AgentTool` 与 coding-agent 的扩展 `ToolDefinition` 类型边界需分别核实，不机械地把全部工具强制重写成一种 schema builder。

当前生产工具定义使用普通 JSON Schema，再将 SDK 提供的参数交给 Host broker；未发现生产代码从 pi-ai 主入口导入 TypeBox 的直接用法。因此最直接的风险是**原本已有工具收到的参数语义变化**，不能只做依赖版本替换或 TypeScript 编译检查。升级时须通过真实 SDK → Host seam 覆盖转换、未知字段、参数校验失败、原始日志与实际参数不同的情况，证明审批预览／指纹与执行一致，拒绝不产生副作用。错误应保留可定位信息并脱敏，不绑定旧 TypeBox 英文错误原文。

## 模型、费用与会话

依据 [Usage / AssistantMessage 类型](https://github.com/earendil-works/pi/blob/v1.5.0/packages/ai/src/types.ts) 和 [会话推理设置实现](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/src/core/agent-session.ts)：

- `getAvailableThinkingLevels()` 及模型能力是 UI 档位来源。支持 off 时显示关闭；不支持时不提供。SDK clamp 后的有效值要反馈到界面并按会话保存，不能固定整个产品都为 off 或 high。
- 上游支持部分模型在对话中改变 effort，不等于授权 PiDock 在执行中的任意时刻改配置；继续遵守应用的安全会话边界。新默认 OpenAI 模型不改变既有 Provider / 模型显式绑定。
- 模型名称、Provider profile、请求 ID 与实际 responseModel 分别表达；保留具体响应元数据不等于开放虚拟模型管理。
- `cost.totalFromProvider === true` 只说明 total 为供应商实报；缺失或 false 表示估算。组件费用仍来自目录估算，不能因总额实报而称所有组件实报。合并只有所有部分都实报才标为实报；未提供费用的旧记录保持未知。
- 当前 kernel 的流式事件和 JSONL 投影只传递四个 Token 计数，固定 `thinkingLevel: "off"`；不能把新字段的存在描述为已接通。这些差额分别在 #139 和 #134 / #154 中验证。
- 历史兼容至少覆盖 0.87.1、1.4.0 备份到 1.5.0，以及回退读取／拒绝边界。上游会话格式与写失败修复不证明 PiDock 跨存储原子性；恢复不能重放模型或工具副作用。

## MCP、Skills 与配置

依据 [MCP 配置与 OAuth](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/docs/mcp.md)、[SDK 装配示例](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/examples/sdk/14-codemode-mcp.ts)、[扩展信任与参数约定](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/docs/extensions.md)：

1. SDK 的 MCP 仍需显式资源 loader、扩展装配和 `bindExtensions()`。连接发生在 session_start；不把 CLI 自动发现直接搬入隔离 worker。
2. MCP 支持 stdio 与 Streamable HTTP，**不支持 legacy SSE**。Pencil S09 的 SSE 文案须同步更正。HTTP OAuth 凭据按 server name + URL 归属；配置变化不把旧凭据绑定到其他目标。
3. `clientRegistration` 默认 auto，可选 dcr / cimd；显式 clientId、clientName 和 callbackUrl 有组合约束，保存和 UI 测试必须保留。授权页仅允许 HTTP(S)，回调按原生 loopback 约束校验。系统浏览器登录不恢复内置浏览器范围。
4. MCP 默认 codemode 暴露可能激活 codemode，deferred 可能激活 tool_search。首版基本真实调用应显式选择 direct 的受管工具子集，不能靠默认配置悄悄新增 codemode。若未来启用间接调用，所有路径仍必须进入 Host broker。
5. Windows Skills 来源须按实际平台路径身份去重，不能仅用路径原文；同一源的盘符大小写变体不算重名技能。将普通验证警告和真实同名冲突分开，显示明确拒绝信任／加载失败的原因。
6. 已保存的拒绝项目资源信任继续生效；工作空间登记、允许读目录和允许加载代码／配置是不同授权。范围明确的 Skills 或 MCP 来源不能顺便启用任意项目扩展、脚本或模型配置命令。
7. 原生配置管理是受支持设置的有界投影。`selfUpdateCommand`、扩展更新通知和非固定包自动刷新不进入首版设置页，不让用户全局 CLI 更新改变随包固定 SDK。Packages / Extensions 用户管理仍延后。

## 命令与桌面验证

上游 [coding-agent changelog](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/CHANGELOG.md) 的 `pi.exec()` 修复包括 maxBuffer、truncated、超时／取消后 5 秒升级 SIGKILL、UTF-8 分块及 spawn 错误；macOS bash 取消还修复了命令列表继续执行下一条的问题。本项目生产走自有 Host executor，不能把这组上游测试当作自身验收。#140 / #153 / #22 须分别验证实际路径，并如实呈现截断和失败；不机械地照搬上游 256 MiB 默认值或把 SIGKILL 的 POSIX 行为当成 Windows 策略。

React 消息和工具卡片仍需自己的流式性能验证。大工具参数、长代码、深嵌套 Markdown、中文标点链接、分块 UTF-8、焦点／滚动及取消应在真实 renderer 上检查；不新增内置终端来承接 TUI 改善。部分参数未完成时不执行、不请求审批。现有有界事件／投影上限应有可解释错误，不能因追求性能移除限制。

## 本轮证据与未交付边界

本轮验证只包括固定 tag 与 npm 元数据核对、源码／设计静态核查、文档一致性和 GitHub 原生关系回读。1.5 的类型检查、SDK 行为、真实模型、MCP、跨进程、Windows 安装与 macOS 产品回归均尚未运行。所有新加验收保持未勾选，#134 原有 1.4 已勾选记录保留在历史范围；不把本报告作为升级已完成的证据。
