# PiDock

PiDock 是一个面向软件开发任务的桌面 Agent 工作台。它把项目、任务工作区、Agent 会话、服务运行和本地验证组织在同一个界面中，并支持一个任务关联多个 Git 仓库与普通目录。

> 项目目前处于产品设计和交互原型阶段，尚未进入正式应用实现。`PiDock` 是当前采用的项目名称。

## 设计目标

- 为每个任务提供独立工作区，并允许跨仓库协作。
- 在桌面端统一管理 Agent 会话、文件、终端、服务和浏览器验证。
- 区分可复用的共享模板、本机私有配置和单次任务覆盖。
- 支持 Provider、Skills、Extensions、Pi Packages 和受控 MCP 接入。
- 通过明确的设备授权和权限边界支持远程访问。

## 当前内容

- [`CONTEXT.md`](CONTEXT.md)：项目领域术语。
- [首版规格](.scratch/pidock-mvp/spec.md)：当前权威 MVP 规格。
- [`docs/`](docs)：设计记录、调研和验证计划。
- [`prototypes/pidock-ui/`](prototypes/pidock-ui)：无构建依赖的交互原型。

## 查看 UI 原型

原型可以直接打开 [`prototypes/pidock-ui/index.html`](prototypes/pidock-ui/index.html)，也可以启动本地静态服务器：

```bash
cd prototypes/pidock-ui
python3 -m http.server 4319 --bind 127.0.0.1
```

然后访问 <http://127.0.0.1:4319/?variant=A>。原型中的数据和操作均为内存模拟，不会读写业务仓库、启动真实服务或调用模型。

## 开发状态

计划中的桌面应用技术方向为 Electron + TypeScript。正式实现开始前仍需完成关键技术验证和 MVP 工单拆分；当前原型用于确认产品结构与交互，不应直接作为生产代码。

## 协作约定

Agent 工作入口见 [`AGENTS.md`](AGENTS.md)。规格与实现工单采用本地 Markdown 管理，约定见 [`docs/agents/`](docs/agents)。

