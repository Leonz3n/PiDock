# Figma 导入说明

`docs/design/quiet-ledger/figma/*.svg` 是与 Stitch 参考图同版的矢量稿，画布均为 **1440 × 900**。它们用于把版式、密度、颜色与组件状态带进 Figma，不是最终组件库。

## 导入步骤

1. 安装字体：**Inter**、**Noto Sans SC**、**JetBrains Mono**（Google Fonts）。
2. 新建 Figma 文件，建议按流程建 Page：
   - `00 Foundations`（颜色、字体、间距、圆角）
   - `01 Workbench / Project`
   - `02 Task workspace`
   - `03 New task & Recovery`
   - `04 Schedules`
   - `05 Capabilities`
   - `06 Attention / Archive / Cleanup`
3. 逐张拖入 SVG（或 File → Place image）。不要一次全选导入到同一 Frame。
4. 若导入结果是 Group：选中 → `⌘⌥G`（Windows `Ctrl+Alt+G`）→ 命名 → 尺寸设为 `1440 × 900` → 勾选 Clip content。
5. 打开 `DESIGN.md` 对照校色；颜色与文字样式应来自 token，而不是取色器临时值。

## 从参考稿到组件

参考稿刻意不带 Auto layout 和 Variables。实现/高保真阶段按以下顺序重建：

1. **Variables**：用 `../tokens/design_tokens.json`（DTCG）或 `../tokens/theme.css` 建颜色、间距、圆角变量。Tokens Studio 可直接导入 DTCG JSON。
2. **Text styles**：display 30/38、title-lg 24/32、title-md 20/28、title-sm 16/24、body 14/22、meta 12/18、label 12/16、mono 12/18。
3. **基础组件**：
   - Button（primary / secondary / ghost / danger；32px 高，8px 圆角）
   - Input / Select / Textarea（34px 高，8px 圆角，focus 2px `#4E6BE0`）
   - Status pill（running / attention / danger / settled / outline；24px 高）
   - List row（44px，悬停 `#EFEFEA`，选中 `#E9EEFC`）
   - Session tab（32px，active 白底 + 1px 边）
   - Composer（14px 圆角，参考 `02-task-workspace`）
   - Approval card（3px 琥珀左边、琥珀表头、批准/拒绝）
   - Sidebar / Project row / Table row
4. **页面模板**：用 Auto layout 重建 264px 侧栏 + 主列 + 可选 360px 抽屉；主列内容宽 1040，对话列 760。

## 注意事项

- **没有绿色。** 完成/成功用 `settled` slate（`#2F4858` / `#E8EDF0`），不要用 Figma 默认绿色。
- 阴影只用于抽屉、弹窗、菜单；卡片用 1px `#E3E2DC` 边框。
- 参考稿中的中文路径/分支/提交是示例；实现时替换为真实数据，并保留 mono 字体。
- SVG 文本层在缺少字体时可能被轮廓化；导入后检查文字是否仍可编辑，必要时重新设置字体。
- 不要把 11 张稿拼成一张长图；一屏一 Frame 才能对照 1440×900 与 720×560 的降级。
- 最小窗口检查：720×560 下侧栏收起、会话标签折叠为下拉、无横向滚动。

## 文件对照

| SVG | 界面 |
| --- | --- |
| `01-workbench.svg` | 工作台 |
| `02-task-workspace.svg` | 任务工作区（执行中 + 审批） |
| `03-new-task.svg` | 新建任务 · 来源（worktree / 已有目录） |
| `04-project.svg` | 项目总览 |
| `05-schedules.svg` | 定时任务（列表 + 编辑器） |
| `06-capabilities.svg` | Provider 设置 |
| `07-attention.svg` | 需要处理 |
| `08-recovery.svg` | 准备失败恢复 |
| `09-cleanup.svg` | 归档任务清理 |
| `10-sessions.svg` | 全部会话抽屉 |
| `11-mcp.svg` | MCP 设置 |
