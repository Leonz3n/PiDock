# 开发与操作资料

开发、构建、打包或复查现有代码时按下表查阅。这里保留的命令、行号、计数与运行结果对应各节记录的版本；实际命令和依赖以当前脚本、配置与 lockfile 为准。

| 何时阅读 | 文档 |
| --- | --- |
| 第一次阅读仓库、理解 Electron 进程边界与本地运行方式 | [项目结构与 Electron 入门](project-structure-and-electron-guide.md) |
| 查找 workspace、构建任务、Host 接线及历次实现记录 | [任务图与模块记录](task-graph.md)；旧模块章节不作为当前排期 |
| 构建安装包或复核安装、升级、卸载证据 | [Electron 打包](electron-packaging.md)；#22 内部分发与 #80 对外发布分别验收 |
| 处理工具链下载、缓存或环境预热 | [工具链预热记录](toolchain-warmup.md) |
| 修改任务根目录发现或定位 #36 的覆盖缺口 | [任务根覆盖](desktop-task-root-coverage.md) |
| 需要原始运行材料 | 本机 `docs/evidence/`（不纳入版本控制） |

新版功能验收使用 [首版验证计划](../mvp-validation-plan.md)，功能范围和执行控制读取 [#135](https://github.com/Leonz3n/PiDock/issues/135)。
