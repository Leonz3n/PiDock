# PiDock 设计文档与交付包

**状态：两套设计候选，待业主确认；不构成产品实现授权。** 范围与验收以 [#135](https://github.com/Leonz3n/PiDock/issues/135) 和 [父规格 #1](https://github.com/Leonz3n/PiDock/issues/1) 为准，评审与交接流程见 [#24](https://github.com/Leonz3n/PiDock/issues/24)。视觉方向、布局和交互在确认前均可调整；确认前不恢复产品实现工单。

本目录是 PiDock 设计材料、设计交付包与历史设计文档的**统一入口**。原根目录 `design/` 已整体迁移到这里；旧路径不再保留副本。

## 1. 先看什么

| 你要做的事 | 从这里开始 |
| --- | --- |
| 比较两套方向、确认选哪一套 | [DECISIONS.md](DECISIONS.md) |
| 用 Google Stitch 继续设计 | 选一套候选 → 它的 `DESIGN.md` → `STITCH-BRIEF.md` / `STITCH-PROMPTS.md` |
| 导入 Figma | [quiet-ledger/figma/README.md](quiet-ledger/figma/README.md) |
| 查产品不可变规则 | 本文 §3、[产品设计收口](../product-design-closure.md) |
| 查历史评审与原型 | [HISTORY.md](HISTORY.md) |
| 查实现层对照（不是设计稿） | [渲染层基线评审](../renderer-baseline-review.md) |

## 2. 两套候选

两套包**互不混用**：不要把 A 包的 token、导航、提示词或参考图拼到 B 包。选定一套后，该包成为唯一设计源；另一套归档为对照。

| | **Quiet Ledger** | **Stitch Apple** |
| --- | --- | --- |
| 目录 | [`quiet-ledger/`](quiet-ledger/README.md) | [`stitch-apple/`](stitch-apple/README.md) |
| 视觉语言 | 暖纸底 `#F7F7F4`、墨蓝 `#2B4ACB`、发丝分隔线、文字优先状态 | 冷灰白、亮蓝 `#2768DF`、扁平控件、较少装饰 |
| 设计系统 | `DESIGN.md`，22 色 / 12 字级 / 6 圆角 / 9 间距 / 28 组件 | `DESIGN.md`，23 色 / 7 字级 / 7 圆角 / 8 间距 / 24 组件 |
| Stitch 提示词 | `STITCH-BRIEF.md`：全局 + S01–S14 + 4 条流程 + 纠偏 | `STITCH-PROMPTS.md` + `SCREENS.md` + `FLOWS.md` |
| 参考图 | 11 张 SVG + 1440×900 PNG | 14 张 JPEG，大多 1440×860，04 为 1440×900 |
| Figma | 11 张 1440×900 SVG | 参考图为主，无独立 Figma 矢量稿 |
| Tokens | DTCG、Tailwind v4、Tailwind v3 | DTCG、Tailwind v4、Tailwind v3 |
| 校验 | lint 0 error / 2 个预期透明背景警告；SVG 均通过 `xmllint` | lint 0 error / 0 warning / 1 info；14 图与 ZIP 已校验 |
| 适合 | 需要更强“台账/审计”气质、强调 worktree 事实与收尾状态 | 需要更接近 Apple 桌面工具、密度更高、窄窗口验证更完整 |

两套都遵守同一组硬约束：

- 项目 → 任务 → 会话；不新增「工作空间」顶层。
- 已有目录与独立 worktree 都是首版必做；任务事实（模式、路径、分支、提交）必须常驻可见，不能藏在 hover 里。
- 定时任务、Provider / MCP / Skills、会话生命周期、归档与清理都在首版内。
- **任何界面不使用绿色**；完成/成功用 slate `#2F4858`，运行中用蓝色，关注用琥珀，危险用红。
- 桌面优先：按 1440×900 设计，并验证 720×560 最小窗口。
- 不加渐变、毛玻璃、emoji 图标、常驻右侧大详情栏；路径/分支/提交用等宽字体。
- 不做服务编排、环境模板、内置浏览器、内置终端、远程访问、复杂用量报表、文件/差异工作台。

## 3. 产品规则的权威顺序

1. GitHub Issue [#135](https://github.com/Leonz3n/PiDock/issues/135) / [#1](https://github.com/Leonz3n/PiDock/issues/1) 的最新正文与评论。
2. [产品设计收口](../product-design-closure.md) 与 [首版规格](../mvp-spec.md)。
3. 选定候选包的 `DESIGN.md` / `SCREENS.md` / `FLOWS.md`。
4. 参考图与原型只用于版式和交互讨论，**不是**运行结果或验收证据。

规则改变时回到 Issue 核对，不用设计文档反向覆盖产品规格。术语见根目录 [GLOSSARY.md](../../GLOSSARY.md)；技术边界见 [implementation-stack-design.md](../implementation-stack-design.md)。

## 4. 目录

```text
docs/design/
├── README.md                  # 本文件：统一入口
├── DECISIONS.md               # 两套对照、共享约束、未决事项
├── HISTORY.md                 # 历史设计记录、原型、证据的索引
├── pidock-stitch-apple-2026-11-02.zip
├── quiet-ledger/
│   ├── README.md              # 候选说明、文件表、复验命令
│   ├── DESIGN.md              # 设计系统源文件
│   ├── STITCH-BRIEF.md        # 全局/逐屏/流程提示词
│   ├── reference/             # 11 张 PNG + 同版 SVG
│   ├── figma/                 # 11 张可导入 SVG
│   ├── tokens/                # DTCG / Tailwind v4 / Tailwind v3
│   └── tools/                 # 参考图生成与渲染脚本
└── stitch-apple/
    ├── README.md              # 候选说明与使用步骤
    ├── DESIGN.md              # 设计系统源文件
    ├── STITCH-PROMPTS.md      # 全局/逐屏/纠偏提示词
    ├── SCREENS.md / FLOWS.md  # 画板清单与流程
    ├── CHECKLIST.md           # 评审清单
    ├── VALIDATION.md          # 本包校验记录
    ├── SOURCES.md             # 规格来源与主动修正
    ├── reference/             # 14 张 JPEG
    ├── tokens/                # DTCG / Tailwind v4 / Tailwind v3
    └── tools/                 # 字体归一与重新打包脚本
```

历史文档仍保留在 `docs/` 与 `prototypes/` 原位置，避免破坏既有 Issue、证据日志和 ADR 的链接；入口见 [HISTORY.md](HISTORY.md)。

## 5. 推荐使用流程

1. 先读 [DECISIONS.md](DECISIONS.md)，在两套方向中选定一套，或在 #24 记录明确修改意见。
2. Stitch：先上传/粘贴该包的 `DESIGN.md`，再粘贴全局提示词；之后**一次只发一个页面**，附该页参考图。
3. Figma：Quiet Ledger 直接导入 `figma/*.svg`；Apple 以 JPEG 为版式参照，按 `DESIGN.md` 在 Figma 重建变量与组件。
4. 按该包的 `CHECKLIST.md`（Apple）或 `STITCH-BRIEF.md` 评审清单（Quiet Ledger）逐项检查。
5. 把确认结果写回 #24 / #135；选定包转为正式设计基线，另一套标记为归档候选。
6. 设计确认后才安排产品实现。

## 6. 当前未决

完整对照与 D1–D8 见 [DECISIONS.md §5](DECISIONS.md#5-未决事项)；其中 **D1 视觉方向** 是继续设计前必须先确认的一项。不要在多个 README 里各维护一份状态表。

## 7. 验证与边界

- 两套包的 lint、导出、图片尺寸和 ZIP 校验结果分别见各自 `README.md` / `VALIDATION.md`；这些只证明**文件格式**，不证明产品验收。
- 参考图中的任务名、路径、分支、提交、计数和状态均为虚构版式数据，不是真实运行结果，也不含用户本机路径或凭据。
- 本次整理只移动文件、补统一入口和链接，没有修改设计 token、图片内容、产品源码或 GitHub Issue。
