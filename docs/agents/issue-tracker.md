# 本地工单

规格存放在 .scratch/<feature>/spec.md，每个实现工单独立存放在 .scratch/<feature>/issues/<NN>-<slug>.md。

工单使用 Status 标记状态，Blocked by 标明真正阻塞其开始的工单编号；按依赖顺序执行。

在发布前完成规格和工单拆分的审阅。已从规格拆出的工单可直接标为 ready-for-agent，无需再次 triage。

其他流程要求向 tracker 发布、读取或更新工单时，操作这些本地文件。
