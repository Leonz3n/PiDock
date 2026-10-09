# [PiDock 02e/02f/02g/02h] (#38/#39/#40/#41) Desktop 项目注册表 — 真实 Electron 证据

本目录是 **真实 Electron**（生产 main 接线 + 已构建 React renderer，非 Vite/Playwright，非夹具页）
对「Desktop 项目与未归属任务接入持久 Host」的窗口级截图证据：从 **真实磁盘** 的 main-owned
Project 注册表读取项目、仓库/目录、已归属任务、待修复任务与明确未归属任务。

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

- 启动路径：`createTrustedWindow("issue41","production")` + `loadTrustedViews` →
  `dist/renderer/index.html`（无 fixture entry、无 Vite、无 memoryHost fallback）。
- 数据源：真实 `TaskRootIndex`（隔离默认任务根）+ 真实 `ProjectRegistry`（隔离 `userData` 下的
  `projects.json`）+ `PerTaskHostRegistry`（`utilityProcess` fork `dist/host/host-entry.js`）。
  没有演示对象、没有内存夹具、没有 dev server。

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

## 5. 规格冲突（不在本目录修正）

`#41` box 2 要求 `创建真实任务` 与 `pi 发送` 保持 **DISABLED（尚未接线）**，但后续 `#42/#45/#47`
已按负责人决策把它们接线。本证据 **不** 撤销这些后继能力，也 **不** 重写工单；`项目管理`
顶部仍显示 `真实任务创建尚未接入` 的既有文句。该冲突交由负责人裁决，不属于本次源码改动范围。

## 6. 捕获方法与确定性

- 尺寸：脚本 `setContentSize(W,H)` 后断言 `getContentBounds()` 恰为 `1440×900` / `720×560`；
  文件名的 `WxH` 即实测 **CSS 内容盒** 尺寸。
- 捕获机 deviceScaleFactor 见 `capture-log.json`（本机为面板/显示器 1×；`pixelWidth`/`pixelHeight`
  记录真实位图尺寸，避免把 `WxH` 文件名误读为像素尺寸）。
- 截图使用渲染器调试协议的 `Page.captureScreenshot`（对精确尺寸的 shell view 取合成帧）。
  起因：本机某些显示/遮挡状态下 `webContents.capturePage()` 会以 `UnknownVizError` 拒绝，而
  `Page.captureScreenshot` 稳定；两者对同一状态产生 **逐字节相同** 的 PNG（已用既有
  `capturePage` 运行对照 sha256 验证）。未做任何「重试到通过」。
- 固定临时根（`$TMPDIR/pidock-issue41-registry-capture`）使捕获到的本机路径稳定，因此同一源码
  版本重放得到逐字节相同 PNG。本目录的 PNG/log 出自 `capture-log.json` 的 `revision`（该 commit 已含
  本 harness），`trackedFilesDirty: false`；在本 revision 连续两次重放 6 张 PNG sha256 逐字节一致。

| 视图 | PNG | 实测画面 |
| --- | --- | --- |
| 项目总览（1440×900 / 720×560） | `1440x900-project-overview.png` / `720x560-project-overview.png` | 真实 Project「Adder」：进行中的任务 2、已绑定仓库 1、普通目录 1；`项目仓库与目录` 列出真实 `invoice-service` 与 `设计资料`；`另有 1 个任务尚未归属任何项目…` |
| 项目管理（1440×900 / 720×560） | `1440x900-projects-management.png` / `720x560-projects-management.png` | 项目列表（Adder）+ 详情「仓库 · 1 / 普通目录 · 1」+ 任务行：`对账单详情·已归属`（assigned）与 `接口联调·待修复 · 关联待修复`（真实 needs-repair）；侧栏 `未归属任务 · 1` |
| 未归属条目（1440×900 / 720×560） | `1440x900-projects-unassigned.png` / `720x560-projects-unassigned.png` | `未归属任务 · 任务 · 1` 仅列 `运单查询·未归属`，带 `选择项目`/`认领` 控件 |

每个视图当时的 `document.body.innerText` 直接记录在 `capture-log.json` 的 `shots[].bodyText`，可逐行核对。

## 7. 失败与纠正（保留）

- 首次固定临时根版本因 `mkdirSync(profile)` 未 `recursive` 在 **模块加载期** 抛 `ENOENT`（早于
  watchdog 布置）；随后把 watchdog 与 `uncaughtException`/`unhandledRejection` 处理器前置、把
  `dist` 图改为动态 import、并把全部文件系统初始化移入受保护区域，使加载期错误也会非零退出。
- 之前 `capturePage()` 在本机以 `UnknownVizError` 失败（非可复现的截图，按证据纪律不采用），
  改用 CDP `Page.captureScreenshot` 后稳定通过。
- 本目录只保留在最终 revision 上可逐字节重放的截图；不保留「反复重试直到通过」的产物。
