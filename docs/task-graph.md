# pnpm workspace / Turborepo 任务图（[PiDock 02] S2 补充）

日期：2026-09-22（Asia/Shanghai）
状态：已按 #5 工具链补充验收实现并实测；Electron GUI smoke、真实 worktree E2E、真实模型联通仍未测（见 #5 残留）。

## 包与任务

| 包 | 路径 | `dev`（persistent，不缓存） | `build`（`dependsOn: ["^build"]`） |
| --- | --- | --- | --- |
| `@pidock/shell` | `packages/shell` | `electron .`（main + utilityProcess Host + 壳内视图） | `copy-static.mjs` + `tsc -p tsconfig.build.json`（`dist/main` + `dist/host` + `dist/rpc` + `dist/preload` + `dist/renderer` 静态页） |
| `@pidock/renderer` | `packages/renderer` | `vite --host 127.0.0.1 --port 4335 --strictPort` | `vite build`（`dist/`） |

根 `pnpm dev/build/typecheck/test/lint` 经 `turbo run` 调度两个包的同名任务；
`turbo.json` 的 `build`/`test` 声明 `dependsOn: ["^build"]`（`test`
在 workspace 构建产物之后运行），`typecheck` 声明 `dependsOn: ["^typecheck"]`，共享协议与
构建先后关系正确：`shell` 的静态页拷贝不依赖 renderer 构建产物（壳内
`dist/renderer/*.html` 为 shell 自带占位页），renderer 构建产物由 Vite 独立产出。

## 本地启动

```bash
export PATH="/private/tmp/pidock-pnpm/node_modules/.bin:$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
pnpm dev                        # turbo 并行启动 shell + renderer dev
pnpm --filter @pidock/renderer dev   # 仅渲染层（127.0.0.1:4335）
pnpm --filter @pidock/shell dev      # 仅桌面壳（需沙箱外 escalated 运行）
```

- `PIDOCK_RENDERER_URL` / `PIDOCK_TASK_URL` 指向 dev server 时，壳内视图走
  `loadURL`（开发联调）；未设置时走 `dist/renderer/*.html` 的 `loadFile`
 （打包/离线路径，见 `runtime.ts loadTrustedViews`）。
- main + utilityProcess Host + renderer 由同一 `pnpm dev` 任务图启动；
  退出/重启只清理本次所属进程：`main.ts window-all-closed` 调用
  `client.dispose()` + `child.kill()` + `tasks.disposeAll()`，单注册表
  （`PerTaskHostRegistry`）是唯一的 per-task fork 点——同一任务复用同一
  Host 条目，重启后下一 op 恰 fork 一个替代（`task-hosts.test.ts`
  「never forks two Hosts」锁定该行为），不遗留重复 Host。

## 边界：renderer 不获得 Node 能力

- renderer 经 pnpm workspace 与 shell 共处一图，但**不共享任何包代码**：
  shell 的 `task-provision.ts` / `task-host.ts` / `task-store.ts` /
  `host-guards.ts` 从未被 renderer 导入；renderer 的任务表单规则是
  `data/directories.ts` 中的独立纯函数镜像（见
  `task-provision-parity.test.ts`）。
- `no-node-in-renderer.test.ts` 扫描 renderer 源码：`node:` / `electron`
  导入、`process.env`、shell 模块导入一律失败。preload 仍为最小桥
  （`window.pidock.taskOp` + `{ok:false,error}` 信封），任务路由 id 由 main
  按可信 sender 绑定，renderer 只能点名自己的任务。

### 来源证明与一次性确认（[PiDock 04] #7）

- main 在转发 `host/task` 时按可信 sender 给信封盖上 `origin:
  {kind:"shell-ui", senderWebContentsId}`（`protocol.ts` 的
  `TaskOpOrigin`）。Host 仅在“无 `sessionId` + 该来源证明”同时成立时，
  才把服务启停当作人工界面操作；无来源证明的无会话调用直接拒绝，
  因此 renderer 不能靠省略 `sessionId`（或伪造 `actor`）绕过会话权限门禁。
  界定的范围是**发送方/窗口**而非单次动作：该章盖在壳视图 WebContents
  发出的每个 `host/task` 上，`senderWebContentsId` 只作审计记录；壳视图页
  内运行的任何脚本都能拿到无门禁的人工路径，非壳发送方则拿不到。只靠壳
  页可达的通道（`runtime.ts` 仅注册壳页可调的 `ipcMain.handle`）不构成
  多租户隔离，真正的隔离在“谁能以该 sender 发消息”。
- 服务启停的人工/Agent 归属由 `classifyServiceControlCaller`（纯函数，
  `host-guards.test.ts` 锁定）判定；Agent 分支的权限档位取自会话通道的
  实时 `currentPermission`，`default` 档必须携带已验证的 `approvalId`。
  该确认请求还带**用途绑定**：Host 只能以 `SERVICE_CONTROL_SCOPE` 铸下
  服务启停确认，`verifyServiceControlApproval` 也只接受这一 scope ——
  同一 tool + target 的轮内（turn）确认不带 scope，不能用它启停服务。
- `approvalId` 对应确认请求为一次性：Host 在首次成功启停时调用
  `PiSessionChannel.consumeApproval` 并写回会话快照，同一 id 不能再次
  授权（start/stop 共用同一个“服务目录”绑定目标）；`restore` 会把
  `approved` 但未消费的请求一并消费，重开应用必须重新确认。本切片不设
  确认有效期（TTL），语义见 `service-runtime.ts` 的 `verifyServiceControlApproval`。
- renderer 的 `shellHost.setServiceRunning` 先探 `task/serviceStatus`：Host 已
  注册的服务走 `task/controlService`（无 `sessionId`，人工路径）；未注册的服务
  （当前 renderer 还没有服务注册入口，服务只在 Host/Agent 侧注册）仍回落
  memory。真实的 `child_process` 启动、日志流与 renderer 注册入口一起落地时
  才能端到端，仍在 #7 残留内。
