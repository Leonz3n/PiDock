# pi 对话输入与命令接入边界

2026-09-20 只读检查 pi-mono main 文档与 AgentSession 源码，未运行 SDK。实现时固定版本并验证桌面行为；不以 TUI 文档代替 SDK 接入验收。

## 已有能力

- pi TUI 文档说明 `@` 模糊查找项目文件、Tab 路径补全和 `/` 命令入口：[coding-agent README](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md)。桌面输入框仍需自己的候选 UI、键盘和引用模型。
- pi 的显式技能入口为 `/skill:name`，参数附在技能内容之后；技能描述常驻发现，完整指引按需加载：[Skills](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/skills.md)。`$name` 为 PiDock 提供的快捷语法，不宣称是 pi 原生接口。
- 默认技能来源包括全局 pi/agents 目录、受信任项目的 pi/agents 目录及配置的额外路径；可以显式添加其他工具的技能目录。它不会天然遍历多仓库任务中所有相邻 worktree，需要应用明确聚合和作用域处理。
- ResourceLoader 提供技能、提示模板、扩展和上下文资源：[SDK](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/sdk.md)。
- AgentSession.prompt 能处理扩展命令并展开技能及提示模板；当前技能语法只在输入以 `/skill:` 开头时展开，桌面混合多个技能与文件引用不能简单依靠全局字符替换：[AgentSession](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/agent-session.ts)。
- 扩展命令可在 prompt 分派时立即执行，包括流式进行中；steer/followUp 则拒绝排队扩展命令。桌面必须先按操作类型和任务状态分派，以免绕过已有执行协调。
- 新会话等属于运行时操作，模型切换与压缩属于相应会话能力。TUI 中存在某个斜杠命令，不等于 SDK prompt 会自动实现该命令的桌面含义。

## 桌面需要补齐

多仓库文件候选、来源明确的技能注册表、应用命令注册与参数提示、结构化引用、中文输入法、跨平台路径、普通符号文字的保留、失效引用处理和草稿恢复。

应用操作、提示模板和扩展命令分开执行。应用仅展示已支持的入口，并在输入时提示当前可用状态；新增快捷入口沿用现有任务访问与副作用规则。

## 原型验收样例

- 两个仓库含同名文件、两个技能来源含同名技能；选择后读取的是所显示来源，另一任务同名文件不混入。
- 一条消息组合两个文件、代码片段、技能和普通文字，展开结果只出现一次且资源相对路径可解析。
- 邮箱、URL、Unix/Windows 路径、代码中的 `$HOME`、转义的 `@`、`$`、`/` 都保持原文；中文输入法候选确认不会提交对话。
- `/model` 调用真实选择器，`/new` 保留原任务资源，`/usage` 展示已有统计；忙碌时操作状态明确。
- 文件移动、技能失效或切换任务后，旧草稿不会静默绑定另一来源；大目录引用保持有界。
