# 初稿参考图

采集自本轮 Apple A 首版可交互原型，2026-11-02。项目名、路径、模型、用量、执行报告和连接状态均为虚构演示数据；图片只用于结构与视觉参考。A 是建议继续设计的起点，B 只作比较。

| 文件 | 参考内容 | 使用边界 |
| --- | --- | --- |
| [01-task.jpg](01-task.jpg) | 任务对话、侧栏、会话标签与输入框 | 提高必要元信息字号；混合来源不整体称为隔离 |
| [02-task-info.jpg](02-task-info.jpg) | 按需任务信息栏、worktree 与普通目录 | 逐来源明确方式和实际路径 |
| [03-project.jpg](03-project.jpg) | 项目总览、任务与来源 | 下方来源区域需要滚动；补齐空态与编辑 |
| [04-create-task.jpg](04-create-task.jpg) | 创建表单顶部、混合来源选择 | 内部可滚动，预览未完全展开；完整字段与预览按 FLOWS.md 设计 |
| [05-preparation-failed.jpg](05-preparation-failed.jpg) | 准备失败提示与详情 | 此图只有一个失败 worktree 和共享目录；多仓库部分成功/恢复需另画 |
| [06-sessions.jpg](06-sessions.jpg) | 全部会话、搜索与归档入口 | 需补归档页、删除确认和运行中状态 |
| [07-schedules.jpg](07-schedules.jpg) | 定时任务列表、运行规则和历史 | 需补跳过/失败与下一次运行未知状态 |
| [08-schedule-editor.jpg](08-schedule-editor.jpg) | 定时规则编辑 | 模型需区分 Provider profile；补验证错误 |
| [09-providers.jpg](09-providers.jpg) | 模型服务列表 | 补完整编辑与凭据失效；不用真实 Key |
| [10-mcp.jpg](10-mcp.jpg) | MCP 设置列表 | 开关不代表真实连接成功；补连接中与失败 |
| [11-skills.jpg](11-skills.jpg) | Skills 设置列表 | 补来源、失效和加入草稿入口 |
| [12-cleanup.jpg](12-cleanup.jpg) | 清理范围确认 | 补保留位置与部分失败；演示文字不进入产品 |
| [13-compact.jpg](13-compact.jpg) | 720px 最小桌面窗口 | 不是移动端；验证详情/导航浮层与内部滚动 |
| [14-flat-alternative.jpg](14-flat-alternative.jpg) | B 图标栏 + 项目任务列 | 可选结构探索，不与 A 导航叠加 |

除 04 为保留对话框完整底部操作使用 **1440×900** 外，宽图均为 1440×900 视口裁去底部评审栏后的 **1440×860**；13 为 720×560 裁至 **720×524**。04 背景底部的模糊评审栏仍不属于产品。目标画板尺寸仍为 1440×900 与 720×560。

不要复制「DESIGN REVIEW」「内存演示」「本地原型」「演示准备失败」、假报告或模拟调度说明。不要照搬小字、低对比度文字、任务整体隔离标签和缺少 Provider profile 的模型名。文档规则优先于图；未截图状态见 [SCREENS.md](../SCREENS.md) 和 [FLOWS.md](../FLOWS.md)。
