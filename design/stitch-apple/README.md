# PiDock · Google Stitch 设计交接包

基于 2026-11-02 最新首版规则与本轮 **Apple A 版初稿**。状态为待继续设计、待用户评审；不是产品实现授权。视觉目标是简洁、扁平、偏 Apple 的灰白桌面工具。

本包独立于上级目录的 Quiet Ledger 暖纸色候选；只把本目录内材料作为同一套输入，不混用两套配色、导航或提示词。A 是推荐的继续设计起点，不代表用户已完成验收。B 只作可选结构比较。

## 最快使用

1. 解压同级的 `pidock-stitch-apple-2026-11-02.zip`，进入 `stitch-apple/`。
2. 在 Google Stitch 中开始一个桌面应用设计。先提供 **DESIGN.md**，再粘贴 **STITCH-PROMPTS.md → 0 · 全局提示词**。
3. 第一轮只附 `reference/01-task.jpg`，请求 S01。随后优先 S02 任务信息、S04 新建任务、S13 小窗口，确定共同设计语言后再扩展剩余页面。
4. 每次只发一个页面提示词及它的参考图；必要时再给 SCREENS.md / FLOWS.md 的对应段落。若当前 Stitch 不能读取 Markdown，就粘贴相关内容；本包不依赖某个专用导入接口。
5. 要求返回逐屏画板与共用组件状态，检查 CHECKLIST.md。确认设计后再另行安排正式实现。

本次只生成本地交接文件，没有向 Google 上传项目、源码、截图或凭据。

## 文件

| 文件 | 用途 |
| --- | --- |
| [DESIGN.md](DESIGN.md) | 设计系统：YAML tokens + 视觉语言、布局、组件和固定产品边界；可单独交给设计工具 |
| [STITCH-PROMPTS.md](STITCH-PROMPTS.md) | 全局、逐屏与纠偏提示词，按段复制使用 |
| [SCREENS.md](SCREENS.md) | S01–S14 页面清单、状态、画板尺寸与交付顺序 |
| [FLOWS.md](FLOWS.md) | 创建、执行/审批、会话生命周期、定时、配置、任务清理流程 |
| [CHECKLIST.md](CHECKLIST.md) | 用于审阅 Stitch 输出的产品和视觉检查项 |
| [SOURCES.md](SOURCES.md) | 规格优先级、核对日期、初稿来源与已知差距 |
| `reference/*.jpg` | 由本轮可交互初稿采集的参考图，均为虚构示例 |
| [reference/README.md](reference/README.md) | 参考图说明与截图中不要复制的元素 |
| `tokens/design_tokens.json` | 从 DESIGN.md 导出的 DTCG token 数据 |
| `tokens/theme.css` | 从 DESIGN.md 导出的 Tailwind v4 theme |
| `tokens/tailwind.theme.json` | 从 DESIGN.md 导出的 Tailwind v3 theme.extend |
| [VALIDATION.md](VALIDATION.md) | 实际格式/引用/图片/压缩包检查记录，不代表产品验收 |
| `tools/normalize-tokens.py` | 修正 CLI 导出的字体回退列表 |
| `tools/package.py` | 用标准 Python 重新打包并生成文件清单；不访问网络 |
| `MANIFEST.json` | 包内文件大小与 SHA-256，及来源说明 |

## 首版规则与可改设计

**固定规则：** 项目 → 任务 → 会话；已有目录和独立 worktree 均必做；普通目录共享原文件；Provider/MCP/Skills；定时每次独立会话；会话删除、任务归档与任务清理分别表达；不删除原始目录。所有产品界面不使用绿色。

**设计建议：** A 的两栏结构、具体 tokens、字级、圆角、详情宽度、对话框/抽屉形态。Stitch 可改善，但要说明偏离初稿的理由。建议把初稿很小的元信息提高到可读的 12px，不照搬低对比度文字。

**延后或撤销：** 终端、浏览器、服务编排、环境模板、端口/协议绑定、独立文件/Diff 工作台、复杂用量报表、Packages/Extensions 市场、远程与移动端。不要从旧 Apple 全功能原型或上级设计包恢复这些入口。

## 参考图与可交互原型

本轮原型：<http://127.0.0.1:4319/mvp-review.html?variant=A>。它只在当前电脑运行；Stitch 无法通过这个地址访问你的电脑。交给 Stitch 的是本包里的图与文档。

参考图一般为 1440×900 视口裁去底部 40px 评审栏后的 **1440×860**，窄图为 720×560 裁去 36px 后的 **720×524**。04 新建任务图为保留完整底部操作使用 **1440×900**，其背景模糊评审栏不属于产品。目标设计仍为 **1440×900 与 720×560**，不要把裁剪高度当作产品窗口尺寸。截图显示的内容、报告、状态、路径、模型和数字全是演示。调试控件也仅属于原型。

原型启动（需在原仓库根目录）：

```sh
python3 -m http.server 4319 --bind 127.0.0.1 --directory prototypes/pidock-ui
```

交接压缩包不包含仓库、生产源码或原型脚本，打开文档与图片即可用于设计。

## 维护和打包

DESIGN.md 是本包设计 token 的编辑源。可使用 Google 的 DESIGN.md CLI 重新检查/导出（首次 `npx` 会下载对应工具）：

```sh
npx @google/design.md@0.4.0 lint DESIGN.md
npx @google/design.md@0.4.0 export --format dtcg DESIGN.md > tokens/design_tokens.json
npx @google/design.md@0.4.0 export --format css-tailwind DESIGN.md > tokens/theme.css
npx @google/design.md@0.4.0 export --format json-tailwind DESIGN.md > tokens/tailwind.theme.json
python3 tools/normalize-tokens.py
python3 tools/package.py
```

CLI 导出的字体值如包含逗号，应保留为 CSS 字体列表；Tailwind JSON 中应为字体数组，不把整个字体列表当成一个字体名。修改后同步文档、截图索引和验证记录。压缩包位于本目录的父目录，内部只有 `stitch-apple/`。
