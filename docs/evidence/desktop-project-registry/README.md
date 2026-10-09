# [PiDock 02e/02f/02g/02h] (#38/#39/#40/#41) Desktop 项目注册表 — 真实 Electron 证据

本目录是 **真实 Electron**（生产运行时接线 + 已构建 React renderer，非 Vite/Playwright，非夹具页）
对「Desktop 项目与未归属任务接入持久 Host」的窗口级截图证据：从 **真实磁盘** 的 main-owned
Project 注册表读取项目、仓库/目录、已归属任务、待修复任务与明确未归属任务。启动路径与生产接线
的一致性及唯一省略项见 §2 / §4。

- 脚本：`packages/shell/scripts/electron-issue41-project-registry-capture.mjs`
- PNG：`1440x900-*.png` / `720x560-*.png`
- 元数据：`capture-log.json`（命令、源码版本、每张 PNG 的 sha256 / 像素尺寸 / deviceScaleFactor /
  捕获时的 `document.body.innerText`）

## 1. 重放方式

```bash
# 先构建（renderer build → copy-static → tsc）
pnpm --filter @pidock/shell build
# 再运行（隔离 profile + 固定临时根，脚本自身先清除 PIDOCK_RENDERER_URL / PIDOCK_TASK_URL）
pnpm --filter @pidock/shell exec electron scripts/electron-issue41-project-registry-capture.mjs \
  --out docs/evidence/desktop-project-registry
```

脚本启动前 `delete process.env.PIDOCK_RENDERER_URL` / `PIDOCK_TASK_URL`，并在渲染完成后用
`location.href` 断言加载的确是 **生产** `file:///.../renderer/index.html`；断言不成立即抛错退出
（fail closed），绝不接受 dev-server 覆盖。

## 2. 启动路径与数据源

- 启动路径：脚本从已编译的 `packages/shell/dist/main/*.js` **直接** 导入运行时模块，调用
  `createTrustedWindow("issue41","production")` + `loadTrustedViews` → `dist/renderer/index.html`
  （无 fixture entry、无 Vite、无 memoryHost fallback）。它**不**运行 `dist/main/main.js`，因此
  应用生命周期、窗口证据断言与定时驱动不参与本次捕获。
- 接线：与生产入口一致（`main.ts:157-180`）。`registerIpc(client, views.registry, tasks, projects, taskRoots,
  undefined, creation, providers, …)` 中传入真实的 `ProjectTaskCreation`（`CreationIntentStore` +
  `projects` + `TaskRootIndex` + `PerTaskHostRegistry`）与真实的 `ProviderWiring`
  （`ProviderProfileStore` + 生产 installer 体）。因此 `shell/createTask` 走真实分支
  （`current` 返回 `null`），渲染层**不**绘制 `真实任务创建尚未接入` 警报。
- 数据源：真实 `TaskRootIndex`（隔离默认任务根）+ 真实 `ProjectRegistry`（隔离 `userData` 下的
  `projects.json`）+ `PerTaskHostRegistry`（`utilityProcess` fork `dist/host/host-entry.js`）。
  没有演示对象、没有内存夹具、没有 dev server。
- 唯一未接线的生产依赖是 **服务配方目录**（`ServiceCatalog` / `tasks.configureServices`）：原因见 §4。
  本目录三个视图的可见内容不依赖它。

## 3. 会话内容：seeded 与驱动 vs. 真实用户操作（重要披露）

脚本 **seeded**（通过真实 API 写入磁盘，非手写假 JSON）：

| 内容 | 方式 |
| --- | --- |
| Project「Adder」+ 仓库 `invoice-service` + 普通目录 `设计资料` | `ProjectRegistry.create`（写 `projects.json`） |
| `task-aaaa1111` 认领到 Adder（`assigned`） | `ProjectRegistry.claim`（写 v2 membership） |
| `task-cccc3333` 认领后目录被替换 → `needs-repair` | `ProjectRegistry.claim` 后删除并重建同名任务目录，使持久 membership 记录的目录 dev/ino 与磁盘不符 |
| `task-bbbb2222` 明确未归属（`unassigned`） | 无 membership |
| 三个任务记录本身 | 生产 `task-store` 序列化器写入（#42 之前没有 renderer-free「真实创建任务」API；这里不是手写假 blob，也不是 UI 仿真） |

脚本 **驱动**：仅用 DOM click 切换视图（`项目管理`、`未归属任务`）。**不是**人工鼠标点击；
认领/转移/解绑/删除的 CRUD 行为仍由既有 vitest 套件覆盖，本目录只展示真实注册表状态。

**未由本证据覆盖（UNTESTED）**：

- 原生目录/仓库 picker 的真实交互；`找回任务根` 的原生流程。
- 真实用户点击路径（本脚本是程序化 DOM click）。真实认领/转移/解绑的 UI 提交（本目录只展示
  未归属条目可认领，不实际提交）。冷重启后的身份稳定性（`#39`/`#41` 的冷重启另有既有契约测试）。
- 真实 Host/RPC outage、无 bridge、原生长时间 pending/rejected-read 时序。
- Windows、断电/目录持久性、早期无摘要本地 v2 注册表恢复流程。
- `创建真实任务` / `pi 发送` 的真实流程（见 §5 规格冲突）。#24 同尺寸原型 A 的独立视觉验收。

## 4. 故障注入 / Proxy 情况

**本 harness 没有使用任何 Proxy 或故障注入。** 与 `#34` 的 `electron-issue34-task-inventory-capture.mjs`
（为制造读取失败而用一个 Proxy 只覆盖 `TaskRootIndex.inventory()`）不同，本脚本全部走生产实现；
`needs-repair` 是通过真实磁盘目录替换产生的真实注册表状态，不是注入的返回值。

**唯一省略的生产依赖：服务配方目录。** 生产入口还向 `registerIpc` 传入 `ServiceCatalog`
（`main.ts:180`），使 `tasks.configureServices` 生效服务归属围栏。本 harness **故意不接入**它：
`needs-repair` 场景会替换 `task-cccc3333` 的目录，而围栏生效时 Host 在 `quitAll` 阶段会因无法
验证被替换目录的身份而报 `service-owner-shutdown-unconfirmed`，受 `PerTaskHostRegistry.quitAll`/
`disposeAll` 的封口契约约束，清理 helper 不能忽略该失败。本目录三个视图的可见状态与它无关（服务
目录 IPC 仅在用户进入服务页面时才被调用）。

## 5. 规格冲突（不在本目录修正）

`#41` box 2 要求 `创建真实任务` 与 `pi 发送` 保持 **DISABLED（尚未接线）**，但后续 `#42/#45/#47`
已按负责人决策把它们接线（`main.ts:167` 构造 `ProjectTaskCreation`，`main.ts:180` 传入 `registerIpc`）。
本证据 **不** 撤销这些后继能力，也 **不** 重写工单。harness 与生产一样接入了 `ProjectTaskCreation`，
所以本目录 `项目管理` 截图里的 `新建任务` 入口是**可用**的，且 **没有** `真实任务创建尚未接入` 警报：
截图本身即表明当前源码与 box 2 的期望相反。该冲突交由负责人裁决，不属于本次源码改动范围。

## 6. 捕获方法与确定性

- 尺寸：脚本 `setContentSize(W,H)` 后断言 `getContentBounds()` 恰为 `1440×900` / `720×560`；
  文件名的 `WxH` 即实测 **CSS 内容盒** 尺寸。
- 捕获机 deviceScaleFactor 见 `capture-log.json`（本机为面板/显示器 1×，所以 `1440×900` 的位图就是
  1440×900 px；`pixelWidth`/`pixelHeight` 记录真实位图尺寸）。注意兄弟证据
  `docs/evidence/desktop-task-inventory/` 的 `capture-log.json` 记录 `deviceScaleFactor: 2`
  （同名 `1440×900` 对应 2880×1800 位图）：两份证据都如实记录各自的 dsf，跨证据比较请用
  `pixelWidth`/`pixelHeight`，不要按文件名比较。`#38` box 5 的 720×560 可读性检查是在本目录的
  1× PNG 上完成的。
- 截图使用渲染器调试协议的 `Page.captureScreenshot`（对精确尺寸的 shell view 取合成帧）。
  起因：本机某些显示/遮挡状态下 `webContents.capturePage()` 会以 `UnknownVizError` 被拒绝；
  该调用在本机未产出可用截图，因此本目录**只**提交 `Page.captureScreenshot` 的结果，也**不**
  声称两者逐字节相同（没有可提交的 `capturePage` 对照运行）。未做任何「重试到通过」。
- 固定临时根（`$TMPDIR/pidock-issue41-registry-capture`）使捕获到的本机路径稳定。本目录的 PNG/log 出自
  `capture-log.json` 的 `revision`（commit `34a1f8e`，已含本 harness）；在该 revision 连续两次重放得到
  6 张 **逐字节相同** 的 PNG，两次的 sha256 集合已提交在 `determinism-replay.json`，可与
  `capture-log.json` 的 `shots[].sha256` 逐条核对。项目/仓库/目录的 UUID 每次运行会重新生成且从不出现在
  画面里，故只声称 PNG 字节确定，不声称 `capture-log.json` 字节确定。
  `trackedFilesDirty` 由 harness 计算「源码树是否干净」：它排除 `--out` 指向的本目录（重放本身会覆盖其中
  已提交的字节），其余 tracked 路径必须干净；本 revision 的两次运行均为 `false`。

| 视图 | PNG | 实测画面 |
| --- | --- | --- |
| 项目总览（1440×900 / 720×560） | `1440x900-project-overview.png` / `720x560-project-overview.png` | 真实 Project「Adder」：进行中的任务 2、已绑定仓库 1、普通目录 1；`项目仓库与目录` 列出真实 `invoice-service` 与 `设计资料`；`另有 1 个任务尚未归属任何项目…` |
| 项目管理（1440×900 / 720×560） | `1440x900-projects-management.png` / `720x560-projects-management.png` | 项目列表（Adder）+ 详情「仓库 · 1 / 普通目录 · 1」+ 任务行：`对账单详情·已归属`（assigned）与 `接口联调·待修复 · 关联待修复`（真实 needs-repair）；侧栏 `未归属任务 · 1`；`新建任务` 入口可用、无 `真实任务创建尚未接入` 警报（见 §5） |
| 未归属条目（1440×900 / 720×560） | `1440x900-projects-unassigned.png` / `720x560-projects-unassigned.png` | `未归属任务 · 任务 · 1` 仅列 `运单查询·未归属`，带 `选择项目`/`认领` 控件 |

每个视图当时的 `document.body.innerText` 直接记录在 `capture-log.json` 的 `shots[].bodyText`，可逐行核对。

## 7. 失败与纠正（保留）

- 首次固定临时根版本因 `mkdirSync(profile)` 未 `recursive` 在 **模块加载期** 抛 `ENOENT`（早于
  watchdog 布置）；随后把 watchdog 与 `uncaughtException`/`unhandledRejection` 处理器前置、把
  `dist` 图改为动态 import、并把全部文件系统初始化移入受保护区域，使加载期错误也会非零退出。
- 之前 `capturePage()` 在本机以 `UnknownVizError` 失败（非可复现的截图，按证据纪律不采用），
  改用 CDP `Page.captureScreenshot` 后稳定通过。
- 本目录只保留在最终 revision 上可逐字节重放的截图；不保留「反复重试直到通过」的产物。
