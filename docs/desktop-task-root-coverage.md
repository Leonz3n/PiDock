# [PiDock 02c] (#36) 覆盖任务根索引：测试覆盖与明确未测项

本文件是 #36 盒 4「实际 GUI 验证若受阻明确记为未测」的仓库内落地记录。它只陈述当前源码与现有测试
能/不能证明什么，不代表 #36 已整体验收，也不把测试或夹具截图当作 GUI 证据。

## 1. 已有测试覆盖（可重跑）

命令（仓库根）：

```bash
pnpm --filter @pidock/shell build            # 生产 renderer + main/Host 产物
pnpm --filter @pidock/shell exec vitest run src/main/task-root-index.test.ts \
  src/main/task-inventory.test.ts src/main/task-resolver.test.ts src/main/runtime-layout.test.ts
pnpm --filter @pidock/renderer exec vitest run src/test/desktopApp.test.tsx src/test/desktopProjects.test.ts
```

| #36 盒 | 覆盖点 | 测试（文件 + 用例名） |
| --- | --- | --- |
| 1（持久登记/重启/重复登记/根移走） | main-owned、带版本与备份的覆盖根索引：`register` 只在 Host 成功 provision 后登记且可重试；`importRoot` 只对显式选择的目录；根移走/删除后按根报错；重复登记幂等 | `packages/shell/src/main/task-root-index.test.ts`：「registers only successfully persisted override identities, reopens and idempotently retries」「recovers only the selected legacy root and rejects duplicate/imported identity conflicts」「isolates missing, corrupt and retargeted override roots without inventing default-root tasks」「rejects changed disk record, linked task and ID conflict across existing roots」「serializes concurrent registrations and rejects changed identity on retry」「fails closed when primary is removed, corrupt, versioned wrong or interrupted after first backup」 |
| 2（用户驱动的找回，不静默宣称发现） | 未登记旧任务在已登记根中显式披露，需明确导入；默认根空态与缺失根区分 | 同上：「discloses unindexed legacy tasks in an otherwise registered root until explicit import」「distinguishes a valid empty default root from a missing root and retries after explicit restoration」「refuses a missing/file/empty-link default root …」 |
| 3（读取前校验边界与身份，冲突 fail closed） | 符号链接/移动/身份改变拒绝；失效覆盖根保留索引 ID 参与冲突检查；`resolve` 只返回验证后可见的同源任务；索引损坏全局 fail closed | 同上：「never routes a default task into a corrupt/missing override root sharing its ID」「preserves unrelated validated tasks when a failed root retains a colliding ID」「rejects a linked index file instead of following it …」 |
| 4（Desktop 列表纳入已登记覆盖根；单根失败有准确错误，不用夹具补齐） | `shell/listTasks` IPC 直接测：任务域 sender 被拒、renderer 传任意 `taskDir` 被拒、仅默认根、默认根+已登记覆盖根的并集、单根失败按根报错且不回填夹具；picker 导入只接受主帧且拒绝 payload 路径 | `packages/shell/src/main/runtime-layout.test.ts`：「lists the configured roots, refuses a task-domain sender and arbitrary taskDir payloads, and reports one failing root without fixture backfill」「accepts picker-only import from the shell main frame and refuses payload paths」 |
| 4（Desktop 渲染层并集与失败根） | 默认根 + 已登记覆盖根 + 失败根：两真实任务同时列出，失败根显示准确错误与重试，demo `memoryHost` 在 desktop 模式下从不读写 | `packages/renderer/src/test/desktopApp.test.tsx`：「lists the default and a registered override root together, surfaces one failing root, and never touches the demo fixture」 |
| 5（迁移风险/用户确认） | 索引主文件损坏/丢失不静默重建、备份需显式恢复；拒绝自动改写既有任务的 `taskDir`（迁移需单独用户批准） | `packages/shell/src/main/task-root-index.test.ts`：「fails closed when primary is removed, corrupt, versioned wrong or interrupted after first backup」，以及 `task-root-index.ts` 的 `rootFailure` 文案分支 |

相关真实 Electron 证据（#34 盒 1/3/5）在 `docs/evidence/desktop-task-inventory/`：空根 / 合法持久任务 /
损坏记录被拒 / Host-list 读取失败四态，全部来自生产 main + 生产 renderer。

## 2. 明确 UNTESTED（不得用测试或截图顶替）

以下内容**没有** harness，也没有任何截图/夹具能代替：

1. **覆盖根 picker / 导入 GUI 流程未测**：`packages/shell/scripts/**` 中没有任何 harness 驱动
   `shell/importTaskRoot` 的真实系统目录选择器，也没有 UI 点击「找回任务根」→ 原生弹窗 → 选择目录 →
   列表出现的端到端证据。现有 `runtime-layout.test.ts` 的 picker 用例只注入一个 test-only picker 函数
   （`pickRoot: async () => null`）来证明“主帧 + 无 payload 路径”，**不**证明真实弹窗与真实选择。
2. **真实 Host 覆盖根 provision 端到端未测**：`TaskRootIndex.register` 由 `PerTaskHostRegistry`
   在真实 Host provision 成功后调用；现有索引测试直接调 `register`，没有“真实 `utilityProcess` Host
   在覆盖根下 provision → 索引落盘 → 重启后枚举”的整链证据。
3. **覆盖根任务的 Desktop 目录内容/视觉未测**：`docs/evidence/desktop-task-inventory/` 只覆盖默认根四态；
   覆盖根被登记后的同屏列表只在 renderer 单测（bridge double）与 `shell/listTasks` seam 测试中证明，
   没有真实 Electron 截图。
4. **Windows 原生断电持久性、跨进程路径更改的检查/使用竞态**：不能声称已原子消除；移动既有根时
   `task.json` 仍绑定旧路径，需单独用户批准迁移，不自动改写。
5. **`#34` 的导航进入任务工作区、真实 pi 对话、服务与 PTY**：与本文件范围相邻但未验证，见对应工单。

## 3. 与 #34 的关系

`shell/listTasks` 的载荷里 `roots[]` 已包含「默认任务根」与「已登记任务根 N」，Renderer 用同一份
`roots` 渲染失败原因与重试（`DesktopShell.tsx DesktopRootErrors`）。范围提示（「仅显示默认及已登记任务根；
其他位置需明确找回。」）在 `DesktopInventory.tsx` 项目管理视图常驻，因此覆盖根历史任务“无法自动发现”
不会被表述成「本机没有任何任务」。#34 的空根/错误态截图见 `docs/evidence/desktop-task-inventory/README.md`。
