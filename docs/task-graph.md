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
  （无 `sessionId` 必须带 main 盖的 `shell-ui` 来源证明；有会话则按 #7/#8
  的同一规则打开该会话，未知 id 会被创建并持久化，不要求事先存在），计划里
  记录 actor 供审计。renderer 经 `shellBridge`
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
  但还没有运行中的进程需要迁移。规划本身的已知限制：端口预留（`reservations`）
  只有调用方提供，还没有机器级预留的生产来源；renderer 镜像不发诊断，
  所以 `start-order-conflict` / `unknown-unit` 目前只能来自 Host；
  `prestart A→B` 叠加 `call B→A` 跨监听组时只按输入顺序发出计划、
  不报 `start-order-conflict`（同一双向组内会报）。

## 多会话协作与写操作协调（[PiDock 09] #11）

日期：2026-09-22（Asia/Shanghai）。范围：Host 写操作权状态机 + 真实路径跨任务
协调 + 任务视图导航；真实 Electron GUI smoke 与真实并发仍为残留。

- **两个层级，一份判定**：任务内由 `host/write-coordination.ts` 保证「同一任务同一
  时刻只有一个会话持有写操作权」（界面显示持有者、排队位置、只读与中止入口），
  任务间由 `host/path-coordination.ts` 按**解析后的真实路径**协调共享普通目录。
  规则都是纯函数/纯状态机：Host 派发、renderer 展示与测试共用同一份实现，
  renderer 不重新判定权限。
- **读不被写阻塞**：写操作权按**声明**计数（回合工具、服务控制、浏览器动作、
  派生执行各自声明），纯分析回合不声明，因此另一个会话可以安全阅读与分析
  （盒子 3）；`read` 档会话既不能发起回合，也没有任意执行工具。
- **写操作权比回合活得久**：停在确认的回合保留声明（`approvalClaims`），批准/拒绝
  才结算；派生执行（子进程／子 Agent）单独声明，回合结束也不释放（盒子 4）。
- **取消与恢复**：`task/cancel` 丢弃该会话的全部声明、派生条目与排队占位，
  并释放它持有的真实路径键；遗留的 agent 启动资源（仍运行、无声明、属其他会话）
  会让新会话的写入先被拒，要求核验后再写（盒子 5）。
- **跨任务并行**：不同任务（同项目或跨项目）写互不重叠的资源并行执行，没有项目级
  或全局单会话锁（盒子 6）。两个任务目录本身的 worktree 路径天然不同，各自私有；
  只有「普通目录来源」是**链接到原目录的共享视图**（#6），写穿链接就是改原文件。
- **共享真实路径协调**：`classifyRealPath` 用「任务目录 + 该任务普通目录链接的真实
  根」判定目标的真实归属；链接改指（`sourcePath` 与真实路径不一致）与嵌套链接
  （目标落在另一个共享目录内）都在真实路径上判定，词法上在任务内但解析到别处的
  目标被拒为 `path-out-of-scope`。`SharedPathCoordinator` 一个真实路径键一个持有者，
  重叠写入返回 `shared-path-locked: ... 由任务 X 的会话 Y 持有`（renderer 把该文本
  作为提示弹出并保留草稿），同一共享根下互不重叠的路径仍可并行；`host.ts` 为整个
  Host 进程接一份协调表，因此任务级锁不会被当作共享文件的隔离手段。
- **统一工具层校验（[PiDock 02] #5 门禁之上）**：文件写入、服务控制、浏览器动作与
  派生执行走同一个写操作权。`default` 档对命令与浏览器动作先询问（服务与浏览器
  使用用途绑定的 `SERVICE_CONTROL_SCOPE` / `BROWSER_CONTROL_SCOPE` 确认，一次性
  消费），`auto` 档不逐次询问但仍受任务写操作权、任务范围与共享模板确认约束，
  `read` 档全类拒绝（`permission-integration.test.ts` 逐类验收，作为 #13/#14
  后续任务的前提）。
- **会话导航**：标签保持创建顺序、最多四个，隐藏的当前会话替换最后一个可见位置，
  窄屏只显示当前会话，标签文本有界（完整名走 `title`）；右键菜单提供设为当前／
  重命名／归档／恢复／中止／在全部会话中查看。全部会话列表支持名称搜索、活动／
  归档分组、最近活动、状态与未读数，并在每行显示协调角色；**最后一个会话归档后
  仍可带归档标记查看，不自动新建空会话**。
- **IPC**：`task/sessionStates`（协调视图：持有者、排队、只读、派生、遗留资源）
  与更丰富的 `task/cancel` 载荷；renderer 经 `hostAdapter.sessionWriteStates(taskId)`
  取视图（shell 走 `task/sessionStates`，内存适配器同规则计算），run-state／
  approval 事件与写入被拒后都会刷新，不轮询。
- **残留（未测/未接线）**：真实 Electron GUI smoke、真实并发（两个任务同时写共享
  目录的端到端）与真实 `child_process` 派生执行未运行（规则与 Host 状态有单测）；
  共享路径协调的 fs 探针在测试中注入（`realpath` 生产实现已接线但未在真实多任务
  进程里跑过）；跨任务争用的界面呈现目前是拒绝提示，没有专门的争用面板
  （同任务持有者/排队有协调栏）；`stores/host.ts` 仍把内存适配器固定为默认，
  因此 Host 的 `task/sessionStates` 与真实路径协调在 UI 里走的是内存投影；
  派生执行与真实路径键的联动留到真实 `child_process` 派生执行接线时一并完成
  （`claimPathScope` 尚未传入 `derivedExecutionIds`，`claimDerivedExecution`
  尚未校验写操作权）；隐藏项目的 Agent／服务仍在后台运行且归属正确（GAP 7）
  不在 #12 的用量验收项内，需要真实后台运行接线时单独验收（见下节残留）。

## Token 用量明细与汇总（[PiDock 12] #12）

日期：2026-09-22（Asia/Shanghai）。范围：调用记录 → 持久用量明细 + 统计与
清理范围；真实模型联通与真实计费口径仍为残留。

- **一条稳定调用记录 = 一条持久明细**：`main/usage-ledger.ts` 把调用记录
  （`callId`、Provider、请求模型、实际响应模型、时间、类型、结束状态、用量
  与完整性）整理为可持久化的 `PiUsageDetail`；Host 在 `<taskDir>/usage.json`
  保存自己的明细（不是每次读会话就现算的投影），因此重开会话、归档对话、
  重启进程都既不新增也不丢失消耗。
- **未知不是零**：字段存在性决定完整性（`reported` / `partial` / `missing`）；
  `usageSource: "unreported"`（SDK 零初始化）一律记为 `missing`，聚合时只计数
  不累加；Provider 报告的 `totalTokens` 与 reasoning 只作展开与交叉核对：
  reasoning 已含在 output 内，绝不重复相加（盒子 2、盒子 5、盒子 9）。
- **重放与重试**：`recordCallUsage(callId, …)` 让流式增量、最终消息、事件重放
  落在同一条记录上（按调用 id 覆盖，幂等）；重试是新的 `callId`，各自计入；
  失败、取消、待确认分别标注，重开只恢复已有记录（盒子 4、盒子 5）。
- **类型与占用**：`runTurn({ kind })` 与 `compactContext()` 记录
  `turn` / `compaction`，压缩的用量单独计入且占用下降不冲减累计消耗（盒子 6）。
- **归属冻结**：明细保留调用时的 Provider 配置指纹（`协议::地址::模型列表`，
  不含显示名）与请求/实际响应模型，Provider 改名或切换不重写历史统计
  （盒子 1、盒子 8）。
- **时间与分组**：日期型边界按声明的 UTC+08:00「当日开始／当日结束」且含边界，
  带偏移的时刻按自身偏移比较，跨机器口径一致；分组维度为项目／任务／会话／
  Provider／模型／类型／日期（盒子 3）。
- **统计可查**：`USAGE_DEFINITIONS`（Host 与 renderer 镜像同一份措辞）在页面
  「统计定义」面板列出统计范围、未知用量、缓存、类型、重放、恢复、清理与日期
  边界；
  页面同时声明「仅本应用记录，不等同账户账单或配额」（盒子 3、盒子 9）。
- **清理范围**：`task/clearUsage` 支持 `all` / `session` / `before` 三种范围，
  Host 记录这次清理实际移除的调用 id，之后的再同步不会把已清理的明细恢复，
  也不会把清理之后的新调用当成已清理（只记范围、没有 id 列表的旧形态仍按范围
  处理；本功能尚未发布，不存在此形态的持久文件）；归档对话不清理用量（盒子 8）。
  renderer 的「清理范围」面板逐个说明范围并回报条数。
- **IPC 与适配器**：`task/usageRecords`（过滤 + 分组 + 总计 + 窗口标签 + 定义）
  与 `task/clearUsage` 走同一条 `shell/taskOp` 白名单；renderer 经
  `usageRecordsThroughShell` / `clearUsageThroughShell` 读取，Host 不可答时
  回落内存行，项目维度由 renderer 在映射时补齐（Host 信封不含项目）。
- **残留（未测/未接线）**：真实 Provider 连通与真实 usage 字段来源未验证
  （`docs/pi-provider-usage.md` 的字段已建模，但没有真实响应样本）；真实模型
  调用尚未接线，因此 `responseModel` 只能由调用方上报（通道与明细已支持并有
  单测，生产路径要等真实传输层），RPC 不暴露该字段以免伪造归属；分支摘要
  （`branch-summary`）与会话克隆／重新导入的来源身份（`origin` 去重规则已实现
  并有单测）缺少生产入口——会话分支/克隆功能本身不在 #12 范围内；隐藏项目的
  Agent／服务仍在后台运行且归属正确（#11 移交的 GAP 7）不在 #12 正文的验收项内，
  仍需在真实后台运行接线时验收；`stores/host.ts` 仍把内存适配器固定为默认，
  因此页面目前读的是内存投影（与 #9/#10 记录的同一接线缺口）；Electron GUI
  smoke 未运行；账本按调用 id 键控，而 id 计数器只按「当前恢复的那一个快照」
  推进（`PiSessionChannel.restore`），所以同一任务里多个会话各自持有 `call-N`
  时，若先使用 id 较小的会话仍可能铸出别的会话已用的 id（打包界面会先列会话
  并把计数器推到全局最大值，因此不触发）；彻底修法是 Host 构造时遍历该任务
  全部会话推进计数器，或把身份改成 `taskId/sessionId/callId`。
