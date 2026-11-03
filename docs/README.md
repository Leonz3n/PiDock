# 文档导航与适用范围

当前功能规格与验收由 [首版收口 #135](https://github.com/Leonz3n/PiDock/issues/135) 管理，[父规格 #1](https://github.com/Leonz3n/PiDock/issues/1) 提供工单入口。界面以 [Pencil 设计](design/README.md) 为唯一基准。历史文档、已关闭工单和截图只证明当时记录的范围，不自动成为首版要求或新版验收结果。

## 当前入口

| 入口 | 用途 |
| --- | --- |
| [首版规格入口](mvp-spec.md) | GitHub 权威规格、范围与执行控制 |
| [设计说明](design/README.md) | 17 个 Pencil 画板、工作空间 / 任务 / 会话、关键交互 |
| [外观](design/APPEARANCE.md) / [主题数据](design/appearance.tokens.json) | 日间、夜间、跟随系统 |
| [领域术语](../GLOSSARY.md) | 工作空间、任务工作区及其他概念 |
| [技术栈](implementation-stack-design.md) | Electron / Host / SDK worker / renderer 的现行职责边界 |
| [首版验证计划](mvp-validation-plan.md) | 缩减范围的真实桌面验收场景 |
| [Pi 1.4 适配报告](pi-1.4-upgrade-review.md) | 已固定 SDK 版本、已验证能力和残留 |
| [Agent 协作](agents/issue-tracker.md) / [标签](agents/triage-labels.md) / [领域文档](agents/domain.md) | 工单、执行控制和文档规则 |

工作空间保存可复用来源、环境变量和分支约定；任务选择来源，Git 默认自动准备独立 worktree，普通目录共享原文件，已有 Git 目录模式仍保留。环境变量继承与任务覆盖属于当前基本配置，按环境组织的服务模板、依赖图与编排继续延后。设置管理 Pi 原生配置；画板中的示例路径、协议、数量及模型需按仓库固定的 Pi 版本核实，通用扩展安装管理仍不属于首版。

## 现有实现与操作记录

这些资料可以帮助复用代码或复查证据；其中已移出首版的模块不构成交付前置，命令、行号和计数应按记录的提交理解。

| 资料 | 适用范围 |
| --- | --- |
| [任务图与模块记录](task-graph.md) | 工程入口及历次实现记录；旧产品模块章节不是当前排期 |
| [Electron 打包](electron-packaging.md) | 构建说明及按日期、版本划分的安装证据；#22 内部分发 / #80 对外发布分开 |
| [工具链预热](toolchain-warmup.md) | 当时机器和网络记录；现行脚本 / lockfile 决定版本 |
| [任务根覆盖](desktop-task-root-coverage.md) | #36 的测试覆盖与未测项 |
| [证据目录](evidence/README.md) | 历史截图、Host / 退出 / 恢复等运行证据 |
| [ADR](adr/) | 已作出的技术决策；0001 使用当前工作空间术语，0002 / 0005 的服务设计延后 |

## 历史研究与被取代的设计

以下文件保留来源、失败和取舍，供需要追溯时阅读；其中“当前”“首版”“下一步”“必须”等用语仅描述原记录时点。当前规格与 Pencil 设计覆盖冲突内容。

| 类别 | 文件 |
| --- | --- |
| 早期产品设计 | [design-notes](design-notes.md)、[product-design-closure](product-design-closure.md)、[renderer-baseline-review](renderer-baseline-review.md) |
| 桌面运行时选型 | [desktop-runtime-research](desktop-runtime-research.md)、[electrobun-runtime-source-review](electrobun-runtime-source-review.md)、[electrobun-runtime-recheck](electrobun-runtime-recheck.md)、[webviewjs-runtime-review](webviewjs-runtime-review.md)、[webviewjs-agent-browser-capability-review](webviewjs-agent-browser-capability-review.md)、[electron-node-fit-review](electron-node-fit-review.md)、[browser-automation-validation](browser-automation-validation.md) |
| Pi 早期接口调研 | [pi-provider-usage](pi-provider-usage.md)、[pi-composer-capabilities](pi-composer-capabilities.md)、[pi-extensibility-and-remote-access](pi-extensibility-and-remote-access.md)；接口以固定 Pi 1.4 和适配报告重新核实 |
| 延后的业务联调 | [pilot-repository-inspection](pilot-repository-inspection.md)、[pilot-synchronous-query](pilot-synchronous-query.md)、[pilot-env-recon-2026-09-23](pilot-env-recon-2026-09-23.md) |
| 竞品调查 | [desktop-agent-project-task-model-research](desktop-agent-project-task-model-research.md)、[thinkrail-primary-source-research](thinkrail-primary-source-research.md) |
| 工程与工单迁移 | [setup-draft](setup-draft.md)、[github-issues-migration](github-issues-migration.md)、[迁移 JSON](github-issues-migration.json)；旧逻辑编号与 GitHub 号码的映射只作追溯 |

旧完整验证计划可通过 [Git 历史](https://github.com/Leonz3n/PiDock/blob/3ae10dd9b1133b32068cf563424554861a56407e/docs/mvp-validation-plan.md) 查看。旧 HTML 原型、候选设计、`.scratch` 规格副本已经移除，无需恢复；原始提交中的路径和迁移 JSON 的 `formerSource` 是历史信息。
