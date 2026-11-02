# PiDock · Google Stitch 设计任务书

**状态：** 设计候选，待业主确认方向。视觉方向为 **Quiet Ledger（安静台账）**，替代旧原型 A；旧桌面与原型 A 不再作为复刻目标。
**规格依据：** [父规格 #1](https://github.com/Leonz3n/PiDock/issues/1)、[首版收口 #135](https://github.com/Leonz3n/PiDock/issues/135)、[UI 交接 #24](https://github.com/Leonz3n/PiDock/issues/24)。
**设计系统：** `DESIGN.md`（符合 google-labs-code/design.md 格式，`lint` 0 error / 2 个透明背景对比度预期警告）。
**并存的另一候选：** [`../stitch-apple/`](../stitch-apple/README.md) 是独立的 Apple 风格版本；两套 token、导航和提示词不混用。统一入口见 [`../README.md`](../README.md)。
**范围：** 项目 → 任务 → 会话；已有目录与独立 worktree；定时任务；Provider / MCP / Skills；会话生命周期；归档与清理。
**不在范围：** 服务启停与编排、环境模板、内置浏览器、内置终端、远程访问、复杂用量报表、文件/差异工作台。
**示例数据：** 参考图中的任务名、路径、分支、提交、计数与状态仅用于版式，不代表真实运行结果。

---

## 1. 在 Stitch 中怎么用

1. 新建一个 Stitch 项目，目标平台选 **Desktop / Web**，语言选 **简体中文**。
2. 设计系统：若当前 Stitch 工作区支持绑定 `DESIGN.md`，直接绑定本目录的 `DESIGN.md`；若不支持，把下面「全局 Prompt」连同 token 列表作为第一条消息发送，并选择 **不使用预设主题 / Custom**。
3. 一次只生成一个界面。先发全局 Prompt，再按 S01–S12 逐屏发送；每屏附上对应的 `reference/*.png`。
4. 参考图是**版式与密度参考**，不是要求逐像素复刻。让 Stitch 保持层级、间距、字体和颜色，不要复制图片里的占位内容。
5. 每生成一屏，用「迭代 Prompt」修正，不要重开项目；最后一屏生成完再统一检查禁用项。
6. 生成后导出 Figma 或 HTML 供评审。评审确认方向后，才进入产品实现；本文不构成开工授权。

> Stitch 对超长 prompt 的遵循度会下降。下面的单屏 Prompt 已经是可直接粘贴的完整版本，**不要再追加形容词堆叠**。

---

## 2. 全局 Prompt（每个新项目先发一次）

```text
Design a high-fidelity desktop application UI for "PiDock", a local workbench where a
developer runs multiple coding agents organised as Project → Task → Session. The app is
Chinese-first (Simplified Chinese UI copy) with technical identifiers kept in English.

Platform: desktop web app, 1440 × 900. Desktop only; do not design a mobile layout.
Visual direction "Quiet Ledger": warm paper surfaces, editorial restraint, hairline rules,
ink-blue interaction, text-first status. It should feel like a calm operational ledger for
serious work, not a SaaS dashboard and not a chat toy.

Use exactly these colors (do not apply a Stitch theme or auto-generated palette):
canvas #F7F7F4, surface #FFFFFF, sunken #EFEFEA, sidebar #F1F1EC, code #F3F3EF,
ink #17191C, secondary text #3E4750, muted #66707A, hairline #E3E2DC, strong line #CFCFC7,
primary #2B4ACB, primary hover #1F3AA8, primary tint #E9EEFC,
attention #8A5300 on #FBF0DC, danger #A93630 on #FBEAE8, settled #2F4858 on #E8EDF0.

Typography: Inter for Latin, Noto Sans SC for Chinese (fallback PingFang SC); JetBrains Mono
for paths, branches, commit hashes, model IDs and inline code. Body 14/22, page title 30/38,
task title 24/32, section title 20/28 or 16/24, meta 12/18, labels 12/16. Respect a 68–76
character reading measure.

Layout: 264px left sidebar with 1px right rule, 56px top bar, 32px content padding, 8px
spacing grid, 44px list rows, 10px card radius, 8px input/button radius, 14px dialog/composer
radius. Structure comes from hairline rules and tonal surfaces, not cards and shadows.
Shadows only for popovers, drawers and dialogs.

Hard constraints:
- Never use green, mint, emerald or lime anywhere (accents, statuses, charts, illustrations).
- No gradients, glass blur, neon glow, purple AI gradients, 3D blobs, emoji icons.
- Status is always written in Chinese words plus an optional 6px dot; never colour alone.
- Show real facts (paths, branches, commits, model, permission) in mono text. If a value is
  unknown, write 未知; if a capability is not wired, write 未接线. Never invent success.
- Use realistic Simplified Chinese product copy, not lorem ipsum.
```

### 设计系统速查

| 角色 | 值 | 用法 |
| --- | --- | --- |
| 画布 | `#F7F7F4` | 应用背景、顶栏 |
| 表面 | `#FFFFFF` | 对话列、面板、对话框 |
| 下沉 | `#EFEFEA` | 悬停行、只读事实、分段控件底 |
| 侧栏 | `#F1F1EC` | 导航列 |
| 主墨 | `#17191C` | 标题、正文 |
| 次墨 | `#3E4750` | 辅助正文、图标 |
| 弱化 | `#66707A` | 时间、计数、占位 |
| 分隔 | `#E3E2DC` | 1px 规则线、输入边框 |
| 强调 | `#2B4ACB` | 主按钮、链接、运行中、焦点 |
| 等待 | `#8A5300` / `#FBF0DC` | 等待确认、跳过、需处理 |
| 失败 | `#A93630` / `#FBEAE8` | 执行失败、路径失效、危险确认 |
| 已归 | `#2F4858` / `#E8EDF0` | 已完成、已归档、已停止、只读 |

**字体：** Inter / Noto Sans SC / PingFang SC；`JetBrains Mono` 仅用于机器事实。中文不使用字间距，标题用 600，不用 700。
**状态词：** 执行中、等待确认、已完成、已停止、失败、已归档、已过期、已跳过、未接线、未知。
**工作区模式词：** 独立 worktree、共享目录、共享原文件。不要用「工作空间」指任务。

---

## 3. 参考图与屏幕顺序

| 编号 | 文件 | 界面 | 主要验证点 |
| --- | --- | --- | --- |
| S01 | `reference/01-workbench.png` | 工作台 | 侧栏、关注条、任务表、项目与今日计划 |
| S02 | `reference/02-task-workspace.png` | 任务工作区 | 事实条、会话标签、运行条、审批卡、输入框 |
| S03 | `reference/03-new-task.png` | 新建任务 · 来源 | worktree / 已有目录双模式、路径与基线 |
| S04 | `reference/04-project.png` | 项目总览 | 来源、任务、定时规则 |
| S05 | `reference/05-schedules.png` | 定时任务 | 列表 + 编辑器、自然语言周期、执行记录 |
| S06 | `reference/06-capabilities.png` | Provider 设置 | 凭据、模型、连接状态、默认配置 |
| S07 | `reference/07-attention.png` | 需要处理 | 分组、定位、处理动作 |
| S08 | `reference/08-recovery.png` | 准备失败恢复 | 逐来源状态、重试、保留事实 |
| S09 | `reference/09-cleanup.png` | 归档任务清理 | 未提交警告、保留/导出/移除 |
| S10 | `reference/10-sessions.png` | 全部会话 | 抽屉、进行中/已归档、搜索 |
| S11 | `reference/11-mcp.png` | MCP 设置 | 传输、连接、工具、失败状态 |
| S12 | 无 | Skills 设置 | 本地来源、启停、会话使用（用 S11 版式生成） |

参考图同时提供 `reference/*.svg`。SVG 可直接导入 Figma；PNG 用于附加给 Stitch。

---

## 4. 单屏 Prompt

### S01 · 工作台（Home）

```text
Create the "工作台" (Workbench) screen for PiDock, using the attached reference for layout
density. Desktop 1440×900.

Layout: 264px sidebar. Top: π brand in a 30px ink-blue rounded square, "PiDock", a "本机" host
chip. Search field with ⌘K. Primary nav: 工作台 (active), 需要处理 with a 3 badge, 定时任务.
Project list: Atlas 结算系统 / 基础设施 / 文档站 / 个人脚本, each with task count, plus a
separate "未归属任务 1" row (historical unassigned tasks; never guess a project). Bottom:
能力与设置, "2 个 Provider 已连接", version. Top bar: 工作台, date on the right, primary
"新建任务". Main content: page title 工作台, subtitle "3 个任务正在运行，1 个会话等待你确认。"
Below it a white attention strip with a 3px amber left rule: "1 个会话等待你确认" / "升级 Provider
配置 · 即将运行 pnpm install，目标 ~/work/infra" and a blue "去处理" button. Then section
"进行中的任务" with a compact 4-row table (任务 / 项目 / 状态 / 最近活动): 修复结算对账的分页边界
(执行中), 升级 Provider 配置 (等待确认), 生成 v0.2 发布说明 (已完成), 归档旧迁移脚本 (已停止).
Each task row shows a mono meta line: "独立 worktree · feat/settlement-paging · 9f3c21a" or
"共享目录 · ~/work/infra". Below, two panels side by side: "项目" with three project rows and
counts, and "今天的定时任务" with three schedules, times and status pills.

Use hairline separators, warm paper, no cards-with-shadows, no green. Keep the table scannable
and the page calm. Do not add charts, KPI tiles or a hero illustration.
```

### S02 · 任务工作区（执行中 + 等待确认）

```text
Create the PiDock task workspace, desktop 1440×900, using the attached reference.

Keep the 264px sidebar with the active project expanded and the current task highlighted.
Top bar breadcrumb "Atlas 结算系统 / 修复结算对账的分页边界" and a secondary "任务详情" button.
Task header: eyebrow 任务, title "修复结算对账的分页边界", then a mono fact strip:
独立 worktree · atlas-api · feat/settlement-paging · 9f3c21a · 2 个来源. Right meta
"保存于 2 分钟前".

Below the header: session tabs "排查分页重复" (active, blue dot), "写回归测试", a + button,
and "全部会话" on the right. A 36px run bar under the tabs: blue dot, "执行中 00:42 · 正在读取
src/billing/paging.ts", and a compact "停止" button on the right.

Conversation column 760px, centered: date divider 今天; user message in a light sunken block
"结算单第二页开始出现重复行。先确认分页游标在边界条件下有没有被重复使用，然后补一个回归测试。
不要改动导出接口。"; agent message with a 2px blue left rule, role "Pi · 10:22", text about
reusing a stale cursor; a tool result card "read_file" / "src/billing/paging.ts · 读取 182 行" /
已完成 / 查看. Then an inline approval card with a 3px amber left rule and amber-tinted header:
"需要你确认" / "1 小时后过期"; body label 运行命令, mono code
"pnpm test --filter @atlas/api -- paging", note "将在独立 worktree 中执行 · 不推送远端 · 仅本次有效";
actions 拒绝 and primary 批准本次.

At the bottom, a 760px white composer with 14px radius: reference chip "src/billing/paging.ts",
placeholder "继续描述，或按 ⌘Enter 发送…", bottom row "+ / @ 引用 / $ 技能 / / 命令 / 每次询问 /
Claude Sonnet 4.5 / 上下文 18%" and a square blue send button. No right dock, no terminal,
no green.
```

### S03 · 新建任务 · 选择来源

```text
Create the "新建任务 · 选择来源" full-window sheet for PiDock, 1440×900, step 2 of 3.

Left 256px step rail on sidebar surface: π / PiDock / 新建任务 in the top bar; steps 1 基本信息
(done), 2 选择来源 (active white card), 3 确认并创建. Footer note "你可以稍后追加来源；已有来源
不会被静默替换。"

Content: title "选择任务来源", subtitle "选择这个任务要访问的仓库和目录。每个 Git 仓库可以创建
独立 worktree，也可以直接使用已有工作目录。" Section 代码仓库 with "+ 添加仓库". Two repository
cards:
1. atlas-api, "Git 仓库 · 默认远程 origin", a segmented control [独立 worktree | 使用已有目录]
with 独立 worktree selected; fields 基准分支 origin/main and 本次固定提交 9f3c21a · 已获取 2 分钟前;
mono path "~/PiDock/atlas/1102-atlas-api"; right pill "独立副本".
2. atlas-web, same structure but 使用已有目录 selected; path "~/work/atlas-web"; amber pill
"共享原文件 · 修改会影响原目录".
Section 普通目录 with one card design-tokens, "普通目录 · 不要求 Git", path
"~/work/design-tokens", pill "共享目录", close icon.

Below, a pale blue callout with branch icon: "独立 worktree 从本次成功获取的提交创建" and
"不会覆盖来源目录或已有未提交代码；如果获取失败，会保留表单并标出具体仓库，不会退回旧基线。"
Sticky footer: "已选择 3 个来源 · 2 个独立副本 · 1 个共享目录" plus 上一步 and primary 下一步.

Keep the difference between isolated worktree and shared original directory unmistakable.
No service, environment or port settings on this screen.
```

### S04 · 项目总览

```text
Create the PiDock project overview, desktop 1440×900, using the attached reference.

264px sidebar with "Atlas 结算系统" selected in the project list and a "项目任务" list. Top bar
breadcrumb "项目 / Atlas 结算系统" and primary "新建任务". Page title "Atlas 结算系统",
subtitle "4 个来源 · 6 个任务 · 2 个定时任务 · 最近活动 2 分钟前". Right: 编辑项目 and ···.

Section 来源: three equal tiles with 1px borders — atlas-api (Git · origin/main · 9f3c21a,
path ~/work/atlas-api, pill 支持 worktree), atlas-web (Git · origin/develop · 41c8e07, path
~/work/atlas-web, pill 支持 worktree), design-tokens (普通目录 · 共享原文件, path
~/work/design-tokens, pill 共享目录).

Tabs: 任务 3 (active with blue underline), 已归档 2, 定时任务 2, 设置. Task table with columns
任务 / 来源 / 状态 / 会话 / 最近活动, four rows: 修复结算对账的分页边界 (执行中, 独立 worktree ·
atlas-api, 2 个会话), 核对导出接口的错误码 (等待确认, 共享目录 · atlas-web, 1), 生成 v0.2 发布说明
(已完成, 独立 worktree · atlas-api, 3), 清理旧迁移脚本 (已停止, 共享目录 · design-tokens, 1).
Each row has a title plus a short description in meta text.

Below: section 定时任务 with two rows (每周仓库改动摘要 · 每周日 18:00 · 下次 11月8日 18:00 ·
已启用; 每日风险巡检 · 周一至周五 17:00 · 下次明天 17:00 · 已启用) and a line
"上次执行 11月1日 18:00 · 已完成".

No KPI cards, no charts, no green. Keep source facts in mono.
```

### S05 · 定时任务（列表 + 编辑器）

```text
Create the PiDock scheduled tasks screen, desktop 1440×900, master-detail layout.

Sidebar: 定时任务 active; project list unselected. Top bar "定时任务" with primary
"新建定时任务" and meta "应用运行期间执行". Page title 定时任务, subtitle "在固定任务工作区按规则
创建独立会话；退出应用或系统休眠时不执行，也不补跑。"

Filter row: segmented 全部 4 / 启用 3 / 已暂停 1, search field "搜索规则或任务" on the right.
Left 400px list grouped by project: Atlas 结算系统 with rows 每周仓库改动摘要 (selected, blue left
rule, 每周日 18:00 · Asia/Shanghai, 下次 11月8日, on toggle), 每日风险巡检 (周一至周五 17:00,
下次明天), 站会主题准备 (已暂停, off toggle); then 基础设施 with 每周依赖升级检查.

Right 640px editor card for 每周仓库改动摘要: title, "Atlas 结算系统 · 修复结算对账", pill 已启用,
"下次 11月8日 18:00". Fields: prompt textarea with a 3-line summary prompt; Provider / 模型
"Anthropic 主力 · Claude Sonnet 4.5"; 会话权限 "每次询问"; 重复规则 "每周日 18:00"; 时区
"Asia/Shanghai (UTC+8)". A sunken preview box "接下来 3 次" listing 11月8日 / 11月15日 / 11月22日
18:00 and the note "同一任务已有执行未结束时，本次触发会跳过并记录原因。" Section 最近执行 with
two rows: 11月1日 18:00 已完成 12m 04s 查看会话; 10月25日 18:00 失败 · 获取远程记录超时 1m 12s
查看原因. Footer note "修改在会话边界生效；不会重放已执行的操作。" with 取消 / 保存.

No cron expression as the primary label; show natural language plus exact next runs.
```

### S06 · 能力与设置 · Provider

```text
Create the PiDock "能力与设置" screen with the Provider tab active, desktop 1440×900.

Sidebar bottom item 能力与设置 is highlighted. Top bar 能力与设置 with meta "配置保存在本机".
Page title 能力与设置, subtitle "Provider、MCP 与 Skills 在本机配置并绑定到真实会话；变更在会话
边界生效。" Tabs Provider (active with blue underline) / MCP / Skills.

Left 344px list "Provider 配置" with + 添加: Anthropic 主力 (selected, A avatar, "Anthropic · 3
个模型", pill 已连接, 默认), OpenAI 备用 (已连接), 本机 Ollama (已停用), dashed "添加 Provider".
Footnote "同一供应商可以有多个配置；会话选择其中一个配置及其模型。"

Right detail card: title "Anthropic 主力", pill 已连接, meta "Anthropic API · 创建于 10月12日",
··· menu. Fields 显示名称 and 服务地址 https://api.anthropic.com. 认证 section with masked mono key
"sk-ant-••••••••••••••••" and 更换 link; helper "凭据仅保存在本机，不进入项目仓库或对话内容。"
可用模型 3 个 with checkboxes: Claude Sonnet 4.5 (默认模型 · 200k 上下文), Claude Opus 4.1,
Claude Haiku 4.0. Sunken status box: settled dot, "连接正常 · 上次检查 2 分钟前", "12 个模型可用；
请求会使用本机保存的凭据。" and 测试连接 button. Note "会话进行中不切换配置；新会话或下一次模型
请求前生效。" Footer: 删除配置 in danger text, 取消 / 保存.

Never show a raw API key in full. Do not imply the provider is reachable without a real check.
```

### S07 · 需要处理

```text
Create the PiDock "需要处理" inbox, desktop 1440×900.

Sidebar 需要处理 active with count 3. Top bar 需要处理, meta "6 项未处理". Page title 需要处理,
subtitle "汇总所有项目中等待确认、执行失败和已完成未读的会话；处理后从列表移除。"
Filter segmented control: 全部 6 (active) / 等待确认 2 / 失败 1 / 已完成 2, right link 全部标记已读.

Grouped list with small group headers:
- 等待确认 (amber): 修复结算对账的分页边界 — "运行命令 · pnpm test --filter @atlas/api -- paging",
  "12 分钟后过期", primary 去批准; 升级 Provider 配置 — "写入文件 · ~/work/infra/package.json",
  "1 小时后过期", primary 去批准.
- 执行失败 (danger): 生成 v0.2 发布说明 — "读取文件被拒绝 · ~/work/design-tokens/changelog.md",
  查看原因.
- 已完成未读 (settled): 核对导出接口的错误码, 归档旧迁移脚本, both with 查看结果.
- 定时执行跳过: 每日风险巡检 — "同一任务仍有执行未结束，本次触发已跳过并记录。", 查看记录.

Each row is a white 72px card with a 3px status-coloured left rule, icon, title, context line,
detail line, time on the right and a single action button. Keep the list calm; no charts.
```

### S08 · 准备工作副本失败（恢复）

```text
Create the PiDock recovery state for a partially prepared task, desktop 1440×900.

Keep the app shell and task header. Title "准备工作副本时中断", mono meta
"1102-atlas · 2 个来源已准备，1 个失败 · 上次尝试 10:26".

Main 760px panel with a 3px danger left rule: alert icon, title "worktree 准备未完成", subtitle
"已准备的资源会保留；失败的来源可以单独重试，不会自动回退或静默替换。"
Section 来源状态 with three rows:
- atlas-api · 独立 worktree · feat/settlement-paging · path ~/PiDock/atlas/1102-atlas-api · 9f3c21a ·
  settled check · 查看目录.
- atlas-web · 独立 worktree · 需要 release/v2 · "获取失败：远程分支 release/v2 不存在（refspec 未匹配）"
  in danger · primary 重试.
- design-tokens · 共享目录 · path ~/work/design-tokens · 链接已建立 · 查看目录.
Then a sunken note: "已准备的副本和你的修改都已保留" / "重试只处理失败来源，不重新创建已成功的
worktree；放弃时需要明确选择范围。" / "来源目录和已有未提交代码不会被修改。"
Actions: primary 重试失败项, secondary 仅查看任务详情, danger text 放弃未完成来源. Note
"失败信息只描述本次获取；网络失败不等于分支不存在。" and link 复制错误信息.

Right 300px rail: 任务事实 (任务 ID 1102-atlas, 任务根 ~/PiDock/atlas, 创建, 上次尝试, 状态
准备未完成) and 恢复规则 (不覆盖来源目录 / 不自动重试 / 不认领未知目录).

Do not show a generic error page or a fake success. Preserve what exists.
```

### S09 · 归档任务清理

```text
Create the PiDock cleanup flow for an archived task, full-window sheet, 1440×900, step 2 of 3.

Top bar π / PiDock / 清理已归档任务, "步骤 2 / 3", close. Left 256px step rail: 1 选择任务 (done),
2 检查范围 (active), 3 执行并回执; footer "清理不是归档；无法一键撤销。" and "普通目录的原始文件
始终保留。"

Content: title "检查清理范围", mono "1102-atlas · 修复结算对账的分页边界 · 归档于 3 天前".
Danger warning banner "检测到 2 个未提交文件" with mono paths
"atlas-api · src/billing/paging.ts · src/billing/paging.test.ts" and "默认保留独立 worktree 副本。
删除副本会丢失这些修改，且没有撤销入口。" plus 查看差异.

Inventory panel with five rows, each with icon, title, mono meta, note and right controls:
- 独立 worktree · 2 个仓库 — 保留副本 (checked) / 删除副本, warning note.
- 会话 · 6 个 — 导出并移除 (checked) / 仅移除.
- 草稿 · 2 个 — 导出并移除 / 仅移除.
- 定时规则 · 1 个 — 导出并移除 / 仅移除.
- 任务登记与来源引用 — 查看.

Export destination row: folder icon, mono "~/Documents/PiDock Exports/1102-atlas", 更改.
Estimate "预计释放 1.8 GB · 估算值；以实际清理结果为准". Sticky footer summary "将保留 worktree
副本与导出文件，移除 6 个会话、2 个草稿、1 条定时规则。" / "来源仓库、普通目录和共享原文件不会被
删除。" with 取消 and danger "清理并保留副本".

This is destructive: use restraint, not alarm styling everywhere. Only the warning strip and final
button carry danger colour.
```

### S10 · 全部会话（抽屉）

```text
Create the PiDock "全部会话" overlay, desktop 1440×900, using the attached reference.

Background: the task workspace from S02, dimmed by a dark scrim. Right sheet 740px wide, full
height, white, 1px left rule. Header: "全部会话", subtitle "修复结算对账的分页边界 · 3 个进行中，
2 个已归档", close icon. Search field "搜索会话名称或最近消息".

Group 进行中 3: rows with title, status pill, message count + last activity, time on the right.
- 排查分页重复 (selected, blue tint, blue left rule, 执行中, 12 条消息 · 正在读取 paging.ts,
  2 分钟前, blue unread dot).
- 写回归测试 (空闲, 8 条消息 · 草稿已保留, 昨天 18:20).
- 导出接口核对 (已完成, 21 条消息 · 结果未读, 今天 10:42, unread dot).
Group 已归档 2: 初始排查 (14 条消息 · 归档于 3 天前, 10月30日), 错误码讨论 (6 条消息 · 归档于
10月28日, 10月28日), titles in muted ink and a 已归档 pill.

Bottom: note "会话归档不是任务归档；归档后仍可查看，但发送前需要恢复。", full-width primary
"新建会话" button, and two meta lines explaining new sessions share the workspace but not the
conversation context.

No modal-within-modal; the sheet is the only overlay.
```

### S11 · 能力与设置 · MCP

```text
Create the PiDock "能力与设置" screen with the MCP tab active, desktop 1440×900, using the
attached reference.

Same shell and tabs as S06, MCP underlined. Left 344px "MCP 服务器" list: github-mcp (selected,
stdio · 12 个工具, 已连接, on toggle), playwright-mcp (stdio · 连接失败, 失败 pill, on toggle),
filesystem-mcp (stdio · 4 个工具, 已停用, off toggle), dashed 添加 MCP 服务器. Note
"连接状态不等于工具已在会话中使用；工具调用仍经过 Host 授权。"

Right detail: title github-mcp (mono), pill 已连接, subtitle "GitHub 官方 MCP · 由 Pi 官方扩展加载".
Fields 显示名称 and 传输方式 stdio. 启动命令 in a code surface:
"npx -y @modelcontextprotocol/server-github". 环境变量 "GITHUB_TOKEN = ••••••••••••" with 编辑.
Sunken status: settled dot "连接正常 · 上次检查 1 分钟前", "12 个工具可用；配置变更在会话边界生效。"
重新连接. 可用工具 12 个: four rows with checkboxes — search_issues, get_pull_request,
create_pull_request (需要会话权限), add_issue_comment (需要会话权限). Note "工具名与参数来自实际
连接；连接失败时不会展示伪造的工具列表。" Footer: 删除配置 (danger text), 取消 / 保存.

Do not show a green connected state. Do not show tools for the failed server.
```

### S12 · Skills 设置（无参考图）

```text
Create the PiDock "能力与设置" screen with the Skills tab active, desktop 1440×900, matching
the layout language of S06 / S11.

Left 344px "本地技能" list: 代码评审 (来源 ~/.agents/skills/code-review, 已启用), 领域建模
(~/.agents/skills/domain-modeling, 已启用), 团队发布检查 (~/work/team-skills/release, 已停用),
and a dashed "+ 添加本地技能". Each row shows source path in mono, enabled toggle, and last use.
Right detail: title 代码评审, source path, "本地来源 · 只读", enabled toggle, description paragraph,
a preview of the SKILL.md heading and rules in a code surface, "适用范围" and "可用工具" facts,
and a note "修改在会话边界生效；来源被移动或删除时会明确报错，不会静默替换。"
Footer: 移除来源 (danger text), 取消 / 保存.

Skills are invoked from the composer with `$`; no marketplace, no install buttons, and no cards
decorated with AI sparkles.
```

### S13 · 空状态与降级状态（一组变体）

```text
Generate three small desktop states in the same design system (one screen each, 1440×900):
1. Empty workbench: no projects yet. Centered 20px folder icon, title "开始第一个项目", one sentence
   "项目保存可复用的仓库和目录，任务再从中选择来源。", primary "添加项目", secondary "打开本机目录".
2. Task with no sessions: task header visible, blank conversation column, centered title
   "这个任务还没有会话", sentence "新建会话开始工作；同一个任务可以有多个会话。", primary "新建会话".
3. Provider invalid inside a session: amber inline banner at the top of the conversation
   "当前 Provider 凭据已失效", detail "请求没有发送，未产生用量。", action "前往 Provider 设置";
   composer remains visible with a disabled send button and an explanatory label.
No illustrations, no fake data, no green.
```

### S14 · 最小窗口 720×560（响应式检查）

```text
Adapt the S02 task workspace to the minimum desktop window 720×560, not a mobile layout.
Collapse the 264px sidebar into a top-left "菜单" button; keep the task title and a compact fact
strip (独立 worktree · atlas-api · 9f3c21a). Session tabs collapse to "会话 (3) ▾". Hide the
"任务详情" text button and move it into a ··· menu. Keep the conversation measure full width with
16px padding, the run bar visible, and the approval card readable. Composer keeps attach, @,
permission, model and send; move the model label into an overflow menu if needed. No horizontal
scrolling, no overlapping controls, no clipped Chinese labels.
```

---

## 5. 关键流程（用于 Stitch Flow / 连屏）

### F1 · 创建任务并准备 worktree

```text
Create a 5-step product flow for PiDock, same design system, desktop 1440×900:
1. 新建任务 · 基本信息: name, optional project (or 未归属任务), Provider/model, permission.
2. 选择来源: two Git repos and one plain directory; choose 独立 worktree for atlas-api, 使用已有目录
   for atlas-web, 共享目录 for design-tokens; show actual paths and fixed commits.
3. 确认并创建: review paths, branches, commits, workspace modes and the warning that shared
   directories affect original files.
4. 准备中: per-source progress rows (fetch → create worktree → verify), with a determinate progress
   line, not a spinner; a failed atlas-web row shows the reason and a 重试 action while successful
   sources stay prepared.
5. 打开任务: task workspace with a fresh session and a system line "独立的 worktree 已准备：atlas-api ·
   feat/settlement-paging · 9f3c21a".
Use the same shell, tokens and typography across all five screens; no service or environment steps.
```

### F2 · 会话生命周期

```text
Create a 4-screen flow: new session (empty), running with a tool result card, waiting for approval
with an inline approval card, and archived read-only session. Show session tabs at the top, a run
bar when active, and a clear "已归档 · 只读" state when archived. Keep the same task header and
composer location. Never show a green success state; use settled slate for completed.
```

### F3 · 定时执行与跳过

```text
Create a 3-screen flow: schedule editor → run history → skipped run record. The skipped record must
state "同一任务仍有执行未结束，本次触发已跳过" and link to the blocking session. Failure records
show the concrete provider/model/path error and offer "查看原因" / "继续对话", never a silent fallback.
```

### F4 · 归档与清理

```text
Create a 3-screen flow: archived task banner and 归档/清理 distinction → cleanup inventory with
uncommitted work warning and preserve/export choices → receipt showing preserved paths and removed
items. Use danger colour only for the warning and the final destructive button; show a per-item
result list, not a single "success" toast.
```

---

## 6. 迭代 Prompt（在已生成屏幕上修改）

```text
Refine the current screen without changing the design system or layout:
- Make the task facts (path, branch, commit, workspace mode) more legible: 12px JetBrains Mono,
  muted ink, separated by 6px, never truncated or moved into a tooltip.
- Reduce visual noise: remove any card shadows, gradients, extra borders, emoji or decorative icons;
  use 1px #E3E2DC rules and 8px spacing.
- Ensure only one primary ink-blue action is visible. Convert other actions to secondary or ghost.
- Add the state "等待确认" with a 6px amber dot and a pill, and keep the approval card inline.
- Make the empty area intentional: one icon, one sentence, one action. Do not fill it with fake data.
- Check the 720×560 window: no horizontal scrolling, no overlapping controls, no clipped Chinese text.
```

---

## 7. 禁止项（评审时逐条检查）

- 绿色（任何色相）、紫色 AI 渐变、玻璃拟态、霓虹光、3D 插画、emoji 图标。
- KPI 仪表盘、sparkline、环形图、「洞察」卡片、假成功率、假进度百分比。
- 服务、端口、环境模板、内置浏览器、终端、远程访问、移动端界面。
- 全圆角气泡聊天、每块内容都套卡片、卡片阴影堆叠。
- 把 Provider、模型、权限、路径、分支藏进无标签图标或 hover。
- 未接线能力显示为成功；未知值显示为 0；失败自动切换 Provider/模型。
- 删除会话时静默清空上下文；清理时删除来源仓库或普通目录。
- 「工作空间」作为层级名；「任务」与「会话」混用。

---

## 8. 设计评审清单

- [ ] 第一眼能看出项目 → 任务 → 会话的层级，且不出现顶层「工作空间」。
- [ ] 任务页能同时看到：实际路径、独立 worktree / 共享目录、分支、提交、会话状态。
- [ ] 新建任务明确区分「独立 worktree」与「使用已有工作目录」，并显示固定提交。
- [ ] 准备失败保留已成功来源，逐项重试；没有退回旧基线或静默认领目录。
- [ ] 运行中、等待确认、失败、已完成、停止、归档、过期都有文字状态，不只靠颜色。
- [ ] 审批卡展示操作、目标、内容、影响与过期时间；批准仅本次。
- [ ] 会话标签最多 4 个 + 全部会话；归档会话只读且有明确恢复入口。
- [ ] 定时任务用自然语言 + 时区 + 下次执行；跳过与失败有记录，不补跑。
- [ ] Provider 凭据遮蔽且只存本机；MCP 连接失败不展示伪工具；Skills 来源可见。
- [ ] 归档与清理分开；清理先显示未提交内容，默认保留副本，普通目录原文件不删除。
- [ ] 1440×900 与 720×560 都无溢出、无重叠、无横向滚动。
- [ ] 全屏无绿色、无渐变、无 emoji；字体/间距/圆角与 `DESIGN.md` 一致。

---

## 9. 与规格的映射

| 规格验收（#135） | 设计落点 |
| --- | --- |
| 项目、任务、会话持久层级 | S01 / S04 / S10；侧栏项目树 + 任务/会话标签 |
| 真实 Provider 对话、流式、停止、错误、继续 | S02 / S06 / S13；运行条、错误卡、Provider 状态 |
| 文件/命令工具与权限 | S02 工具卡 + 审批卡；S03 来源事实 |
| 已有目录 / 独立 worktree 双模式 | S03 / S04 / S08；模式 chip、固定提交、失败恢复 |
| 部分失败可恢复、不认领未知目录 | S08；逐来源状态与恢复规则 |
| 清理检查未提交、保留副本、不删原始目录 | S09；未提交警告与保留/导出/移除 |
| 定时任务、独立会话、跳过、记录 | S05 / F3；自然语言周期、执行记录、跳过原因 |
| Provider / MCP / Skills UI 管理 | S06 / S11 / S12；真实状态、来源、凭据边界 |
| 会话新建/续聊/停止/归档/恢复/删除 | S02 / S10 / F2；标签、运行条、只读归档 |
| 关注入口 | S01 / S07；待确认、失败、完成未读、跳过 |

**待业主确认的开放项：** 视觉方向是否采用 Quiet Ledger；侧栏是否保留项目树（当前方案保留）；任务详情用抽屉还是独立页（当前为抽屉）；是否接受「无绿色、完成用 slate」的状态语义；最小窗口 720×560 是否仍为首版目标。
