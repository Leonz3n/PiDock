# GitHub Issues

仓库：[`Leonz3n/PiDock`](https://github.com/Leonz3n/PiDock)。首版父规格与工单索引：[#1](https://github.com/Leonz3n/PiDock/issues/1)。GitHub Issue 是规格、工单验收、依赖和执行记录的权威来源；当前功能与验收统一见 [#135](https://github.com/Leonz3n/PiDock/issues/135)，UI 以 [Pencil 设计说明](../design/README.md) 为准，资料适用范围见 [文档导航](../README.md)。旧原型 A 工单和迁移快照用于追溯。

## 读取与执行

1. 读取目标 issue 的完整正文、评论、父规格，以及 GitHub 原生 blocked-by 关系；不能只读列表标题或本地旧副本。
2. 核对执行控制和阻塞项。当前首版所有未完成工单暂停；`ready-for-agent` 仅表示规格就绪，迁移、无阻塞项或标签存在均不构成开工授权。
3. 恢复执行后按依赖前沿领取工单；仍遵守用户一次一个实现工单、串行委派的安排。开始前检查原 worktree 和未提交内容，避免覆盖已有工作。
4. 将验收勾选、未测/失败项、实际运行证据及提交/PR 链接更新到该 issue。全部交付后关闭 issue；技术实验以实验已完成和结论已记录为关闭依据，保留未通过能力的边界，不伪造勾选。

## 创建与关系

- 在本仓库创建独立 issue，包含可交付行为、验收项、父规格、直接阻塞项和执行控制。发布前完成规格与拆分审阅；已审阅的拆分不重复 triage。
- 同时维护父 issue 的原生 sub-issue 关系和阻塞 issue 的原生 blocked-by 关系。正文列出真实 GitHub issue 链接供阅读；原生关系不支持时明确记录失败并暂以正文为准，不声称已建成。
- GitHub issue 号码与旧 01–21 逻辑编号不同，不靠同名数字猜测。映射见 [迁移索引](../archive/github-issues-migration.md)。
- 用 `gh issue view/create/edit/close` 和 GitHub API 操作；长正文通过文件或结构化参数提交，保留真实换行。发布前检查已有 issue 和迁移标识，避免重复创建。

## 仓库文件

已迁移的工单正文、草稿和旧拆分索引从仓库删除，不保留本地工单副本；历史内容可通过 Git 历史和 GitHub 迁移快照追溯。编号映射与校验记录保存在迁移索引中。

现行规格入口见 [首版规格](../mvp-spec.md)。迁移时的本地规格快照已从工作树移除，通过该入口的 Git 历史链接追溯；技术设计文档继续保留。规格与工单验收、依赖及执行记录以 GitHub 为准。

迁移时的实验分支和未完成 worktree 状态是历史记录，见迁移索引；本次整理未核实或处置这些分支。领取前检查当时的实际工作区。文档与 issue 整理不恢复暂停实现；已关闭工单的历史交付不自动通过 #135 的新增验收。
