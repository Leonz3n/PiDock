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

## 真实对账单详情同步验证（[PiDock 07] #13）

该工单的验收是**真实业务运行**：用户指定仓库、选定非生产环境与已有对账单、用户
本人登录后的 UI 操作，以及本地 BFF/invoice/shipment 同步链路证据。当前执行环境
没有该环境的登录态、凭据、可写数据与已启动的本地服务，因此本切片只实现不依赖
这些输入的部分，其余按下表记录为待用户提供的残留，**不伪造业务闭环**。

- **门禁形状（盒子 1）**：`packages/shell/src/host/permission-integration.test.ts`
  新增 `[PiDock 07] pilot operations keep the default-tier gate`，用真实形状的两类
  试点操作（本地 BFF 启动命令 `exec.run`、任务浏览器内可见菜单导航
  `page/navigate`）驱动 09 集成验收的同一套写操作权与一次性确认：默认权限先问、
  拒绝后不执行且不占用写操作权、只读会话直接拒绝（`previewGate` 为 `deny`）、
  一次确认只授权一次导航。该文件不引入测试环境或验收专用的跳过标记。
- **证据关联规则（盒子 5、盒子 6）**：`packages/shell/src/main/pilot-evidence.ts`
  把「网络目标 ↔ 本任务运行实例 ↔ 该实例的 RPC 日志」的判定做成纯规则：
  `assessPilotBundle` 逐条请求给出 `proven` / `unproven`，HTTP 成功但响应体带
  GraphQL `errors` 判为未证明，未抓到响应体、响应体不是 JSON、端口没有本任务实例、
  目标是远程主机、状态非 2xx 都判为未证明并给出原因；旧 REST 列表路径
  （`/reconciliation-invoice/list`）显式不能替代本地 RPC 链路；缺少
  `GetReconciliationInvoices` 请求时在汇总里报告。`docs/pilot-synchronous-query.md`
  的失败判据因此有可执行的判定入口，而不是只靠人工阅读。
- **残留（未测/未接线，需要用户或 supervisor 提供输入）**：
  1. 真实业务闭环整体未验证（盒子 2–9）：需要用户提供非生产环境与已有对账单、
     该环境登录账号的实际登录、可写的试点仓库工作副本、以及主壳／BFF／invoice／
     shipment 的本地启动配置和远程依赖可达性；`docs/pilot-repository-inspection.md`
     里的仓库在本机不位于文档记录的路径（`/Users/leonz3n/...`），启动配方与
     变量读取点仍需在真实环境核对。
  2. `pilot-evidence.ts` 目前只有单测与 `docs` 记录，尚无生产调用方：真实运行需要
     先让任务浏览器保存响应证据（CDP `Network.responseReceived` +
     `Network.getResponseBody` 的有界捕获，含 operation 与 GraphQL `errors`）和
     本地服务 RPC 日志，才能把捕获结果喂给这些规则；接线前的判定只对离线证据包
     有效。
  3. 双任务并行对照（盒子 7、盒子 8）与「远程前提阻塞时分别报告」（盒子 9）需要
     真实环境，本轮未运行；不能以单测或直接 GraphQL 调用代替。
  4. Electron GUI smoke 未运行；真实 SaaS 页面、动态菜单与详情弹层均未实际操作。

## 任务内协议生成与消费者绑定（[PiDock 08] #14）

日期：2026-09-22（Asia/Shanghai）。范围：协议仓库／生成步骤／消费者绑定的
纯规则 + Host 状态 + 任务视图面板；真实生成与真实仓库编译仍为残留。

- **三者分开（盒子 1）**：`main/protocol-binding.ts` 里协议仓库
  （`ProtocolRepoRef`：`repoDir` + Go/TS 生成目录）、生成步骤
  （`GenerationStep`，`generate` / `postprocess`）与消费者绑定
  （`ProtocolConsumer`）是不同概念。`validateProtocolPlan` 拒绝把协议仓库
  （或其生成目录）当作自己的消费者、拒绝重复的消费者标识与重复的消费者仓库
  （同一仓库只能绑定一次，避免合并依赖选择），TS 消费者必须给出仓库自己的链接
  步骤与目标应用。界面（任务视图「协议」面板）显示协议仓库、生成步骤、准备状态
  与实际生成版本。
- **准备状态各自独立**：`buildPrepareState` 把试点核对报告要求的六个状态分开
  ——代码就绪、工具链就绪、依赖已安装、生成物已更新、本地绑定有效、运行环境可达；
  「已生成」不蕴含「已绑定」或「可达」，运行环境可达性来自 #10 的拓扑判定而不是
  这里推断。
- **未改协议保留发布依赖（盒子 2）**：`planGeneration({mode:"release"})` 不产生
  任何步骤、`keepsReleaseDependencies: true`，并回传每个消费者的发布依赖
  （`releaseResolution`），界面显示为「发布依赖：github.com/shipber/apis v0.0.69」
  这类具体值。`mode:"local"` 则要求至少一个生成步骤**和**仓库自己的后处理步骤
  （试点核对：只跑 `buf generate` 不是仓库契约），且每个步骤的工作目录必须在本
  任务的协议仓库内，`validateGenerationStep` 沿用服务启动的同一规则（明确程序 +
  参数，拒绝内联环境赋值与 shell 连接符）。
- **Go：任务专属 workspace（盒子 3）**：`planGoWorkspace` 为每个 Go 消费者生成
  一份 `go.work`（`<taskDir>/protocol/go-work/<consumerId>/go.work`，`GOWORK`
  指向它），`use` 只有两条：该消费者模块 + 本任务生成的 Go 模块。
  `excludedConsumers` 明确列出**没有**并入的其他 Go 服务（不合并依赖版本选择），
  `releaseManifestsUntouched` 列出消费者的 `go.mod`/`go.sum`（不改写发布配置）。
- **TS：复用受管链接（盒子 4）**：`planTsBinding` 复用仓库自己的
  `proto:link-local`，`--app` 指定单个消费者（不一次链接全部）；链接路径与标记
  都在当前任务内，标记为
  `pidock-local-protocol:<taskId>:<consumerId>:<tsGenDir>`，因此别的任务或别的
  消费者的标记不会被误认。`checkTsBinding` 在重新安装后复核：标记缺失 →
  `marker-missing`（附恢复命令）、标记属于别处或链接解析到任务外 →
  `resolved-elsewhere`，都按失败处理并要求重建绑定。
- **编译前确认解析路径（盒子 5）**：`verifyResolvedPath` 按模式判定——发布模式下
  消费者仍解析进本任务产物要报 `resolved-elsewhere`（不能假装已切回发布依赖）；
  本地模式下必须落在本任务生成目录内，且调用方报告的产物版本与已生成版本不一致
  时报 `version-mismatch`。`assessLocalSwitch` 在把不同发布版本切到同一本地产物时
  停止并解释：产物版本变过而消费者没有重新核验 → `artifact-version-mismatch`；
  同一任务里不同发布依赖的消费者（跨语言版本号不可直接比较）必须逐个确认
  （`acknowledged`）才算通过。Host 只在解析真的通过且无阻塞时把一个消费者标记为
  「已绑定」，否则保持未绑定并带上诊断。
- **协议再变（盒子 6）**：`assessConsumerStaleness` 依次给出
  `needs-regenerate` → `needs-binding` → `needs-compile` → `needs-restart`，并带回
  该实例实际加载的版本；运行实例加载的不是当前产物时报告「不算已加载新协议，请
  重启后再验证」。#10 的 `RunRecord` 增加可选 `protocolArtifact.version`，
  Host 由 `serviceTopology.runs()` 映射到消费者（`serviceId` 对齐），因此
  「旧运行实例不算已加载新协议」有真实的判断入口。
- **切回发布依赖（盒子 7）**：`mode:"release"` 后每个消费者的绑定回到
  `{kind:"release", dependency}`，状态为就绪；计划里的所有 workspace / 链接路径
  都必须在本任务目录内（Host 构造与 `setPlan` 双重校验），另一个任务由自己的
  `TaskProtocolBinding` 持有状态，互不影响。
- **生成工具链（盒子 8）**：`checkGenerationToolchain` 按平台给出逐工具结果：
  `win32-arm64` 报 `unsupported-platform`（试点仓库的插件安装脚本明确不支持），
  未探测的平台报 `unverified`（不是「就绪」），调用方探测过的才报 `missing` /
  `ready`，并且无论平台都带 `desktopLaunchImpliesGeneration: false`——桌面可启动
  不能推断生成支持。
- **IPC**：`task/planProtocol`（替换计划）、`task/protocolState`（读）、
  `task/recordProtocolRun`（记录真实观测：生成版本、工具链探测、依赖安装、
  各消费者解析路径、运行环境可达性）。两个写操作走与 #7/#10 相同的人工／Agent
  判定（无 `sessionId` 必须带 main 盖的 `shell-ui` 来源证明；有会话则打开该会话），
  计划与结果都记录 actor。renderer 经 `shellBridge`
  （`planProtocolThroughShell` / `protocolStateThroughShell` /
  `recordProtocolRunThroughShell`）与适配器 `protocolBinding(taskId)` 取视图，
  Host 不可用时回落内存投影（内存投影标记 `simulated`，从不声称已有生成版本）。
- **盒子状态**：盒子 1／2／3／4／5／8 已覆盖（纯规则 + Host + 面板 + 单测，
  2 的真实执行除外）；盒子 6、7 的规则与 Host 状态已覆盖并有单测，但真实
  `child_process` 生成与真实仓库编译未运行（见残留），因此 #14 保持 OPEN。
- **残留（未测/未接线）**：真实 `make generate` / 后处理步骤未执行（没有进程
  启动器，本机也没有试点仓库，`steps` 只有规划形态与纯规则单测）；真实
  `GOWORK` 编译、真实 `pnpm proto:link-local` 运行与仓库脚本自己写的标记未验证
  （标记语义与复核规则有单测，仓库产物在其控制之外）；解析路径目前由调用方上报
  （`resolutions`），没有自动读取 `go list -m` / `node_modules` 真实解析的生产
  实现；「另一个任务的依赖不变」只有纯规则与两个 Host 实例的单测，没有真实双任务
  并行核查；`task/planProtocol` / `task/recordProtocolRun` 还没有 renderer 的生产
  调用方（面板是只读展示，`stores/host.ts` 仍把内存适配器固定为默认，与 #9/#10/#12
  记录的同一接线缺口）；Electron GUI smoke 未运行；真实生成应当同时声明任务写操作权
  并留下运行记录（当前只记录观测，与 `recordRun` 没有生产调用方一致）。

## 文件浏览、差异与内置终端（[PiDock 10] #15）

- **文件根与归属（盒子 2、9）**：`main/workspace-files.ts` 的 `workspaceRoots`
  按任务记录生成有界根列表：每个仓库一个 worktree 根（带 baseline 分支与钉住的
  commit），每个普通目录链接一个 `shared-dir` 根（带 `directoryId` 与链接时记录的
  `sourcePath`）。根之间从不合并，`workspaceAttribution` 每个视图都带任务 id、
  仓库（或链接目录）身份、统一 pi 工作目录（任务目录），普通目录额外带
  「修改影响原文件，不提供 Git 差异与交付」与链接位置／原始目标。`resolveWorkspacePath`
  只接受相对路径且拒绝 `..` 与绝对路径式的越界改写，未知根返回 `unknown-root`，
  因此一次文件请求永远出不了所选根。
- **有界预览与差异（盒子 2）**：`boundTreeEntries`（目录优先、按名排序、上限
  200 条、`truncated`）与 `boundPreview`（上限 20k 字符、标记截断）／`boundDiff`
  （400 行 + 40k 字符上限）都先经 `scrubSecretText` 掩码：任务／私有值列表与
  `password/token/api_key/Bearer/Cookie` 等模式一律遮蔽。`boundDiff` 对普通目录
  链接直接拒绝（`plain-dir-no-diff`），不会用「空差异」冒充「无修改」。
  `deliveryTarget` 只给出仓库、分支与 `autoCommit/autoPush/autoMerge: false`，
  普通目录链接返回 `plain-dir-no-delivery`；交付始终由用户在明确入口触发。
- **Host 文件读取**：`host/workspace-files.ts` 把上述规则接到可注入的读取器
  （目录列举、文本读取、`git diff --no-color [<base>] -- <path>`）；git 用固定
  argv、在根目录 cwd 下执行、不经 shell，输出再经规则层边界与掩码。读取器可注入，
  因此单测不碰真实仓库；二进制文件与超过 1MB 的文件拒绝读取并报错。
- **终端计划与环境（盒子 3、9）**：`main/terminal-config.ts` 的 `planTerminal`
  以所选根（worktree 或普通目录链接）为 cwd，按 #7 的层序
  （仓库默认配置 → 共享模板 → 本机私有配置 → 任务覆盖 → 运行时绑定）解析环境，
  返回**每次新建**的子进程 env 对象与掩码后的展示行；从不读写 `process.env`。
  程序与参数必须显式（复用 #7 的 `validateServiceDescriptor` 规则拒绝内联
  `FOO=bar` 与 shell 连接符），窗口大小有上下界。`TaskTerminalRegistry` 记录归属
  （任务／会话／标签）、cwd、env 键名、生命周期与退出状态，历史有界（200 行、
  单行 2000 字符）并同样掩码。
- **写操作协调与权限（盒子 4、5、8）**：终端启停是副作用操作，走 #11 的任务写
  操作权（`WriteIntentKind` 新增 `terminal-control`）：Agent 与控制序列
  `runAgentTerminalControl`（`host/terminal-control.ts`）先读会话 tier，再决定、
  只在 `default` 且服务已登记时铸一次带 `TERMINAL_CONTROL_SCOPE` 的一次性确认
  （target 绑定 `${taskDir}/terminals/<instanceId>`），消费后才执行；
  `read` 会话在计划阶段就被拒绝（没有终端／命令入口），`auto` 仍不绕过任务归属
  与写操作权。人工操作必须带 main 盖的 `shell-ui` 来源证明（`classifyControlCaller`），
  同样先取写操作权，并在结果里标 `actor:"human"`。停止按**实例 + 进程号 +
  启动时间**证明范围（`stopScope`），未报告进程号时失败关闭（`unknown-process`），
  另一个任务的实例直接 `task-mismatch`，因此停止不会误杀别的任务。
- **IPC 与面板（盒子 1）**：`task/fileRoots`、`task/fileTree`、`task/filePreview`、
  `task/fileDiff`、`task/deliveryInfo`（读）、`task/planTerminal`、`task/terminalControl`、
  `task/terminalState`、`task/terminalHistory`。renderer 经 `shellBridge`
  （`fileRootsThroughShell` 等）与适配器 `workspaceBrowser(taskId)` /
  `planTerminal` / `controlTerminal` / `terminalState` 取视图；Host 不可用时回落
  内存投影。工具区默认关闭，按需加载（面板打开才发起 Host 读取或终端计划），
  逐标签关闭、最后一个关闭后释放对话空间，关闭面板不停止服务、不结束终端进程、
  不删除浏览器持久状态（这些生命周期各自独立）。
- **盒子状态**：盒子 1／2／3（规则与 Host 计划部分）／5／8 已覆盖；盒子 3 的真实
  PTY 进程、盒子 4 的「真实命令执行不接受 UI 只读标记」端到端、盒子 6 的外部
  编辑器入口、盒子 7 的真实 Git 交付执行属残留，因此 #15 保持 OPEN。
- **残留（未测／未实现）**：真实 PTY 进程未启动（`task/terminalState` 明确返回
  `spawnImplemented: false`，面板显示「本机 PTY 进程启动属未实现范围」，实例只在
  有真实 spawner 报告进程号后才能停止）；`git diff` 真实运行（固定 argv、无 shell）
  只由注入读取器的单测覆盖，未在有真实仓库的环境执行；文件树／预览未在打包应用里
  做过 GUI 走查（Electron smoke 未运行）；外部编辑器打开入口与断点调试方式未实现
  （盒子 6 未覆盖）；「人工终端接管」目前只到写操作权与归属标识，真实接管流程
  （暂停 Agent、用户输入、恢复）依赖真实 PTY；终端输入仍是模拟（`runTerminalCommand`
  内存队列），未接真实 shell；`task/planTerminal` / `task/terminalControl` 的生产
  调用方只在 renderer 面板（`stores/host.ts` 仍把内存适配器固定为默认，与 #9/#10/#12/#14
  记录的同一接线缺口）；多任务并行的真实进程归属只由注册表单测覆盖。
