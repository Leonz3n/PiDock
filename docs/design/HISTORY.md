# 设计历史、原型与证据索引

本页把散落在 `docs/`、`prototypes/` 和 `docs/evidence/` 的设计相关材料收进一个入口，但**不移动原文件**：这些文档被 Issue、ADR、证据日志和验证记录大量引用，移动会破坏既有链接。当前设计与交付包见 [README](README.md)，方向对照见 [DECISIONS](DECISIONS.md)。

## 1. 文档

| 文档 | 性质 | 现在怎么用 |
| --- | --- | --- |
| [产品设计收口](../product-design-closure.md) | **现行行为规则**：审批/拒绝/过期、重试、失败草稿、定时确认、关注入口、归档恢复、清理边界 | 设计必须遵守；与 #135 冲突时以 #135 为准 |
| [首版规格](../mvp-spec.md) | **现行范围摘要** | 范围入口；详细验收见 #135 / #1 |
| [实现栈设计](../implementation-stack-design.md) | **现行技术边界**：Electron、utilityProcess、renderer sandbox、IPC 约束 | 设计不要假设未定的传输协议或进程能力 |
| [设计记录](../design-notes.md) | 历史：2026-09 的需求、取舍与早期布局讨论 | 只作背景；其中“内置终端/浏览器、服务编排、A 为实现基线”等早期表述已被 #135 / #24 取代 |
| [首轮 UI 草稿审阅](../ui-prototype-review.md) | 历史：A/B/C 布局与逐页交互评审 | 只作交互来源；A 不再是必须复刻的视觉目标（#24） |
| [渲染层基线评审](../renderer-baseline-review.md) | 实现证据：renderer 与旧原型的逐页对照、覆盖表、未复原项 | 查“实现了什么/没实现什么”，不是设计稿 |
| [MVP 验收计划](../mvp-validation-plan.md) | 验收草案 | 设计评审通过后，实现验收仍按此计划和 #135 执行 |

> 旧文档中的“绿色表示成功”“A 工作台为实现基线”“内置终端/浏览器属于首版”等说法是当时记录，不再作为当前设计指令。当前硬约束以 [README §2](README.md#2-两套候选) 和 #135 为准。

## 2. 交互原型

| 位置 | 内容 | 边界 |
| --- | --- | --- |
| [prototypes/pidock-ui/](../../prototypes/pidock-ui/README.md) | 完整内存原型：工作台、任务、项目、环境、Provider、定时、能力、远程、清理等 | 所有数据与操作均为页面内存模拟；不连接真实文件、Git、Provider 或调度 |
| [MVP-REVIEW.md](../../prototypes/pidock-ui/MVP-REVIEW.md) | 本轮 MVP 范围、交互和验证边界 | 评审材料，不是实现规格 |
| [APPLE-REVIEW.md](../../prototypes/pidock-ui/APPLE-REVIEW.md) | Apple 侧栏/工作台的评审记录 | 对应 `stitch-apple` 候选；不代表已验收 |
| [REDESIGN.md](../../prototypes/pidock-ui/REDESIGN.md) | Redesign A/B/C 对照 | 历史探索；A/B/C 布局未选定 |

原型只用于讨论版式和交互，**不能**作为真实运行、跨平台或性能验收证据。

## 3. 证据

| 位置 | 内容 |
| --- | --- |
| [renderer-baseline-2026-09-22](../../docs/evidence/renderer-baseline-2026-09-22/verification-log.md) | renderer 截图、测量、锚点跟随、品牌标记与差异日志 |
| [ui-alignment-s3](../../docs/evidence/ui-alignment-s3/verification-log.md) | 会话状态、审批字段、清理与恢复的逐项覆盖 |

证据日志记录的是当时实现与旧原型的对照；当前设计候选的参考图不替代这些验证。

## 4. 当前交付包

| 位置 | 内容 |
| --- | --- |
| [quiet-ledger/](quiet-ledger/README.md) | Quiet Ledger 的 DESIGN.md、Stitch 任务书、11 张参考图、Figma SVG、tokens、生成工具 |
| [stitch-apple/](stitch-apple/README.md) | Apple 风格的 DESIGN.md、提示词、14 张参考图、SCREENS/FLOWS/CHECKLIST、tokens、打包校验 |
| `pidock-stitch-apple-2026-11-02.zip` | Apple 包的独立压缩副本；解压后为 `stitch-apple/` |

两套包的状态、校验结果和未决事项见各自 README 与 [DECISIONS](DECISIONS.md)。选定前不要把任一套描述为“最终设计”。
