# GitHub Issues 迁移索引

2026-09-22。仓库：[Leonz3n/PiDock](https://github.com/Leonz3n/PiDock)；父规格与执行控制：[https://github.com/Leonz3n/PiDock/issues/1](https://github.com/Leonz3n/PiDock/issues/1)。

按 ask-matt 流程判断，此次不需要重新进行完整设计访谈或重拆工单：用户已确认产品目标、技术栈与进程边界，原型与源码复核已经记录取舍，剩余运行风险由 21、02、06、15 验收。具体驱动、IPC 消息形状等局部实现选择不阻止迁移，21 的运行验证也不能被这次文档检查替代。

21 个既有逻辑工单迁移为独立 GitHub issue，另建 1 个父规格 issue。编号保持语义但不强行等于 GitHub 号码。GitHub 原生 sub-issue 表达父子关系，blocked-by 表达直接依赖；正文同步可读链接。已删除仓库内 21 份工单、19 份旧草稿及旧拆分索引；规格和技术设计文档保留，GitHub 是工单权威记录。

- 01：实验及复核完成，关闭为 completed；保留未通过/未测验收项及历史证据，不表示 Electron 已通过。
- 20：未完成，已有未提交 renderer 工作区保留，仍暂停。
- 其余实现工单：open，均标明暂停。ready-for-agent 表示规格就绪，不构成启动授权。
- 规格与最新设计包含尚未推送的本地修改，已经作为父 issue 正文及文档快照评论发布。没有推送 Git 分支、合并代码或推进后续实现。

## 编号映射

| 原编号 | GitHub Issue | 直接阻塞的 GitHub Issue |
| --- | --- | --- |
| 01 | [#2 [PiDock 01] 可见页面控制与桌面壳技术验证](https://github.com/Leonz3n/PiDock/issues/2) | 无 |
| 02 | [#5 [PiDock 02] 单仓库任务与 pi 会话](https://github.com/Leonz3n/PiDock/issues/5) | [#3](https://github.com/Leonz3n/PiDock/issues/3)、[#4](https://github.com/Leonz3n/PiDock/issues/4) |
| 03 | [#6 [PiDock 03] 混合目录任务与 Git 工作副本隔离](https://github.com/Leonz3n/PiDock/issues/6) | [#5](https://github.com/Leonz3n/PiDock/issues/5) |
| 04 | [#7 [PiDock 04] 图形化环境配置与单服务运行](https://github.com/Leonz3n/PiDock/issues/7) | [#5](https://github.com/Leonz3n/PiDock/issues/5) |
| 05 | [#10 [PiDock 05] 多服务联动与运行状态](https://github.com/Leonz3n/PiDock/issues/10) | [#6](https://github.com/Leonz3n/PiDock/issues/6)、[#7](https://github.com/Leonz3n/PiDock/issues/7) |
| 06 | [#8 [PiDock 06] Agent 控制任务浏览器](https://github.com/Leonz3n/PiDock/issues/8) | [#5](https://github.com/Leonz3n/PiDock/issues/5) |
| 07 | [#13 [PiDock 07] 真实对账单详情同步验证](https://github.com/Leonz3n/PiDock/issues/13) | [#10](https://github.com/Leonz3n/PiDock/issues/10)、[#11](https://github.com/Leonz3n/PiDock/issues/11) |
| 08 | [#14 [PiDock 08] 任务内协议生成与消费者绑定](https://github.com/Leonz3n/PiDock/issues/14) | [#10](https://github.com/Leonz3n/PiDock/issues/10) |
| 09 | [#11 [PiDock 09] 多会话协作与写操作协调](https://github.com/Leonz3n/PiDock/issues/11) | [#7](https://github.com/Leonz3n/PiDock/issues/7)、[#8](https://github.com/Leonz3n/PiDock/issues/8) |
| 10 | [#15 [PiDock 10] 文件浏览、差异与内置终端](https://github.com/Leonz3n/PiDock/issues/15) | [#11](https://github.com/Leonz3n/PiDock/issues/11) |
| 11 | [#9 [PiDock 11] 多 Provider 与会话上下文状态](https://github.com/Leonz3n/PiDock/issues/9) | [#5](https://github.com/Leonz3n/PiDock/issues/5) |
| 12 | [#12 [PiDock 12] Token 用量明细与汇总](https://github.com/Leonz3n/PiDock/issues/12) | [#9](https://github.com/Leonz3n/PiDock/issues/9) |
| 13 | [#16 [PiDock 13] 对话引用、技能与符号命令](https://github.com/Leonz3n/PiDock/issues/16) | [#6](https://github.com/Leonz3n/PiDock/issues/6)、[#15](https://github.com/Leonz3n/PiDock/issues/15)、[#12](https://github.com/Leonz3n/PiDock/issues/12) |
| 14 | [#17 [PiDock 14] 后台、恢复、归档与清理](https://github.com/Leonz3n/PiDock/issues/17) | [#14](https://github.com/Leonz3n/PiDock/issues/14)、[#16](https://github.com/Leonz3n/PiDock/issues/16) |
| 15 | [#22 [PiDock 15] 跨平台桌面包与首版验收](https://github.com/Leonz3n/PiDock/issues/22) | [#13](https://github.com/Leonz3n/PiDock/issues/13)、[#17](https://github.com/Leonz3n/PiDock/issues/17)、[#18](https://github.com/Leonz3n/PiDock/issues/18)、[#20](https://github.com/Leonz3n/PiDock/issues/20)、[#21](https://github.com/Leonz3n/PiDock/issues/21) |
| 16 | [#18 [PiDock 16] 能力管理与来源](https://github.com/Leonz3n/PiDock/issues/18) | [#11](https://github.com/Leonz3n/PiDock/issues/11)、[#16](https://github.com/Leonz3n/PiDock/issues/16) |
| 17 | [#19 [PiDock 17] Host 执行状态与关注入口](https://github.com/Leonz3n/PiDock/issues/19) | [#11](https://github.com/Leonz3n/PiDock/issues/11)、[#12](https://github.com/Leonz3n/PiDock/issues/12)、[#17](https://github.com/Leonz3n/PiDock/issues/17) |
| 18 | [#20 [PiDock 18] 定时任务与可续聊历史](https://github.com/Leonz3n/PiDock/issues/20) | [#6](https://github.com/Leonz3n/PiDock/issues/6)、[#9](https://github.com/Leonz3n/PiDock/issues/9)、[#19](https://github.com/Leonz3n/PiDock/issues/19) |
| 19 | [#21 [PiDock 19] 远程访问、配对与移动端](https://github.com/Leonz3n/PiDock/issues/21) | [#19](https://github.com/Leonz3n/PiDock/issues/19) |
| 20 | [#3 [PiDock 20] 渲染层基线（React 19／TypeScript／Zustand 复原现有草稿）](https://github.com/Leonz3n/PiDock/issues/3) | 无 |
| 21 | [#4 [PiDock 21] Electron 桌面壳可见浏览器验证（已确认 Electron + Node 路线）](https://github.com/Leonz3n/PiDock/issues/4) | 无 |

操作规则见 [Issue tracker](agents/issue-tracker.md) 与 [Triage labels](agents/triage-labels.md)。
