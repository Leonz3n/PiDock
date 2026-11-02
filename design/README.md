# PiDock 设计交付包

面向 **Google Stitch** 的 UI 设计输入，以及可导入 **Figma** 的参考稿。

**状态：设计候选，待业主确认。** 本目录不构成产品实现授权。范围与验收以 [GitHub #135](https://github.com/Leonz3n/PiDock/issues/135) 和 [父规格 #1](https://github.com/Leonz3n/PiDock/issues/1) 为准；视觉方向、布局与交互在确认前均可调整。

> 本目录同时保留两套互不混用的候选：根目录为 **Quiet Ledger**（暖纸 + 墨蓝），[`stitch-apple/`](stitch-apple/README.md) 为 **Apple 风格**（冷灰白 + 亮蓝）。两套均待评审，业主尚未确认采用哪一套。

- **视觉方向：** Quiet Ledger（安静台账）——暖纸底、墨蓝强调、发丝分隔线、文字优先的状态，不使用绿色。
- **层级：** 项目 → 任务 → 会话；不增加「工作空间」顶层。
- **首版范围：** 已有目录与独立 worktree、定时任务、Provider/MCP/Skills、会话生命周期、归档与清理。
- **明确不含：** 服务编排、环境模板、内置浏览器、内置终端、远程访问、复杂用量报表。
- **示例数据：** 参考图中的任务、路径、分支、提交、计数与状态均为版式示例，不代表真实运行结果。

---

## 1. 文件

| 路径 | 用途 |
| --- | --- |
| `DESIGN.md` | **唯一设计系统源文件**。符合 [google-labs-code/design.md](https://github.com/google-labs-code/design.md) 格式，可直接绑定 Stitch 或交给实现方。 |
| `STITCH-BRIEF.md` | 全局 Prompt、S01–S14 单屏 Prompt、关键流程、迭代 Prompt、禁止项与评审清单。 |
| `reference/*.png` | 11 张 1440×900 参考图，**附加给 Stitch**。 |
| `reference/*.svg` | 同版矢量源文件，可导入 Figma 或浏览器查看。 |
| `figma/*.svg` | 供 Figma 导入的副本；见 `figma/README.md`。 |
| `tokens/design_tokens.json` | W3C DTCG 格式 token，可由 Tokens Studio / 其他工具导入。 |
| `tokens/theme.css` | Tailwind v4 `@theme` 变量。 |
| `tokens/tailwind.theme.json` | Tailwind v3 `theme.extend` 片段。 |
| `tools/build-reference.mjs` | 参考图生成器（纯 SVG，无外部依赖）。 |
| `tools/render-reference.sh` | 用 headless Chromium 将 SVG 渲染为 1440×900 PNG。 |

## 2. 在 Google Stitch 中使用

1. 打开 Stitch，新建 **Desktop / Web** 项目，语言选简体中文。
2. 设计系统：
   - 若当前工作区支持绑定 `DESIGN.md`，直接绑定本文件；
   - 否则把 `STITCH-BRIEF.md` 的「全局 Prompt」作为第一条消息，并选择不使用预设主题。
3. 按 S01–S12 逐屏发送 Prompt，并附上对应的 `reference/*.png`。参考图用于版式密度，不要求逐像素复刻。
4. 使用「迭代 Prompt」修正，不要重开项目。最后按禁止项与评审清单检查。
5. 方向确认后再进入实现；确认记录应回写到 #24 / #135。

## 3. 在 Figma 中使用

1. 新建 Figma 文件，安装 Google Fonts：**Inter**、**Noto Sans SC**、**JetBrains Mono**。
2. 将 `figma/*.svg` 逐张拖入（或 File → Place image）。每张为 1440×900。
3. 导入后如成为 Group，选中后 `⌘⌥G` / `Ctrl+Alt+G` 建立 Frame，设为 1440×900；启用 Clip content。
4. 参考稿不含 Auto layout / Variables。实现阶段按 `tokens/design_tokens.json` 建变量，并按 `DESIGN.md` 重建组件（按钮、状态 pill、列表行、Composer、审批卡、侧栏、表格行）。
5. SVG 是视觉规格，不是生产组件；不要把参考稿直接当作交付代码或组件库。

## 4. 校验与再生成

```bash
# 设计系统格式与对比度（0 error；2 个透明背景对比度警告为预期）
cd design
npx -y @google/design.md lint DESIGN.md

# 重新导出 tokens
npx -y @google/design.md export --format dtcg DESIGN.md > tokens/design_tokens.json
npx -y @google/design.md export --format css-tailwind DESIGN.md > tokens/theme.css
npx -y @google/design.md export --format json-tailwind DESIGN.md > tokens/tailwind.theme.json
# 注意：CLI 会把 fontFamily 导出为含逗号的单个字符串。本目录的 theme.css 与
# tailwind.theme.json 已分别规范化为 CSS 字体列表和 Tailwind 数组；重导出后需重复这一步。

# 重新生成 SVG 与 1440×900 PNG
node tools/build-reference.mjs
./tools/render-reference.sh   # 可用 CHROME=/path/to/chrome-headless-shell 覆盖

# 同步 Figma 用副本
cp reference/*.svg figma/
```

要求 Node 22+ 与 Chromium headless shell。渲染脚本默认查找 Playwright 的
`chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell`。

## 5. 关键设计决策

- **暖纸 + 墨蓝，不用绿色。** 完成态用 slate（`#2F4858`），运行态用墨蓝，等待用琥珀，失败用砖红。
- **两栏工作区，不常驻右栏。** 任务详情按需打开 360px 抽屉；1180px 以下变为遮罩抽屉，不挤压对话。
- **任务事实始终可见。** 路径、分支、提交、`独立 worktree` / `共享目录` 用 mono 呈现，不能藏在 hover 里。
- **一个对话一次。** 任务内会话用顶部标签（最多 4 个 + 全部会话），不做多栏并排。
- **状态是一句话。** 每个状态都有中文词 + 可选 6px 圆点；颜色只做强化。
- **清理是危险流程。** 未提交内容先警告，默认保留 worktree 副本，普通目录原文件永不删除。
- **诚实状态。** `未接线`、`未知`、`失败` 与 `已完成` 明确区分，不伪造样例数据或成功。

## 6. 待确认事项

1. 是否采用 Quiet Ledger 作为新一轮视觉方向。
2. 侧栏是否保留项目树（当前方案保留，任务页展开当前项目）。
3. 任务详情使用抽屉还是独立页（当前为抽屉）。
4. 「无绿色、完成用 slate」的状态语义是否接受。
5. 最小窗口 720×560 是否仍作为首版验收尺寸。

## 7. 设计系统说明

`DESIGN.md` 包含 22 个颜色、12 个字体层级、6 个圆角、9 个间距、28 个组件 token。
Lint 的两条警告来自 `button-ghost` 与 `list-row` 的透明背景：它们实际绘制在
`canvas` / `surface` 上，对比度按真实表面计算通过，属于预期的静态检查限制。

字体在 Stitch / Figma 中使用 Google Fonts 的 Inter、Noto Sans SC、JetBrains Mono；
中文回退 PingFang SC / Microsoft YaHei。参考图在 macOS 上以 PingFang SC 渲染，
字形与 Noto Sans SC 略有差异，不影响版式判断。

## 8. 来源

- 范围与验收：[#135](https://github.com/Leonz3n/PiDock/issues/135)、[#1](https://github.com/Leonz3n/PiDock/issues/1)
- UI 交接：[#24](https://github.com/Leonz3n/PiDock/issues/24)
- 术语：[GLOSSARY.md](../GLOSSARY.md)
- 收口规则：[docs/product-design-closure.md](../docs/product-design-closure.md)
- 技术边界：[docs/implementation-stack-design.md](../docs/implementation-stack-design.md)
- DESIGN.md 格式：[google-labs-code/design.md](https://github.com/google-labs-code/design.md)
