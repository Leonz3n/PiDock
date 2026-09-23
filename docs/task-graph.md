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

## 多服务联动与运行状态（[PiDock 05] #10）

日期：2026-09-22（Asia/Shanghai）。范围：纯规则 + Host 状态 + 任务视图；真实
`child_process` 启动仍为残留（与 #7 相同）。

- **运行单元**：`RunUnit`（`unitId` + `serviceId` + `repoDir` + `location`）
  是唯一标识；`validateRunUnitSelection` 拒绝空选择、重复 `unitId`、以及不在
  任务仓库集合内的单元。`unitsByRepo` / `repoGroups` 让一个仓库携带多个运行
  单元，任务视图按仓库分组显示去重后的单元（仓库可从环境页的启动配方维护）。
- **先端口后绑定**：`planPortAssignments`（严格，逐条报错）与
  `reallocatePortAssignments`（对其他任务/外部占用自动向上重分配，给出
  `reallocated` 列表）都先于变量绑定运行；`resolveTaskBindings` 只接受最终
  端口分配，`${port}`/`${host}` 模板生成**完整值**（完整 URL 整体覆盖，不做
  局部拼接）。分配可见机器级 `PortReservation`（本任务之外还包括其他任务与
  外部进程），因此两个任务的同名服务得到不同本地端口（renderer 内存夹具同样
  按既有任务分配，`release` 的 `saas-web` 为 5173、`checkout` 为 5174）。
- **读取点核对**：每个绑定回传 `readPoints`；`auditBindingReadPoints` 双向核对
  —— 绑定了却没有读取点记为 `unused-binding`，配置里存在
  `<SERVICE>_ENDPOINT/_URL/_BASE_URL/_HOST` 读取点却没有任务绑定记为
  `missing-binding`（消费者会继续用共享环境地址）。任务视图的「依赖去向」显示
  生效值、去向（本任务实例地址 / 共享环境）与读取点，不编造本机地址。
- **依赖类型与启动分组**：`ServiceDependency.kind` 区分 `call`（运行时调用，
  被调方先监听）与 `prestart`（启动前置条件，目标先就绪）；`planStartGroups`
  先输出 `prestart` 组（`prepare`/`one-shot` 单元，先完成），再按依赖拓扑输出
  监听组，**调用环（双向调用）折叠为一个 listener 组**：整组先监听再互验，永不
  互相等待（spec「双向依赖不会造成永远等待启动」）；同一组内出现 `prestart`
  边时报告 `start-order-conflict` 而不是死等。远程依赖不启动，改为所在组的
  「远程依赖可达性检查（共享环境，不标记为任务内隔离）」。
- **可定位失败与部分重启**：`diagnoseStartFailure` 把端口占用映射为
  `port-taken`（并给出重分配提示），其余保留原始错误为 `start-failed`；
  `diagnoseDependencyUnreachable` 点名消费者变量与目标实例。重分配后
  `reallocated` + 绑定重算覆盖**所有**指向该实例的消费者变量。
  `planRestartScope` 只列出真正受影响的**运行中**单元（端口重分配 / 绑定变化 /
  模板版本落后），其余实例保持运行——重启一个服务不会重启整个任务。
- **运行记录**：`buildRunRecord` 把模板版本、代码状态（已提交/未提交/未知）、
  构建新鲜度（`fresh` / `stale-build` / `uncommitted-code` / `unknown`）、端口、
  进程身份（pid + 启动时间 + 归属）与日志路径（
  `<taskDir>/services/<serviceId>/run-<runId>.log`）收在一条记录上；
  `attachVerification` 记录联通/就绪/远程可达检查结果，本地进程存活不等于功能
  验证成功。`recordRun` 拒绝非正整数 pid：没有真实进程身份就不写记录。
- **停止范围**：停止范围只来自 Host 登记的进程身份
  （`ProcessIdentity` / `verifyRegisteredIdentity` 精确匹配 instance + pid +
  启动时间），绝不按端口或过期 PID 猜测；`planStopScope` 只返回所属任务的身份，
  同名实例属于其他任务时进入 `skipped` 并写明原因。`task/serviceStopScope` 是
  只读计算，真实终止（`child_process` 进程树）属残留下一个切片。
- **共享外部资源**：`classifyExternalResource` 默认按共享处理，`queue` /
  `dtm-callback` 明确标为 `not-isolated`（消费端与回调端仍是同一实例），
  只有拿到独立实例证据（`isolatedByTask`）才标 `isolated`；任务视图显示资源
  清单与「已知配置限制」，不会把固定异步队列或 DTM 回调自动当作隔离成功。
- **IPC**：`task/planServiceGroup`（规划，不是执行：会翻转生命周期的仍只有
  经门禁的 `task/controlService`）、`task/serviceRunRecords`、
  `task/serviceStopScope`。规划请求走与 #7 相同的人工/Agent 判定
  （无 `sessionId` 必须带 main 盖的 `shell-ui` 来源证明；有会话则必须是已存在
  会话），计划里记录 actor 供审计。renderer 经 `shellBridge`
  （`planServiceGroupThroughShell` / `serviceRunRecordsThroughShell` /
  `serviceStopScopeThroughShell`）与适配器 `serviceTopology(taskId)` 取视图，
  Host 不可用时回落内存投影。
- **残留（未测/未接线）**：真实 `child_process` 启动、日志流、退出与健康检查
  未实现（因此 `recordRun` / 停止范围没有生产调用方，只有 Host 类与测试）；
  两个任务同时运行并检查真实请求去向未执行（端口与绑定隔离有单元测试）；
  「启动失败后重分配」只在规划阶段验证；真实仓库的依赖缺口探测未运行
  （`missing-binding` 与远程可达检查为规划期证据）；`task/planServiceGroup`
  的生产调用方目前是 renderer 的面板（`stores/host.ts` 仍把内存适配器固定为
  默认，与 #9 记录的同一接线缺口）；重新分配地址后的消费者更新已重算绑定值，
  但还没有运行中的进程需要迁移。
