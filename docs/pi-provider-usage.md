# pi Provider、上下文与 Token 能力核对

2026-09-20 只读核对 pi-mono 当前 main 的 SDK 文档与源码。未安装 SDK、调用模型或运行兼容性测试；实现时应固定 SDK 版本并重新验证接口。

## 已有能力

| 能力 | 已核对事实 | 参考 |
| --- | --- | --- |
| 多 Provider 与自定义模型 | ModelRuntime 提供 Provider/模型查询和认证；自定义配置支持服务地址、协议、模型列表与窗口信息 | [SDK](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/sdk.md)、[Custom Models](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/models.md) |
| 会话内切换 | AgentSession.setModel 接受带 provider 的模型，检查认证并写入 model change；仅显式 persist 时更新默认配置 | [AgentSession 源码](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/agent-session.ts) |
| 上下文用量 | getContextUsage 返回 tokens、contextWindow、percent；当前窗口未知时无结果，压缩后尚无可靠新 usage 时 tokens/percent 可为 null | 同上 |
| 会话用量 | getSessionStats 遍历全部会话记录，包含被压缩的历史、独立 usage、压缩/分支摘要以及带 usage 的工具结果 | 同上 |
| 响应用量字段 | Usage 包含 input/output/cacheRead/cacheWrite/totalTokens；可选 reasoning 已包含于 output；AssistantMessage 带 provider/model 及可选 responseModel/responseId | [pi-ai types](https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/types.ts) |

## 模型上下文窗口可配置性（补充核对）

结论：支持。在模型定义上配置 `contextWindow`，不是向 `prompt()` 额外传一个上下文参数。依据已读取的 pi 文档与源码：

- [Model 类型](https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/types.ts) 包含 `contextWindow: number` 和独立的 `maxTokens: number`。
- [Custom Models 的 Model Configuration](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/models.md#model-configuration) 允许每个自定义模型设置 `contextWindow`，单位为 Tokens，未填写时文档默认值为 128000；`maxTokens` 是最大输出 Tokens，含义不同。内置模型也支持通过 `modelOverrides` 覆盖窗口。
- [SDK 的 Model 章节](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/sdk.md#model) 展示从 ModelRuntime 获取自定义模型并传给 createAgentSession 的方式；[AgentSession](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/agent-session.ts) 的 `setModel()` 接受模型对象，`getContextUsage()` 使用当前模型的窗口计算占比。
- AgentSession 的自动压缩检查将当前模型的窗口传给 [shouldCompact](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/compaction/compaction.ts)。所核对实现中，启用自动压缩且上下文 Tokens 大于 `contextWindow - reserveTokens` 时触发阈值压缩；`reserveTokens` 属于压缩设置，不等于简单取 `maxTokens`。

桌面端应按 Provider/模型分别保存窗口，经过配置加载或模型注册提供给运行时；界面改值后，在当前执行完成的边界应用到会话所使用的模型对象，不只改显示数字。窗口缩小时重新评估压缩条件与现有上下文，不在执行中的请求内替换模型元数据。

该值描述本地管理上下文所依据的容量，不会改变供应商或网关实际接受的限制。128000 是自定义配置的 SDK 默认值，不是所有模型已核实的容量。原型增加每模型输入及随选择变化的占比，只证明 UI 行为；本次为文档与源码核对，未安装 SDK 或调用模型验证。

## 桌面应用的接入工作

- Provider 配置的图形化管理、稳定配置身份、同供应商多套连接及本机凭据存储。SDK 能加载自定义配置不等于已有桌面配置界面。
- 切换请求与回合、工具执行、压缩之间的协调。已检查的 setModel 实现没有替应用提供完整的忙碌切换流程，应用需要在安全边界执行。
- 上下文窗口切换、能力不兼容和历史适配的可见状态；跨 Provider 原生思维签名和缓存不能假定可复用。
- 区分 SDK 给出的估算/未知状态与供应商实报的 usage；类型中必填数字或零初始化并不证明供应商真的报告了该值。
- 按调用持久化带归属的用量记录，支持多会话、多 Provider、项目和时间维度统计。不能每次轮询 getSessionStats 都把累计值作为新增量。
- 明确失败、取消、自动重试、压缩与工具中的模型调用有多少 usage 可观测；不保证恢复上游已计费但从未传回的数据。
- 恢复及会话克隆的来源去重。SDK 会话统计可供局部校验，但不能直接替代跨会话统计，因为复制的历史可能出现在多个会话。

## 验收重点

使用两套 Provider 配置在同一会话中连续回答，保留各条响应的实际归属。切换后上下文窗口重新评估；进行中的请求不会被改写。

以已知输入/输出/缓存和 reasoning 字段的样例验证归一化；加入压缩调用、重试、取消、缺失 usage、重放事件和会话恢复，检查累计值不丢失也不重复。实际模型只用于联通与适配验证，确定性统计校验不依赖远程响应恰好返回某个 Token 数。

## 最大输出、图片能力与推理档位（补充核对）

依据 [Custom Models](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/models.md#model-configuration) 和 [Model 类型](https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/types.ts)：`maxTokens` 可按模型设置；`input` 可为 `["text"]` 或 `["text", "image"]`；`reasoning` 表示支持思考，但仅此布尔值不足以描述每个模型的可选档位。UI 中勾选能力是本地声明，不是上游能力探测结果。

[Thinking Level Mapping](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/models.md#thinking-level-map) 描述模型的 `thinkingLevelMap`：键包含 off、minimal、low、medium、high、xhigh、max，允许不连续的子集。字符串表示支持并映射到服务端值；null 表示不支持；省略普通档位会采用默认映射，而省略 xhigh/max 表示不支持，不能以省略所有未勾选字段实现禁用。off 也可为 null，表达不可关闭思考。

[AgentSession](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/agent-session.ts) 提供 `getAvailableThinkingLevels()` 和 `setThinkingLevel()`；设置会夹取至模型可用范围，因此桌面端应读取最终生效值，不能一直显示用户请求但实际未生效的档位。模型切换会考虑每模型偏好及默认值，桌面端仍需保障自身的会话级偏好隔离和可见提示。

统一档位并不保证各协议有同样的实现。pi 的类型还单独声明 token-based providers 的 `thinkingBudgets`；数值预算、自适应策略等需要按模型和适配器验证，不能用任意 effort 字符串替代。当前结论为文档与源码核对，未做上游协议联通测试。
