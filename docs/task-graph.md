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

### 任务浏览器：任务内页面、门禁与标记回传（[PiDock 06] #8）

- **页面归属**：main 为每个任务创建一个 `TaskBrowser`（`WebContentsView` +
  `session.fromPartition('persist:…')`，分区由 `taskPartitionName(taskId,
  workspaceId)` 派生）。同任务的标签页与登录弹窗共用该分区，不同任务互不共享；
  关闭页面只销毁视图/调试连接，不清理分区，`page/close` 记下地址后
  `page/restore` 在同一分区重开，因此重开任务与重启应用都保留自己的登录状态。
  页面句柄绑定任务：`classifyPageRef` 拒绝外来任务句柄、已关闭页面与
  `webContentsId` 已变化的过期句柄；main 内部句柄（无 `taskId`）归属其所在
  任务的 surface，绝不按调用方声称归属。
- **导航目标**：`deriveNavigationAllowlist` 只接受任务自身运行配置里的本机端口与
  已配置地址，`navigationTargetAllowed` 拒绝 `file:`/`data:`/`javascript:`/
  `about:` 及配置外主机（含 `https://example.org`），因此「实际网络目标与任务
  运行配置一致」，试点前端里陈旧的绝对地址不会把请求引到旧实例；隔离方案不清理
  站点数据，登录状态保留。任务页始终保持 `sandbox/contextIsolation` 且不加载壳
  preload（`TASK_WEB_PREFERENCES`），外部网页拿不到桌面本机能力。
  当前地址来源是 main 的 `PIDOCK_TASK_BROWSER_ORIGINS`（JSON `taskId ->
  origins`，缺失即拒绝导航）；把它改挂到持久化的任务运行配置属 #7/#9 后续。
- **权限门禁复用**：所有浏览器工具（`browser.state/open/navigate/reload/close/
  restore/click/fill/key/wait/screenshot/evidence/relocate`，兼容旧名
  `browser.act`）在会话通道里都是 `browser` 类工具：只读档拒绝全部浏览器操作，
  默认档先询问，自动档放行但仍校验页面归属与导航目标。默认档的确认请求由 Host
  以 `BROWSER_CONTROL_SCOPE` 铸下，绑定「动作 tool + 任务内页面 target
  (`<taskDir>/browser/<pageId|new>`)」；`verifyBrowserControlApproval` 只接受该
  scope，且轮内同 tool+target 的确认不带 scope，不能拿来执行浏览器操作。
  确认一次性：Host 在动作前 `consumeApproval` 并写回快照，重放、待批准与
  已消费都失败关闭。`marker/create`、`takeover/pause|resume` 属用户专属动作，
  Agent 路径直接拒绝。
- **人工接管**：`takeover/pause` 后 main 拒绝一切 Agent 浏览器动作
  （`takeover-paused`），用户自己的动作照常；`takeover/resume` 重新读取页面状态
  （epoch/viewport）并列出需要重新定位的旧标记，页面变化后不复用旧坐标。
  人工标记走与 #7 相同的人工路径判定（无 `sessionId` 必须带 main 盖的
  `shell-ui` 来源证明），标记以用户消息进入当前会话（结构化 `references`），
  Agent 从同一页面的证据继续。
- **证据与凭据**：`evidence` 只回传有界的 console/异常与失败请求（各 20 条、
  文本 240 字符），文本经 `scrubBrowserText` 处理：`Authorization`/`Cookie` 头、
  `token=/password=` 形式与 URL 里的 `user:pass@` 一律遮蔽，任务私有值在 main
  通过 `secretsFor` 供应时同样遮蔽（生产接线尚未接入，见残留）；
  按需截图超出 768KiB base64 上限时拒绝（`screenshot-too-large`），
  避免一次回包超出 RPC 信封上限。
- **IPC 边界**：renderer 只说 `task/browserAction`（经 preload `shell/taskOp`，
  main 按可信 sender 盖来源）；Host 已经过门禁的动作再以 `browser-request`
  经同一 parent port 请求 main 执行并等待 `browser-response`（`HostBrowserClient`
  ↔ `HostClient.onBrowserRequest`，无处理器即失败关闭）。renderer 不接触
  Chromium/CDP，也不持有页面句柄以外的能力。
- **残留（未测/未接线）**：真实 Electron GUI smoke（点击/填充/键盘表、
  弹窗登录返回、跨任务分区、重启保留）没有在本机沙箱外运行；真实网络浏览未执行
  （仅受控 fixture 与单元测试）；Host 侧浏览器动作到 main 的真实 round trip
  未在 Electron 内跑过；renderer 仍无服务注册入口，`createTrustedWindow` 里
  为 #4 验证预建的那个 `TaskBrowser` 与 per-task registry 尚未合并（面板的
  页面句柄仍来自 renderer 本地种子，需接 `page/list` 一类来源）；
  `targetSessionId` 目前默认任务首个会话（多会话由 #9/#11 补齐）；
  main 未把任务私有值接给 `secretsFor`；`marker/create` 的 URL 只做格式校验、
  未与活动页面比对；默认档在 main 校验页面归属/白名单之前就已铸确认（被拒的
  导航会消耗一次确认）；浏览器动作尚未与任务写锁串行（#9 范围）。
