# [PiDock 02a] (#34) Desktop 真实任务列表与空态 — 真实 Electron 证据

本目录是 **真实 Electron**（生产 main 接线 + 已构建 React renderer，非 Vite/Playwright，非夹具页）
对 #34 Desktop 数据源四个状态的截图证据。截图可由此目录内的命令从当前源码重放。

## 1. 重放方式

```bash
# 先构建（renderer build → copy-static → tsc）
pnpm --filter @pidock/shell build
# 再运行（隔离 profile + 隔离任务根，不设置 PIDOCK_RENDERER_URL / PIDOCK_TASK_URL）
pnpm --filter @pidock/shell exec electron scripts/electron-issue34-task-inventory-capture.mjs \
  --out docs/evidence/desktop-task-inventory
```

- 脚本：`packages/shell/scripts/electron-issue34-task-inventory-capture.mjs`。
- 启动路径：`createTrustedWindow("issue34","production")` + `loadTrustedViews` →
  `dist/renderer/index.html`（脚本先用 `location.href` 断言加载的确是生产 renderer 入口）。
- 数据源：真实的 `TaskRootIndex` / `ProjectRegistry` / `PerTaskHostRegistry`（`utilityProcess` fork
  `dist/host/host-entry.js`），磁盘上真实的 `task.json`；没有 fixture、没有演示对象、没有 dev server。
- 隔离：profile 与任务根都在 `mkdtempSync` 临时目录内，运行结束删除，不触碰本机真实任务。

## 2. 本轮捕获

- 命令：见 `capture-log.json` 的 `command`。
- 源码版本：`capture-log.json` 的 `revision`。本目录的 PNG 与 log 出自 **`3b08884`**（该 commit 已含本 harness），
  `trackedFilesDirty: false`（仅本目录下的 untracked 证据文件不计入 dirty）。
- PNG：`1440x900-<state>.png`。每个文件名等于实测内容盒尺寸（脚本用 `setContentSize(1440,900)` 并断言
  `getContentBounds()` 等于 1440×900，名字不会超出实际）。
- 每个 PNG 的 sha256 记录在 `capture-log.json` 的 `shots[].sha256`；同一源码重复运行得到相同 sha256
  （本 harness 为确定性捕获，无随机内容）。

| 状态（#34 盒 1/3/5） | PNG | 实测画面 | sha256 |
| --- | --- | --- | --- |
| (a) 空任务根 | `1440x900-empty-root.png` | `任务根 1/1 就绪`、侧栏 0 任务、`继续工作` 显示真实空态；无 Atlas Web/演示任务/演示统计 | `6fdf1f05…29cea2` |
| (b) 默认根内合法持久任务 | `1440x900-real-task.png` | 侧栏与「继续工作」列出真实 `对账单详情·本地联调`（来自磁盘 `task.json`），`任务根 1/1 就绪` | `bf42e65e…8d324cb4` |
| (c) 损坏记录被拒绝 | `1440x900-corrupt-record.png` | `默认任务根：任务根目录不可读取或任务身份冲突，请检查后重试` + 重试按钮；同根内合法任务**也未**被列出（根 fail closed），无代替/演示行 | `6f172d62…c82e0e19` |
| (d) Host/list 读取失败 | `1440x900-read-failure.png` | 整页可操作错误 `任务记录不可读取，请检查本机任务目录后重试` + `重试`；无演示回退 | `9b5aa3bc…d2a0a72d` |

`capture-log.json` 还记录每个状态当时的 `document.body.innerText`（前 600 字符），可直接核对上面每一行。

## 3. 诚实的边界

- **状态 (d) 的故障注入**：`shell/listTasks`（`packages/shell/src/main/runtime.ts`）只在
  `TaskRootIndex.inventory()` 抛错时返回 `{ok:false,...}`；当前 `inventory()` 自身吞掉扫描错误并以
  根级 error 返回（即状态 (c)），所以生产磁盘故障**不会**走到整页读取失败分支。本 harness 因此用一个
  `Proxy` 只覆盖真实 index 的 `inventory()` 一个方法（其余方法仍走生产实现），触发真实的 handler catch
  分支与真实 renderer 错误态。截图内容（错误文案 + 重试）来自当前源码，未伪造 UI。
- **未声称**：本证据不覆盖 覆盖根 picker/导入 GUI 流程（见 `docs/desktop-task-root-coverage.md`），
  不覆盖导航进入任务工作区、真实 pi 对话、服务或 PTY；截图不替代这些。
- **未声称**：只测 1440×900 一个档位；其他窗口档位由既有 UI 对齐证据覆盖，本目录不重复声称。
- **重跑失败即失败**：本目录不保留“反复重试直到通过”的截图。第一次运行以非零退出（清理阶段
  `quitAll` 报 `task-moved`）：因为当时把默认根任务记录改坏，已 fork 的 Host 无法再次解析到任务身份。
  这是 harness 顺序缺陷而非截图失败；修正为“在 fork 之前完成空根/损坏态，并让合法任务留到读取失败态
  之后”后重跑，`EXIT=0`，`trackedFilesDirty=false`。
