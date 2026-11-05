# 项目结构与 Electron 入门

本文面向第一次接触本仓库或 Electron 的实现者，说明 PiDock 的仓库结构、Electron 进程边界、一次请求的完整路径，以及修改 UI / 数据 / Host 时应从哪里下手。

本文是开发导览，不替代 [技术栈与进程边界](../architecture/implementation-stack-design.md)、[Pencil 设计基准](../design/README.md) 和根目录 [GLOSSARY.md](../../GLOSSARY.md)。实际命令、依赖和版本以当前脚本、配置与 lockfile 为准。

## 1. 先理解四个角色

PiDock 不是一个“Web 前端 + 后端服务”，而是 **一个 Electron 主进程控制多个 Chromium 页面和 Node 子进程**。

| 角色 | 在项目中的位置 | 能力边界 |
| --- | --- | --- |
| main process | `packages/shell/src/main/main.ts` | 窗口、IPC、文件系统、Provider 凭据、任务 Host 生命周期 |
| preload | `packages/shell/src/preload/preload.cjs` | 在隔离世界运行，只向页面暴露白名单 `window.pidock` |
| renderer | `packages/renderer` | React 页面；`sandbox:true`、`contextIsolation:true`、`nodeIntegration:false`，不能直接使用 Node/Electron |
| utilityProcess / Agent Host | `packages/shell/src/host/*` | main 用 `utilityProcess.fork()` 启动的 Node 子进程；每个任务一个任务 Host，承载会话、工具和 SDK 执行 |

整体关系：

```text
Electron main（桌面控制面）
├─ BrowserWindow
│   └─ WebContentsView(shellView)
│        └─ preload.cjs → window.pidock
│             └─ React renderer（sandbox）
├─ IPC handlers
└─ PerTaskHostRegistry
     └─ utilityProcess（每个 task 一个 Agent Host）
          └─ TaskWorkspaceHost
               └─ SDK worker → Pi AgentSession
```

常见 Electron 术语：

- **BrowserWindow**：操作系统窗口。
- **WebContentsView**：窗口里的一个网页视图；shell 页面和任务浏览器页面各用一个 view。
- **IPC**：renderer 通过 `ipcRenderer.invoke` 请求 main，不能直接调用 Node。
- **contextBridge**：preload 用来把受控 API 挂到 `window.pidock`；页面拿不到原始 `ipcRenderer`。
- **utilityProcess**：Electron 提供的 Node 子进程，不是浏览器页面。Agent Host 运行在这里。

## 2. 仓库结构

```text
PiDock/
├─ packages/
│  ├─ renderer/        React + Vite + Tailwind 的界面
│  └─ shell/           Electron main + preload + Agent Host + RPC + 打包
├─ docs/
│  ├─ architecture/    进程边界、技术栈设计
│  └─ design/          Pencil UI 基准
├─ scripts/
├─ GLOSSARY.md         领域术语
└─ turbo.json          pnpm workspace 的任务编排
```

当前主要技术版本：

- Electron 44.4.3
- Node 24.21.0
- React 19
- Vite 7
- TypeScript 5.9
- pnpm 11 + Turborepo

根目录的 `pnpm build / typecheck / lint / test` 通过 turbo 同时编排两个 package。

## 3. 构建与启动链路

`packages/shell` 的 Electron 入口：

```text
packages/shell/package.json  "main": "dist/main/main.js"
  → packages/shell/src/main/main.ts
```

`packages/shell` 的构建顺序：

```text
@pidock/renderer vite build
  → packages/renderer/dist
  → packages/shell/scripts/copy-static.mjs 复制到 packages/shell/dist/renderer
  → tsc 编译 main / preload / host / rpc 到 packages/shell/dist
```

`dist/` 是生成物，不提交。`preload.cjs` 是 dependency-free 的普通脚本，构建时直接复制到 `dist/preload/`。

main 进程的主要职责：

- `app.whenReady()`
- 创建 workspace Host
- 创建窗口和 WebContentsView
- 初始化项目注册表、任务根、Provider、MCP、Skills、调度器
- `registerIpc(...)`
- 加载 renderer
- 处理退出、休眠、Host 回收

关键文件：

```text
packages/shell/src/main/main.ts      应用启动与依赖装配
packages/shell/src/main/runtime.ts   窗口、IPC、Host 注册与路由
packages/shell/src/main/provider-ipc.ts
packages/shell/src/main/task-hosts.ts / PerTaskHostRegistry
```

安全设置固定为：

```ts
sandbox: true
contextIsolation: true
nodeIntegration: false
```

因此 renderer 中不要 `import fs`、`import electron`，也不要尝试获取原始 `ipcRenderer`。

## 4. renderer 结构

入口链路：

```text
packages/renderer/src/main.tsx
  → App.tsx
      → 桌面模式：DesktopInventory
      → 非桌面模式：DemoApp → Shell
```

这里有一个很重要的分叉：

- **真实 Electron 桌面**：`window.pidock` 存在 → `App` 渲染 `DesktopInventory`。
- **浏览器里单独跑 Vite**：没有 `window.pidock`，UA 也不是 Electron → 渲染 `DemoApp`，使用 `data/memoryHost.ts` 的演示数据。

所以，只运行 `pnpm --filter @pidock/renderer dev` 然后在普通浏览器打开，看到的是 DemoApp，不是生产桌面 UI。

主要目录：

| 路径 | 作用 |
| --- | --- |
| `src/components/DesktopInventory.tsx` | 生产桌面总入口，管理导航、页面切换、任务打开 |
| `src/components/DesktopShell.tsx` | 桌面外壳：侧边栏、顶部、任务树、页面容器 |
| `src/components/DesktopConversation.tsx` | 任务会话页：消息、Composer、模型/推理、审批、草稿 |
| `src/components/DesktopProvidersPanel.tsx` | Provider 管理页 |
| `src/components/Desktop*.tsx` | 其他生产桌面页面 |
| `src/components/Shell.tsx` | DemoApp 的演示外壳，不是生产桌面入口 |
| `src/pages/*` | Demo/Web 页面；部分 view helper 也被桌面复用 |
| `src/components/ui/*` | shadcn/Radix 基础组件 |
| `src/styles/tokens.css` | 主题 token |
| `src/data/*` | 真实 Host 数据的解析、适配和请求封装 |
| `src/stores/*` | Zustand；主要服务 Demo、导航和 UI 状态，不是权威业务数据 |
| `src/test/*` | jsdom 渲染测试 |

数据层的特点：

- `data/shellBridge.ts`：renderer 对 preload 的 typed facade。
- `data/taskSessions.ts`、`data/providerProfile.ts` 等：把 Host 返回的 `unknown` 严格解析成领域类型；字段不对就报错，不静默兜底。
- 组件通常不直接拼 IPC，而是通过 `data/*` 的 helper 发请求。

## 5. preload 与 IPC

preload 位于：

```text
packages/shell/src/preload/preload.cjs
packages/shell/src/preload/allowlist.ts
```

它只暴露白名单方法，例如：

```text
window.pidock.taskOp(...)
window.pidock.providerOp(...)
window.pidock.sdkTurn(...)
window.pidock.onSdkTurnEvent(...)
```

页面拿不到任意 IPC channel。新增通道时，preload 和 allowlist 要一起改。

### 新增 IPC 通道至少改四处

```text
packages/shell/src/preload/preload.cjs
packages/shell/src/preload/allowlist.ts
packages/shell/src/main/runtime.ts          registerIpc
packages/renderer/src/data/shellBridge.ts   类型和 helper
```

再补对应测试。

## 6. Agent Host

每个任务一个 Host：

```text
packages/shell/src/host/host-entry.ts
  → packages/shell/src/host/host.ts
      → TaskWorkspaceHost
```

`TaskWorkspaceHost` 位于：

```text
packages/shell/src/host/task-host.ts
```

它负责：

- 任务工作区
- 多会话状态
- 工具执行边界
- Provider 安装
- SDK 会话绑定
- Git / 文件 / 命令等任务内能力

Host 和 main 之间是 typed RPC：

```text
packages/shell/src/rpc/protocol.ts
packages/shell/src/rpc/host-client.ts
```

SDK 模型执行再放到隔离的 worker：

```text
packages/shell/src/host/sdk-context-worker.ts
packages/shell/src/host/sdk-context-client.ts
packages/shell/src/host/sdk-text-kernel.ts
```

生产环境中还有一个 workspace-only Host 负责 `getVersions` / `hostPing`；真正的任务操作通过 `PerTaskHostRegistry` 路由到对应任务的 Host。

## 7. 一次请求的完整路径

以“在 Composer 里切换模型”为例：

```text
DesktopConversation.tsx
  chooseModel()
    ↓
data/taskSessions.ts
  switchSessionModel()
    ↓
data/shellBridge.ts
  window.pidock.taskOp(...)
    ↓
preload.cjs
  ipcRenderer.invoke("shell/taskOp", ...)
    ↓
main/runtime.ts
  registerIpc → PerTaskHostRegistry.routeTaskOp()
    ↓
HostClient（typed RPC）
    ↓
utilityProcess / Agent Host
  host.ts: performTaskOp("task/sessionModel")
    ↓
host/session-switch.ts
  校验 session / provider / busy / context / reasoning
    ↓
sdk-text-kernel.bindSession()
    ↓
返回 readout → renderer 严格解析 → React setState
```

事件方向相反：

```text
Host → main HostClient.onTurnEvent
  → webContents.send("shell/sdkTurnEvent")
  → preload.onSdkTurnEvent
  → React 订阅
```

## 8. 修改时应该动哪里

### 纯视觉或布局

```text
packages/renderer/src/components/Desktop*.tsx
packages/renderer/src/components/ui/*
packages/renderer/src/styles/tokens.css
```

通常不需要改 `packages/shell`。

### 新增一个界面字段

1. 先确认 Host 是否已经返回该字段。
2. 在 `data/*.ts` 中增加严格解析。
3. 在组件中渲染。
4. 增加 renderer 测试。

### 新增真实数据或操作

1. `packages/shell/src/host/host.ts` 增加 op 分支。
2. `packages/shell/src/host/host-guards.ts` 增加 payload 校验。
3. `packages/shell/src/host/task-host.ts` 实现领域逻辑。
4. `packages/shell/src/rpc/protocol.ts` 增加 `HostTaskOp`。
5. `packages/renderer/src/data/shellBridge.ts` 增加类型和 helper。
6. 补 renderer / Host 测试。

### 新增 IPC 通道

见上文“新增 IPC 通道至少改四处”。

## 9. 本地运行与调试

### 方式 A：生产式启动，无 renderer HMR

```bash
pnpm --filter @pidock/shell dev
```

它会先构建 renderer + shell，再启动 Electron。修改 renderer 后需要重新构建/启动。

### 方式 B：真实桌面 + renderer HMR

终端 1：

```bash
pnpm --filter @pidock/renderer dev
```

终端 2：

```bash
PIDOCK_RENDERER_URL=http://127.0.0.1:4335 pnpm --filter @pidock/shell dev
```

这样 Electron 加载 Vite 页面，但仍使用真实 preload 和 `window.pidock`，适合调真实桌面 UI。

### 方式 C：只看 Demo UI

```bash
pnpm --filter @pidock/renderer dev
# 浏览器打开 http://127.0.0.1:4335
```

看到的是 `DemoApp`，不是生产桌面。

### 根目录 `pnpm dev`

根目录 `pnpm dev` 通过 turbo 启动两个 package 的 dev 脚本；它适合快速启动，不是 renderer 热更新的推荐方式。UI 迭代优先使用上面的方式 B。

## 10. 测试与检查

```bash
pnpm typecheck
pnpm lint
pnpm build
```

全量测试：

```bash
pnpm --filter @pidock/renderer test
pnpm --filter @pidock/shell test
```

单文件：

```bash
cd packages/renderer
pnpm vitest run src/test/desktopConversation.test.tsx

cd packages/shell
pnpm vitest run src/host/session-switch.test.ts
```

renderer 测试是 jsdom，主要验证 DOM、交互和契约；shell 测试更多覆盖真实 Host 逻辑、RPC、文件系统边界和进程生命周期。

## 11. 建议的阅读顺序

1. `README.md`
2. `GLOSSARY.md`：Workspace / Task / Session / Provider 的领域含义
3. `packages/shell/src/main/main.ts`
4. `packages/shell/src/main/runtime.ts`：`createHost`、`createTrustedWindow`、`registerIpc`
5. `packages/shell/src/preload/preload.cjs`
6. `packages/renderer/src/App.tsx`
7. `packages/renderer/src/components/DesktopInventory.tsx`
8. `packages/renderer/src/components/DesktopShell.tsx`
9. `packages/renderer/src/components/DesktopConversation.tsx`
10. `packages/renderer/src/data/shellBridge.ts`
11. `packages/shell/src/host/host.ts`
12. `packages/shell/src/host/task-host.ts`
13. `packages/shell/src/rpc/protocol.ts`
14. [技术栈与进程边界](../architecture/implementation-stack-design.md)

## 12. 常见误区

- **把 `Shell.tsx` 当成生产桌面入口**：生产桌面入口是 `DesktopInventory`，`Shell.tsx` 属于 DemoApp。
- **在 renderer 里直接使用 Node 或 Electron**：renderer 是 sandbox，所有本机能力都要经过 `window.pidock` → main → Host。
- **在浏览器里看到 Demo 就以为在调生产 UI**：只有 Electron 页面才有 `window.pidock`。
- **只改 UI 就以为数据链路已通**：真实数据需要 Host op、payload 校验、RPC 协议和 renderer 解析一起完成。
- **忽略严格解析**：`data/*` 解析失败是契约错误，不要用 `any` 或静默 fallback 掩盖。
