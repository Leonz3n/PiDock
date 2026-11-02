# 来源、优先级与边界

核对日期：2026-11-02（Asia/Shanghai）。本包是设计交接资料，不是第二份工单 tracker。

## 权威规则

| 来源 | 用途 | 本次核对 |
| --- | --- | --- |
| [首版收口 #135](https://github.com/Leonz3n/PiDock/issues/135) | 当前首版范围和验收入口；worktree 必做，设计确认后才产品实现 | 完整正文与评论；updatedAt 2026-11-02T07:09:32Z；原生 blocked-by 为空 |
| [父规格 #1](https://github.com/Leonz3n/PiDock/issues/1) | 最新顶部范围覆盖冲突的历史快照 | 同会话已读完整正文/评论，本次复核最新顶部与当日评论；updatedAt 2026-11-02T07:09:37Z |
| [UI 交接 #24](https://github.com/Leonz3n/PiDock/issues/24) | 旧 A 不是必须复刻视觉目标，先设计再确认实现 | 本会话已读正文/评论，本次复核最新执行控制；updatedAt 2026-11-02T07:09:34Z；blocked-by 为空 |
| [终端撤销 #95](https://github.com/Leonz3n/PiDock/issues/95) | 不提供桌面内置终端入口 | 同会话已读；#135 继续确认撤销 |
| 仓库根 GLOSSARY.md | 项目/任务/会话、来源和工作区语义 | 已读；本包只抽取所需设计术语 |
| docs/adr/0001-local-project-registry.md | 稳定身份、不从路径/名称猜归属 | 同会话已读 |
| 用户本轮要求 | 根据规则和初稿，生成供 Google Stitch 进一步设计的 DESIGN.md 等文件 | 本轮直接授权；未要求上传到 Google、修改生产代码或验收工单 |

后续规则改变时回到 GitHub 核对，不用设计文档反向覆盖产品规格。其他未完成生产工单继续暂停。

## 初稿与视觉参考

- `prototypes/pidock-ui/mvp-review.html?variant=A`：本轮 Apple 侧栏默认候选；浅灰侧栏、对话优先、按需任务信息。
- 同路由 `variant=B`：扁平图标栏 + 项目任务分栏，仅比较用。
- `prototypes/pidock-ui/MVP-REVIEW.md`：本轮范围、交互与验证边界。
- `mvp-review.css / mvp-review.js`：参考颜色、尺寸和内存交互；不是生产复用组件。
- `reference/*.jpg`：本次在独立原型页通过浏览器采集，虚构项目、路径、模型、报告和状态，不包含用户本机目录内容或真实凭据。

路径以上游仓库根为基准；打包后原仓库文件不在包中，Stitch 使用图和本包文字即可。

## 设计系统格式

使用 Google [DESIGN.md 格式](https://github.com/google-labs-code/design.md)：机器可读 YAML front matter + Markdown 设计说明。结构依据本机已有 `@google/design.md` **0.4.0** 包的 README/schema，实际运行该版本 linter/exporter；不是宣称 Google Stitch 具备某个未验证的导入按钮或一键原生绑定。

如果 Stitch 当前版本不能接收 Markdown 文件，按 README 把全局提示词与相关章节粘贴即可。tokens 的导出格式和截图尺寸由本包实际校验，不以工具文案代替结果。

## 主动修正初稿的部分

| 初稿情况 | 交给 Stitch 的处理 |
| --- | --- |
| 许多 9–11px 的浅灰元信息 | 提高必要文字到约 12px、提升对比度；保留视觉轻盈 |
| 任务头只显示“独立 worktree” | 混合来源时改为逐来源数量/事实，避免全部隔离暗示 |
| 模型选择器可能只见模型名 | 同名模型需区分 Provider profile |
| 凭据字段禁用，MCP 调用/流式回复未真实展开 | 设计正式交互与失败状态；不宣称已经接线 |
| 模拟准备/命令/测试/调度状态 | 提供真实状态所需的 UI，移除模拟切换器 |
| 截图含演示事实、程序性提示 | 当作排版数据，绝不当作真实验证；产品无评审底栏 |

## 不是本包做出的决定

A 版推荐起点不等于用户最终验收；视觉 tokens、具体宽度/断点、状态卡形态、默认规则暂停可继续优化。没有新建全局关注中心、复杂导出工具、团队/账单、账户系统、移动端或云端产品能力。没有修改既有 Quiet Ledger 包，没有升级依赖或恢复工单。
