# 技术文档

修改技术边界或 SDK 接入时从这里查阅。当前产品范围与执行控制见 [#135](https://github.com/Leonz3n/PiDock/issues/135)，界面交互见 [设计说明](../design/README.md)。

| 何时阅读 | 文档 |
| --- | --- |
| 修改 Electron main、Agent Host、SDK worker、renderer、持久化或权限边界 | [技术栈与进程边界](implementation-stack-design.md) |
| 修改 Pi 会话、工具、MCP、取消或恢复适配 | [Pi 1.5 升级设计](pi-1.5-upgrade-design.md) 为目标；实际依赖仍为 1.4.0，历史已验证范围见 [Pi 1.4 适配报告](pi-1.4-upgrade-review.md) |
| 涉及已有决策的取舍 | [ADR](../adr/)；0002 / 0005 的服务设计属于延后范围 |
| 需要追溯桌面壳、浏览器或旧 Pi 接口选型 | [历史研究索引](../archive/README.md) |

本文档目录与 [根 GLOSSARY](../../GLOSSARY.md)、[docs/adr/](../adr/) 共享同一个领域上下文。
