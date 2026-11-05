# 文档导航

功能范围、验收和执行控制以 [首版收口 #135](https://github.com/Leonz3n/PiDock/issues/135) 为准，[父规格 #1](https://github.com/Leonz3n/PiDock/issues/1) 提供工单索引。界面以 [Pencil 设计](design/README.md) 为准。

## 按任务查阅

| 要做的事 | 阅读入口 |
| --- | --- |
| 确认首版范围或领取工单 | [规格入口](mvp-spec.md)、[GitHub 协作规则](agents/issue-tracker.md) |
| 讨论领域概念 | 根目录 [GLOSSARY.md](../GLOSSARY.md) |
| 设计或实现界面 | [设计说明与画板索引](design/README.md) |
| 修改进程、权限、持久化或 SDK 接入 | [技术文档](architecture/README.md)，以及相关 [ADR](adr/) |
| 开发、构建、打包或复查已有实现 | [开发资料](development/README.md) |
| 验收当前首版 | [真实桌面验证计划](mvp-validation-plan.md) |
| 查找运行截图、日志和失败记录 | 本机 `docs/evidence/`（不纳入版本控制，见下方“证据”） |
| 追溯旧设计、选型、调研或工单迁移 | [历史资料索引](archive/README.md) |
| 调整 Agent 协作方式 | [工单规则](agents/issue-tracker.md)、[标签](agents/triage-labels.md)、[领域文档规则](agents/domain.md) |

## 资料归属

- `GLOSSARY.md` 保存领域术语；`docs/adr/` 保存有取舍背景的技术决策，采用单上下文结构。
- GitHub Issues 保存规格、工单、依赖与执行记录；仓库中的规格入口链接到权威记录。
- `design/` 保存唯一 UI 设计及配套外观资料；`architecture/` 保存现行技术边界与适配依据。
- `development/` 保存开发操作和既有实现记录；命令和版本使用前核对当前脚本与 lockfile。
- `evidence/` **不入库**：运行验证的截图、日志与失败记录是单机产物，该目录已在 `.gitignore` 中；`archive/` 保存历史研究和被取代的设计，按需追溯。

## 证据

- 采集脚本仍默认写入 `docs/evidence/`，方便本机复查；它不再进入版本历史，也不随仓库分发。
- 可重复、体积小的合成夹具放入所在包的 `test-fixtures/`：需要随仓库分发的东西不能只放在 `docs/evidence/`。
- 跨机器交接证据时，另行归档（例如 Issue 附件或独立的存储位置），不要把整目录重新提交进仓库。

新增文档按用途放入对应目录，并在本页或该目录的索引中加入阅读条件。优先链接已有依据，使每项约定有明确的维护位置。

历史文档中的“当前”“首版”和“下一步”描述原记录时点；已关闭工单、设计稿和历史截图仅证明各自记录的范围，不自动代表新版实现或验收通过。
