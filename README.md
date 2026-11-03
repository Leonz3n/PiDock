# PiDock

PiDock 是面向软件开发任务的桌面 Agent 工作台。可复用工作空间登记 Git 仓库、普通目录和共享配置，任务选择所需来源并准备独立 worktree，Agent 会话围绕任务开展工作。

## UI 设计

**[docs/design/PiDock.pen](docs/design/PiDock.pen) 是唯一的 UI 设计基准。** 使用 Pencil 打开；画板索引、关键交互和实现约定见 [设计说明](docs/design/README.md)。

配套资料包括 [日间 / 夜间主题说明](docs/design/APPEARANCE.md) 和 [主题颜色数据](docs/design/appearance.tokens.json)。旧候选设计、HTML 交互原型及压缩交付包已清理，历史版本通过 Git 追溯。

## 项目入口

- [首版父规格与工单索引 #1](https://github.com/Leonz3n/PiDock/issues/1)：规格、依赖和执行记录。
- [当前首版范围 #135](https://github.com/Leonz3n/PiDock/issues/135)：功能范围与验收入口。
- [GLOSSARY.md](GLOSSARY.md)：工作空间、任务和会话的统一领域术语。
- [技术栈设计](docs/architecture/implementation-stack-design.md)：Electron、TypeScript、React 与 Pi AgentSession 的职责边界。
- [首版验证计划](docs/mvp-validation-plan.md)：真实桌面验证场景。
- [packages/](packages)：现有应用与共享代码。
- [文档导航](docs/README.md)：当前资料、实现记录与历史研究的适用范围。

## 开发状态

仓库包含已有桌面实现与运行验收记录；当前 UI 改版以 Pencil 设计为准。已有界面和历史截图不代表已对齐新版设计，设计稿也不代表运行功能已经实现。文档与工单已按最新设计和首版范围整理；产品实现继续遵循 GitHub 执行控制。

## 协作约定

Agent 工作入口见 [AGENTS.md](AGENTS.md)。规格与工单使用 GitHub Issues，约定见 [docs/agents/](docs/agents/)。
