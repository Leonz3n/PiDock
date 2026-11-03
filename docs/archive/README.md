# 历史资料索引

需要追溯来源、失败实验、旧设计或迁移关系时查阅本目录。文中“当前”“首版”“下一步”等描述原记录时点；现行范围读取 [#135](https://github.com/Leonz3n/PiDock/issues/135)，界面读取 [Pencil 设计](../design/README.md)，技术边界读取 [技术文档](../architecture/README.md)。

## 产品与界面

| 资料 | 追溯用途 |
| --- | --- |
| [早期需求与技术讨论](design-notes.md) | 产品需求、权限、目录、浏览器和远程等早期取舍 |
| [历史产品行为收口](product-design-closure.md) | 执行、审批、调度及清理的旧约定 |
| [旧渲染层基线审阅](renderer-baseline-review.md) | 已退役原型的实现、整改和验证记录 |

## 运行时选型与实验

| 资料 | 追溯用途 |
| --- | --- |
| [桌面运行时调研](desktop-runtime-research.md) | 早期候选比较 |
| [Electrobun 源码复核](electrobun-runtime-source-review.md) | 官方源码与接口边界 |
| [Electrobun 实测复核](electrobun-runtime-recheck.md) | 实验结果与否决依据 |
| [WebviewJS 运行时复核](webviewjs-runtime-review.md) | Bun 候选与持久隔离边界 |
| [WebviewJS Agent 浏览器边界](webviewjs-agent-browser-capability-review.md) | 输入、截图、frame 与网络取证缺口 |
| [Electron + Node 适配判断](electron-node-fit-review.md) | 最终选型前的分析依据 |
| [浏览器自动化验证](browser-automation-validation.md) | 旧桌面壳和同页控制实验 |

## Pi 接口与能力

旧接口结论使用前对照 [Pi 1.5 目标设计](../architecture/pi-1.5-upgrade-design.md)；实际依赖仍为 1.4.0，历史验证见 [Pi 1.4 适配报告](../architecture/pi-1.4-upgrade-review.md)。

- [Provider、上下文与用量](pi-provider-usage.md)
- [输入、引用与命令](pi-composer-capabilities.md)
- [扩展与远程访问](pi-extensibility-and-remote-access.md)

## 试点与竞品

- 追溯延后的业务联调：[仓库核对](pilot-repository-inspection.md)、[同步查询用例](pilot-synchronous-query.md)、[环境探测](pilot-env-recon-2026-09-23.md)。
- 追溯产品模型比较：[桌面 Agent 项目与任务模型](desktop-agent-project-task-model-research.md)、[ThinkRail 一手来源](thinkrail-primary-source-research.md)。

## 流程与工单迁移

- [工程流程设置记录](setup-draft.md)：当时的流程配置；当前规则见 [agents/](../agents/)。
- [GitHub 迁移索引](github-issues-migration.md) / [迁移 JSON](github-issues-migration.json)：旧逻辑编号与 GitHub issue 的对应关系。`formerSource` 等原始路径保留用于追溯。

已删除的完整规格、旧原型与候选设计通过 [规格历史入口](../mvp-spec.md) 和 Git 历史查阅。原始证据继续保存在 [evidence/](../evidence/README.md)。
