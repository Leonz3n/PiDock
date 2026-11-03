# 首版规格入口

权威规格已迁移到 [GitHub 首版父规格 #1](https://github.com/Leonz3n/PiDock/issues/1)，当前范围与验收见 [2026-11-02 首版收口 #135](https://github.com/Leonz3n/PiDock/issues/135)。本页保留规格入口，不维护第二份规格。

原 `.scratch/` 目录及本地旧规格快照已清理。需要核对历史需求时查看 [删除前的规格快照](https://github.com/Leonz3n/PiDock/blob/3ae10dd9b1133b32068cf563424554861a56407e/.scratch/pidock-mvp/spec.md)；该快照仅用于追溯，现行范围仍以 GitHub 最新说明为准。

当前首版包含工作空间 → 任务 → 会话、定时任务、Provider/MCP/Skills 的 UI 管理、日间 / 夜间 / 跟随系统外观、会话生命周期，以及 Git 仓库和普通目录。工作空间复用来源、环境变量和分支约定，任务继承并可局部覆盖；Git 默认自动创建独立 worktree，普通目录共享原文件。旧规格中的“项目”是当前工作空间的历史名称。**已有目录与独立 worktree 两种方式都在首版**；服务编排、环境模板、内置浏览器与业务联调等按 #135 延后。旧规格和评论与新范围冲突时，以 #135 及父规格顶部的最新说明为准。

当前 UI 设计已统一为 [Pencil 设计稿](design/PiDock.pen)，布局、视觉和关键交互以 [设计说明](design/README.md) 为准。旧 UI 候选与 HTML 原型已清理，历史界面不再作为实现目标。本次整理不启动产品实现；执行控制继续见 #1 和 #135；[#24](https://github.com/Leonz3n/PiDock/issues/24) 的旧原型 A 对齐目标已被取代并关闭。
