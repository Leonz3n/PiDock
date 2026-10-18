# 经主进程确认的任务服务配方可在受控门禁下执行

Status: proposed (2026-10-16; #7)

## 复核更正（2026-10-16，实现前重查代码）

本草案写完后，实现前重查发现**它的核心假设不成立**，以本节为准：

- **人走的链已经是 main 权威，且端到端已存在**：dock 启动 → `serviceCatalogOp{op:"runTaskService"}` → `runtime.ts` `runTaskService` → `catalog.launchFor(...)` → 以 `{kind:"service-catalog"}` 先 `task/registerService` 再 `task/controlService`；界面绑定已带真实原生选择器（`runtime.ts` `pickProgram`：`dialog.showOpenDialog({title:"选择本机服务程序"})`，realpath + `isFile` + `X_OK`），写入走 `performServiceBindingOperation` → `commitTaskBinding`，投影是 main 自己写后读回。渲染层在生产里**从不**登记服务（`registerServiceThroughShell` 无生产调用者），`task/registerService` 只由 main 发出。
- **因此下文「必须改」表中的这些条目应当保留、不得因甲而放宽**：`host-guards.ts` 的来源守卫、`host.ts` 的 `catalogControlPrecondition` 与拒绝分支、`service-runtime.ts` / `service-public.ts` 的来源说明、`docs/task-graph.md` 的措辞、guard smoke 的 `denied` 断言。它们守的是「页面原始描述符不得执行」，是纵深防御，不是挡用户的产品障碍；改动它们只会为**零产品收益**削弱安全边界。该表作为历史记录保留。
- **`DesktopToolDock.tsx` 的 `uiRegistered` 禁用条目作废**：该状态在生产里不会出现，已回退（Host 那句更准确的拒绝文案保留）。
- **真正的缺口是 Agent 的登记生命周期**：Agent 的 `service.start/stop` 读 Host 注册表并要求 `launchSource === "catalog"`，而 main 只在人类触发的那一次「先登记再控制」里瞬时登记，所以人没点过启动时 Agent 得到 `tool-refused:unknown-service`。
- **采用的修法（业主 2026-10-16 选定）**：main 在**任务开启（首次非 provision 路由）时**把该任务已确认的绑定以 `{kind:"service-catalog"}` 来源登记进该 Host；登记材料仍只来自 `taskBindings` + `launchFor`（与人类启动同一份），不带 code observation；某个绑定解析失败时其余照常登记且失败具名；绑定集合的指纹变化（后于 Host 创建才绑定、模板版本变更、Host 重建）都会触发重新登记。Agent 继续走既有 tier/审批门。**页面来源仍然不可执行。**

以下原文保留，作为设计推演过程；其「必须改」分类以上述更正为准。

## 背景与现状

按 #7 已选择的「甲」路线，用户从现有仓库配置导入草案、选择环境、编辑变量后，必须能够启动任务服务；Agent 也必须能用同一份配置启动同一服务。这里的“界面配方可执行”不能等价为“渲染进程提交的任意 `program`/`args`/`cwd`/环境可执行”：当前服务驱动会真实 `spawn`，而页面脚本可经受信壳视图发起 RPC。需要把用户确认的配置和页面提供的未确认描述符区分开。

当前代码可核实的事实：

- 真实执行已经接线：`TaskServiceProcesses` 以独立 `program`、argv、cwd、子进程 env 调用 `spawn`，不是模拟生命周期（`packages/shell/src/host/service-processes.ts:126-144`）。
- `task/serviceImportHints` 是扫描/展示入口。导入 hint 明确“是表单候选，不是 executable launch”（`packages/shell/src/host/service-import.ts:24-46`）；它只读取有限的配置源，安全检查后返回候选（`:55-63`、`:132-153`），Host 的对应分支只返回 `scan`（`packages/shell/src/host/host.ts:1903-1916`）。这一步没有保存模板、创建任务绑定、确认本机程序路径或启动进程。
- 现有可信路径已经有可复用的主进程权威链：任务绑定保存环境/模板版本、工作区根/子目录、本机 `programPath` 与私有变量引用（`packages/shell/src/main/service-catalog.ts:69-86`）；主进程按任务绑定校验任务根、cwd 路径、可执行文件并解析模板和私有引用，再产生 `ServiceLaunch`（`:608-619,630-656`）。执行入口只接受项目/任务/服务/动作等名称，主进程自己解析并向 Host 用 `service-catalog` 来源登记（`packages/shell/src/main/runtime.ts:1192-1239`）。
- 但 Host 当前只让 `launchSource === "catalog"` 通过控制前置条件（`packages/shell/src/host/host.ts:779-787`）；普通 `shell-ui` 登记被当作展示/计划数据，并在单服务、Agent 工具和界面中分别拒绝或禁用。Agent 工具只接收 service id，当前也要求登记记录来自 catalog（`packages/shell/src/host/sdk-agent-tool-broker.ts:1192-1214`）。

本文提出的是待确认的执行边界，不表示已接受任何尚未决的本机代码执行风险，也不表示产品代码已经按此修改。

## 边界

### 可获得可执行 launch 的登记

建议以“**主进程确认的任务绑定执行材料**”作为执行资格，而不是以“来源字段是 `ui` 或 `catalog`”单独作为资格。满足资格的配方至少应具备：

1. 用户能审阅并确认导入候选（含被删除/遮蔽/待核验字段）；选定项目环境并保存共享模板后，任务绑定须明确 pin 到该环境与模板版本。导入扫描产生的 `program`/argv/workdir 只是候选，不能因扫描成功就自动成为可执行配置。
2. 可执行程序路径由用户在受控的本机选择/确认步骤确定，保存在该任务的本机绑定；主进程在每次解析时校验任务身份、路径身份、普通可执行文件和可执行权限。不要把草案中的可移植程序名直接当成可信的绝对路径。现有 `verifiedLaunchPaths` 校验路径为可执行普通文件，但本文建议进一步要求它落在任务工作区内或业主明确批准的可执行根目录内；现有代码没有证明程序路径一定在任务根内（`service-catalog.ts:608-619`），不可把这一点写成既有保证。
3. argv 来自用户确认并持久化的、经过 descriptor 校验的 pinned 配方；执行请求只命名 `serviceId`/动作，不得携带程序、argv、cwd、env 或 approval 代替配置。不得经 shell 拼接。工作目录由主进程按经过验证的任务根 + binding `rootId`/`subdir` 得出；Host 仍须在 spawn 前拒绝任务目录之外的 cwd（现有 `service-processes.ts:130-144`）。
4. 子进程环境由 Host 从已解析的配置层新建；不继承 Host 的任意 `process.env`（`service-config.ts:404-412`）。导入原文件的变量值不进入草案响应，凭据/本机路径不进入共享模板，服务输出在有界日志前做 secret 值遮蔽（`service-import.ts:11-21`、`service-runtime.ts:428-445`）。**现有代码会把显式私有引用解析后传入子进程环境**（`service-catalog.ts:644-655`），因此“私有值绝不进入任何可执行环境”若是业主的字面要求，与现有 private-ref 服务功能冲突；在该问题拍板前，不能宣称已经满足，也不能静默把例外扩大到环境/argv/日志以外的通道。
5. 已保存/已确认的资格须由主进程根据自己的项目、任务、模板、绑定和用户确认状态建立；渲染器或 Agent 请求不能用自报的 `launchSource`、`actor`、`approvalGranted` 或原始描述符铸造执行资格。对现有可信服务 id 的普通 UI 重登记仍须拒绝覆盖已确认的可执行描述符（现有 `service-registration-conflict` 的**防覆盖语义**必须保留）。

这使 #7 的界面流程可以把经过确认的配方交给同一条主进程解析路径；所谓“界面登记可执行”指该界面创建/确认的配置经过这条权威登记后可执行，不代表任意页面 RPC 描述符成为可执行材料。

### 触发权：人类与 Agent

- **人类**：现有人工控制由 main 对无会话调用的 `shell-ui` 发送方做 sender-bound attestation，再标记为 human（`host-guards.ts:134-172`）；单次人工 `runTaskService` 由 main 解析 launch、登记后控制（`runtime.ts:1206-1241`）。目前 `runHumanServiceControl` 是显式 UI 操作，不走 Agent 的 session tier/approval 门（`service-control.ts:125-137`）。配方的确认/保存不应伪装成一次普通启动；需由业主决定是否还要对每次人类启动另做确认。
- **Agent**：Agent 不得提交或覆盖执行材料；它只调用已经准备好的服务 id，并通过现有 Host 服务控制 gate。`read` tier 拒绝命令，`default` tier 需要仍有效且绑定目标/版本/`SERVICE_CONTROL_SCOPE` 的一次性 `approvalId`，`auto` tier 允许；确认拒绝/取消/失效不得触达 driver（`service-control.ts:211-280`，broker 的审批复核见 `sdk-agent-tool-broker.ts:1224-1315`）。这道 gate 不能因放开 UI 来源而绕过。Agent 必须从与人类启动相同的已确认绑定/模板/解析结果执行，而不是用 Agent 自己提供的另一份 program/env；还需接通“已确认 UI 配方可被 Agent 服务工具找到”的路径，否则只解开人类按钮不能满足 #7。

## 必须继续 fail-closed 的边界

- **受保护的应用 profile 与缺失可信上下文**：受保护路径检查保护应用私有目录，并在身份缺失/变化时失败关闭（`host.ts:789-804`；文件及导入路径的保护见 `workspace-files.ts:227-245`、`service-import.ts:132-149`）。这是文件读取的应用私有目录边界，和 `launchSource` 无关，甲不得放宽。Smoke 的 `protectedProfileReadDenied`（`electron-service-guard-smoke.mjs:89-95`）、`oldProtectedSourceDenied`（`:96-102`）和缺少 profile 上下文时拒绝（`:103-110`，汇总标志在 `:111`）也必须继续成立。
- **任务外 cwd**：继续拒绝解析后逃出任务根的工作目录（`service-processes.ts:130-144`）。这是实际子进程工作目录的路径约束，和登记来源无关。
- **凭据与本机私有值**：不得从导入源值、共享模板、页面返回或未 scrub 的日志泄露。当前仅显式 private refs 可进入 child env，日志要遮蔽；关于是否连 child env 也一律禁止，待业主拍板（见问题 3）。
- **owner 状态不确定**：durable inventory 缺失、fenced、不能验证或状态不是已确认 stopped/exited 时，拒绝 start/stop（`host.ts:734-768,779-787`）。来源资格不是 owner 身份证明。`service-owner-inventory.ts:38-55,62-72` 的 `closedBinding` 本身将 experimental owner 的 resolve/acquire/start 关闭，且 `executionAvailable: false`；这条尚未接入的 owner/inventory 路径不能被当作 UI launch 的旁路。
- **未登记 id**：未知服务 id 仍拒绝；Host 原来的 owner-inventory fallback 和 `unknown-service` 含义不能被 UI 资格放宽吞掉（`service-runtime.ts:389-392`、`host.ts:1486-1492`）。
- **页面/Agent 覆盖已确认 launch**：页面或 Agent 提供的 program/args/cwd/env 不可覆盖主进程确认的登记。保留 `service-registration-conflict` 的拒绝效果，并用更强的新断言覆盖宽泛的“页面描述符绝不执行”：**只有主进程确认的 task binding 可启动；未确认的页面描述符仍不执行；任何后来页面重登记都不能改写该 launch**。
- **调用身份和 Agent 权限**：不得把缺少 session 的任意调用当 human；不得允许 Agent 通过伪造 caller 或省略 session 绕过控制门（`host-guards.ts:134-172`、`host.ts:1448-1463`）。
- **平台/进程身份**：不支持验证真实 owner 的平台继续按具名 `unsupported-platform` 拒绝（`main/runtime.ts:1153-1167`）；停止进程仍须验证同一 launch 身份，不得为了 UI launch 来源放宽信号发送规则（`service-processes.ts:75-102`）。

## 现状清点与拟处理分类

以下 line 是在 HEAD `5089c66` 实际读取的源码行。**必须改**是完成甲的 UI 用户流程/Agent 同配置操作时需更新的说法或判定；**必须保留**指独立安全边界或对未确认页面数据的拒绝仍须成立；**待业主判定**指不能由实现者替业主设定的策略。仅有文件/用词相似而没有相关执行姿态的内容不列为拒绝依据。

### 必须改（不能再把所有界面登记一概当作永远不可执行）

| 位置 | 已读原文/断言 | 甲下的替代断言 |
|---|---|---|
| `packages/shell/src/host/host-guards.ts:193-202` | “Only main's trusted service catalog … may register an *executable* launch”; `serviceLaunchSource` 除 `service-catalog` 外一律 `ui`。 | 区分“未确认的普通 UI RPC”与“经主进程确认的 UI 配方”。确认来源必须由 main 验证，UI source 字符串本身不得铸造资格。`authorizeCodeObservation` 的 main-only 代码观察（`:205-230`）仍必须保留，不可让 UI 自证代码状态。 |
| `packages/shell/src/host/host-guards.test.ts:359-370` | 注释称“only main's own `service-catalog` envelope makes a service registration executable”；测试名“authorizes an executable launch only for main's service-catalog origin”。 | 增加/改写为：普通 `shell-ui` 描述符不执行；只有 main 认可的确认材料可执行；伪造 origin 仍为 ui。不要把 `undefined`、错误 sender id、caller 字符串变成可信来源。 |
| `packages/shell/src/host/host.ts:771-787,577-586` | “before a catalog service may be launched”; `if (!registered || registered.launchSource !== "catalog") return { kind: "unregistered" }`; 组路径对同一分支报“未由可信服务目录登记，无法执行”。 | 若 UI 保存/确认后的 launch 仍由 main 以 `service-catalog` origin 登记，底层来源守卫可继续拒绝 raw `ui` RPC；但必须改掉“所有界面创建的 recipe 永远不能进可执行路径”的产品/注释含义，并由 main 产生确认后的权威登记。若改为其他确认来源，precondition 也须验证该确认材料，而非无条件接受 `ui`。unknown id、owner uncertain 仍拒绝。 |
| `packages/shell/src/host/host.ts:1378-1384` | “Registration currently accepts only main-attested human UI callers”; “Execution remains disabled until real process ownership, cleanup and cross-platform stop pass.” | 更新为真实现状：进程执行已接线；说明 UI 草案的确认/主进程绑定路径，且 owner、平台、调用 gate 未通过仍拒绝。 |
| `packages/shell/src/host/host.ts:1480-1492` | “only a `catalog` registration carries an executable launch”; ui 分支返回“仅可信服务目录登记的服务可执行”；无 inventory 时也仅允许可信目录登记。 | 把拒绝限定为“未确认 UI descriptor”；已确认 UI 配方走同一 owner + gate + driver。未登记 id 的 fallback 和未确认 owner 拒绝不得误改为允许。 |
| `packages/shell/src/host/service-runtime.ts:15-18,46-52,120-121,325-326,405-413` | “Only … `catalog` … carries an executable launch”; “`ui` registrations never execute”; 默认 `ui` 的 registration 永不启用执行；`planRegisteredStart` 对任何 ui 抛拒绝。 | 改为记录确认状态/主进程来源，不用“UI”本身作永远拒绝条件；未确认的普通 UI registration/default 仍不得执行。`planRegisteredStart` 必须只消费完整注册材料并保持 request 只命名 id。 |
| `packages/shell/src/host/sdk-agent-tool-broker.ts:1170-1184,1212-1214` | Agent start/stop 先受来源限定；非 catalog 返回“仅由界面登记，未接入真实进程执行”。 | Agent 对已确认的 UI 配方也必须能请求同一个已登记服务；仅对未确认/缺失 launch 拒绝。保留同一个 tier gate、一次性 approval、revision recheck 和 caller 只能命名 service id 的约束。 |
| `packages/renderer/src/components/DesktopToolDock.tsx:1258,1280-1288`；`packages/renderer/src/data/taskServices.ts:105-116,156-190`；`packages/renderer/src/test/desktopTools.test.tsx:522-532` | `uiRegistered` 直接禁用按钮；文案“本机不会执行：此服务由界面登记；本机仅执行可信服务目录登记的服务”；数据注释为“`catalog` only executes; a `ui` registration is display data”；测试断言按钮 disabled、显示这句文案且没有 run call。 | UI 对 main 已确认/任务绑定的 launch 启用相同人类启动入口；未确认时显示具名阻断原因。renderer 的按钮状态不是安全 gate，Host 仍须独立校验。status schema 需要准确投影确认资格，不能把 UI 来源本身当授权。 |
| `packages/shell/src/host/service-public.ts:141-142`、`service-processes.ts:57-60` | “`catalog` only: a `ui` registration is display data and cannot execute yet”; driver 接线说明只认可 trusted catalog。 | 更新为“经 main 确认的任务配方”；继续说明子进程只消费 Host 的注册 launch，不能由 caller 传 plan。 |
| `docs/task-graph.md:73-77` | `serviceLaunchSource`“只把 `service-catalog` 登记当作可执行启动”；“`shell-ui` 登记永远只是展示/计划数据”。 | 改成确认边界：页面原始 RPC 仍为展示数据，但 main 确认并绑定的 UI 配方可执行。 |
| `packages/shell/src/host/service-execution-wiring.test.ts:518-548` | 测试名“keeps the trusted catalog launch when the page re-registers the same id, and never executes a page descriptor”；UI fresh id 预期 `service-execution-unavailable` 且 `pwned.txt` 不存在。 | 将“never executes a page descriptor”收窄为“never executes an **unconfirmed** page descriptor”；保持同 id hostile overwrite 拒绝与 `pwned.txt` 不存在，同时新增经过确认的 UI 配方端到端真实启动断言。 |
| `packages/shell/src/host/service-agent-tools.test.ts:655-668` | “A display-only (`ui`) registration is not executable material”; `service.start` 要返回 `tool-refused:service-execution-unavailable`，页面 program 不得运行。 | 继续验证未确认恶意 UI descriptor 拒绝、无 marker/副作用；另补 confirmed UI 的 Agent 成功路径与人类使用相同绑定。 |

### 必须保留（原因独立于 `launchSource`）

| 位置 | 原文/断言 | 为什么不随甲放宽 |
|---|---|---|
| `packages/shell/src/host/service-runtime.ts:338-344`；`packages/shell/src/main/service-group-caller.test.ts:102-114` | “界面配方不能覆盖其可执行描述符”；冲突时不发 control。 | 拒绝未经确认的 descriptor 覆盖是必要安全属性。必要的产品编辑必须先经有版本/差异确认的主进程保存，再重新解析；不能把 conflict 变成静默覆盖。措辞可更精确，但该安全断言不得移除。 |
| `packages/shell/src/host/host-guards.ts:174-188`；`packages/shell/src/host/sdk-agent-tool-broker.ts:1192-1210` | Agent “不能登记服务启动材料”；服务工具要求 id 已登记且 owner 可确认，status/log 走 read gate。 | Agent 不应自行铸造程序/参数/路径/环境；Agent 的执行权是对 main 已确认服务 id 发控制请求，不是写 launch material。若 Agent 要编辑配置，仍走具差异确认的编辑通道。 |
| `packages/shell/src/host/host-guards.ts:204-230` | 代码观察只能来自 main 对真实 worktree 的读取；shell-ui 不能自证。 | 这是 #10 代码观察可信度，不是执行来源判断。UI 确认 launch 不等于 main 已观察 commit/dirty。 |
| `packages/shell/src/host/service-owner-inventory.ts:38-55,62-72` | `closedBinding` 的 resolve/lease/start 都抛 `service-execution-unavailable`；不确定 inventory 报 `service-owner-inventory-unconfirmed`。 | 这是未接入生产执行 driver 的 owner/inventory 路径和持有者状态保护，不是 catalog/ui 区分。不能把它当成 UI launch 旁路或默认允许。 |
| `packages/shell/src/host/host.ts:734-768,779-787` | 缺 owner bootstrap、owner fenced、状态未知/未终止时返回 `service-execution-uncertain`。 | launch 来源不证明 durable owner 的状态。已有进程可能仍存活，不能在 owner 不明时启动第二份或向不确定 pid 发信号。 |
| `packages/shell/src/host/service-processes.ts:126-144` | 拒绝非绝对程序/cwd、任务根外 cwd；`spawn(..., shell:false)`。 | 这是路径与不经 shell 执行的约束；所有来源共用。Host 当前未证明 program 必在任务根内，是否增加此限制见选项和问题清单。 |
| `packages/shell/scripts/electron-service-guard-smoke.mjs:89-110` | protected profile 读取拒绝、不暴露路径/内容；旧 protected source 和缺可信 profile 上下文拒绝。 | 全部是 protected application path / Host bootstrap 约束，与 launchSource 无关，必须继续通过。 |
| `packages/shell/scripts/electron-service-guard-smoke.mjs:77-84` | 直接对普通 shell-ui 注册的 descriptor start 得 `service-execution-unavailable`。 | 对该脚本中的未确认原始 `task/registerService` payload，此拒绝仍应成立；它不应被误当作经确认的 UI 配方。需另加 confirmed 正例，不要把此拒绝改成允许任意 page payload。 |
| `packages/shell/src/host/sdk-agent-tool-broker.ts:1192-1210` | 未登记 id、owner uncertainty 在执行 gate 前拒绝；status/log 走 read gate。 | 身份存在、状态可信、读写权限分离独立于来源资格。 |
| `packages/shell/src/host/host.ts:1448-1463`、`service-control.ts:211-280`；`packages/shell/src/main/service-execution-production.test.ts:319-343`；`packages/shell/src/main/runtime-layout.test.ts:362-377`；`packages/shell/src/rpc/protocol.ts:135-160` | main 分类 caller；Agent 读实时 permission 与 live approval，scope/target/version 复核，一次性消费后才 dispatch。生产测试拒绝未知 sender 与 payload 额外的 `program`/`cwd`/`env`/session/approval/label；origin 由 main 盖章。生产路径测试也锁定 page 只命名 service identity/action，由 main 解析 launch 并 stamp `service-catalog`。 | 这是人类与 Agent 触发权和 main-authoritative launch 的安全约束，不应因 UI 配方可执行而降级；确认配置只能通过受控保存/绑定成为 main 可解析状态，启动请求仍不可携带 launch material。 |

### 待业主判定

| 位置 | 当前已读事实 | 需要业主决定 |
|---|---|---|
| `packages/shell/src/main/service-catalog.ts:608-619` | `programPath` 被 realpath 后校验为 executable regular file；这段没有检查 program 本身位于任务根/仓库根。 | 是否仅允许任务工作区内 executable，或允许事先声明并确认的外部根？这决定窄方案的路径范围。 |
| `packages/shell/src/main/service-catalog.ts:644-655`；`packages/shell/src/main/service-config.ts:404-412`；`packages/shell/src/host/service-runtime.ts:428-445` | private refs 经 main 解析进入 child env；child env 新建；service stdout/stderr 的 resolved secret 值会被遮蔽。 | 私有值是禁止进入任何 child env，还是只禁止共享模板、未授权输入、页面输出和日志？这是现有功能合同的产品/安全选择。 |
| `packages/shell/src/host/service-control.ts:125-137,211-280` | 人类是 sender-attested 显式控制、无 Agent tier gate；Agent 在 read/default/auto 下分别拒绝/审批/允许。 | 是否每次人类启动、Agent auto 启动也必须有额外逐次确认？确认配方与批准一次运行是否为两种独立确认？ |
| `packages/shell/src/host/sdk-agent-tool-broker.ts:1192-1214`；`packages/shell/src/main/runtime.ts:1206-1239` | Agent tools 操作 Host 当前 service registry；main 的 `runTaskService` 登记/启动由人类 shell UI 入口触发。 | Agent 是否能在没有人类先点启动的情况下使用已确认绑定？需要选择统一的 registration/resolution 生命周期，不可依赖仅人类路径产生的临时记录。 |
| `packages/shell/src/host/host-guards.ts:193-202`；`packages/shell/src/host/service-runtime.ts:314-344` | `shell-ui` 的 task RPC 当前得到 `launchSource: "ui"`；已 `catalog` 的同 id 不能由普通 UI registration 覆盖。 | “甲”授权的是主进程把用户确认的 UI 配方登记为可信 launch，还是连未经另行确认的每个 `task/registerService` 页面描述符都应可执行？后者风险显著更高，不能由实现者从“界面登记”字样自行推断。 |

### 文档与证据范围

- 对 `docs/adr/0001`–`0004` 执行了相关词条检索，未发现“界面登记配方不得执行”的既有决策措辞；本 ADR 是新草案。`GLOSSARY.md:27-44` 只定义共享模板、私有配置和服务，没有当前 launchSource 拒绝规则，不需因本决策直接改术语定义。
- `packages/shell/src/main/runtime.ts:1192-1239`、`packages/renderer/src/data/shellHost.ts:895-914` 的现有执行入口约束可保留：renderer 只命名项目/任务/服务/动作，main 解析持久化 launch；`packages/shell/src/main/service-execution-production.test.ts:327-343` 对额外 launch/caller 字段的拒绝是安全断言，不是“已确认 UI 配方永不可执行”的姿态。
- Smoke 中 `denied` 是上述未确认 UI payload 的拒绝；其余 `missingTrustedContextDenied`、`protectedProfileReadDenied`、`oldProtectedSourceDenied` 如表中所述必须保持。脚本只打印这些标志（`:111`），不是只看启动拒绝的单一 smoke。
- 搜索发现的 `service-registration-conflict` 正例、Agent `service.start` 未确认 UI 拒绝、`taskServices.ts` 的来源投影注释，以及 Dock `uiRegistered` 禁用/文案和对应渲染测试也已逐条列在上表；非 service 主题的普通 `page`/`untrusted` 字样不构成该执行策略的证据。

## Considered Options

- **甲：全量放开所有界面登记**（不建议将“全量”理解成信任任何页面 payload）。最直接达成 dock 启动，但若 `shell-ui` 带来的任意 descriptor/argv/cwd/env 都变成 launch，renderer 缺陷或被注入脚本即可让本机真实 spawn 页面任意程序。重登记还可能覆盖当前运行身份/配置。Agent 的配置入口与启动 gate 仍需单独接通；只解开人类按钮并不满足目标。
- **乙：维持当前 catalog-only**。保留现成的 main 权威链和风险面最小，但从现有配置导入的 draft 即使人类确认编辑也不能以 UI 配方启动；不满足 #7 的甲路线核心承诺。
- **窄中间方案（推荐作为甲的最小可行边界）：经用户确认的本机绑定可执行，原始页面描述符不执行**。对 import hint 作人工审阅；选择环境、编辑并确认共享配方；在任务本机绑定中选择/确认可执行文件和工作目录；main 验证任务/项目/环境/版本与本机路径后生成唯一 launch 注册；人类与 Agent 使用相同解析结果。程序建议限制在任务工作区或业主明确声明的执行根目录，argv 从已确认、校验过的配方读取，RPC 只命名 service id/action。这样实现用户可见的「界面配方可启动」同时不把渲染进程等同于执行权威。代价是增加显式确认步骤、绑定数据/资格状态和 Host/Agent 正例接线；是否需要每次再确认和哪些根可选仍由业主决定。

## Consequences

如果批准最小边界，后续实现至少要：

1. 增加从 read-only import hint 到“已确认/持久化模板 + 任务本机 binding”的明确步骤，确认并固定环境、版本、程序、argv、cwd、环境变量映射；导入扫描本身仍不启动。main 在 Host 登记前重读并校验这些 authoritative inputs。
2. 不用现有 `launchSource` 单独表达用户确认状态。为 UI 操作建立由 main 产生且不可由 page/Agent 伪造的 launch eligibility / confirmation lineage；Host 在同一 control gate 前校验该事实。任何具体字段/API/schema 仍需后续实现设计，不在本 ADR 中假定已经存在。
3. 让 dock 人类启动和 Agent `service.start` 使用同一条已确认解析结果与同一 Host runtime/driver；不能让 Agent 自行发送另一个 program/argv/cwd/env。保留人类 caller attestation 和 Agent tier gate。
4. 增加两类正反端到端断言：确认后的 UI 配方确实产生真实 child，Agent 启动同一 id/配置确实走其 tier/approval；未经确认的 raw UI descriptor、覆盖已确认同 id 的 descriptor 均不产生进程，marker 不存在。Smoke 保留当前原始 payload 的 `denied`，另加经确认 launch 正例。
5. 保留本 ADR“必须保留”表里的 protected profile、caller identity、owner uncertainty、unknown id、任务外 cwd、`shell:false`、secret log scrub 和平台 owner verification 断言。不可用“甲”名义降低安全断言。将“页面描述符绝不执行”反转时，替代断言必须更强且可测试：**未确认 page descriptor 永不执行 + 已确认 launch 只能由 main 从绑定/模板解析 + page/Agent 不可覆盖该 launch**。
6. 更新 `host-guards.ts`、`host.ts`、`service-runtime.ts`、`sdk-agent-tool-broker.ts`、`service-public.ts`、`service-processes.ts` 注释/拒绝分支、`DesktopToolDock.tsx`、`docs/task-graph.md` 和前列测试。这些是设计后续实施清单，不是本次草稿改动。

## 需要业主拍板的问题

1. “显式确认”具体确认什么：每个导入草案都要逐字段确认，还是确认过的共享模板可供后来绑定直接使用？修改 program/argv/cwd 后是否必须重新确认？
2. 可执行文件允许在任务工作区之外吗？若允许，是否要先由用户声明/确认执行根目录；若不允许，如何处理常见的 PATH 上 `node`/`pnpm` 等工具？
3. “本机私有值不得进入可执行环境”是绝对禁令，还是表示不得进入共享模板、页面、日志和 ambient env，而被用户明确映射的 private refs 可以进入服务子进程 env？后者是当前 `privateRefs`/`buildChildEnv` 设计的行为；前者会改变现有功能合同。
4. Agent 启动服务是否每次都必须审批？当前 `read` 拒绝、`default` 每次发起审批并一次性消费、`auto` 允许。甲是否接受该 tier 行为，还是要求连 `auto` 也每次人工批准？
5. 人类点击启动是否只需“用户已确认配方 + sender-bound UI 调用”，还是每次启动也需二次确认？当前人工启动是显式 UI 调用但不走 Agent tier/approval。
6. Agent 能否在未由人类先点过启动的情况下，直接使用 main 已确认且已绑定的配置启动？若是，需保证 Agent 与 dock 共享同一 main-authoritative registration/resolution lifecycle，而非依赖一次仅人类路径才产生的 Host 内存记录。
7. 用户确认后更改同一 service id 的模板/本机程序，允许通过显式 review/rebind 生成新 revision 吗？是否任何运行中的老配置都必须先停再替换？当前普通 UI 重登记会触发 `service-registration-conflict`。
8. Windows 等当前未实现服务 owner 核验的平台，是否继续按 `unsupported-platform` 拒绝，直到有等价进程身份/清理实现？本 ADR 建议继续拒绝。
