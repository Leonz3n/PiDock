# Research: 市面是否存在与 PiDock「项目-任务-对话」层级类似的 Desktop Agent 产品？

调查日期：2026-09-23。Scope：验证 PiDock「Project（可复用多仓库/目录/服务/环境集合）→ Task（跨多仓库目标工作，可并行）→ Task Workspace（单任务代码副本+运行状态）→ Agent Session（围绕任务的一段对话+执行上下文）→ Scheduled Task / Scheduled Run（固定工作区＋每次独立会话）」三元组在市面 Desktop Agent 产品中是否已存在一等实现。
Methods（含 live fetch 声明）：本轮执行了 live primary-source 抓取——官方 docs（Anthropic、Cursor、Zed、GitHub Docs、LangChain、Cline、Aider）、官方 GitHub 源码 raw（JetBrains/thinkrail architecture.md、domain.ts、workspaces/SPEC.md、goal-and-requirements.md；RooCode Task.ts）、GitHub Releases API（thinkrail latest + per_page=10）。developers.openai.com Codex 页面两次 fetch 返回 HTTP 403，仅能用 web_search 摘要作 discovery aid，不作直接证据。source_check 对 ThinkRail 核心主张调用一次（status unclear，人工复核原文后采用）。每条事实主张带 inline [S#]（URL＋版本/commit）；区分 源码/文档证明 vs 未证明需实测 vs 结构性差异。

## Summary

一手来源验证结论：未发现任何产品实现与 PiDock 定义一等的 Project（多仓库集合）＋Task（跨仓并行）＋Session/Run（固定工作区/每次独立会话）三元组。JetBrains ThinkRail 已用源码+规格+Release API 重验，确认为 project＝单个 Git repo → workspace＝单个 git worktree → chats，与 PiDock 存在结构性差异；V2（remote/automations）截至 2026-09-22 仍为 nightly 预发布，未稳定交付。Zed 的 multi-root project＋按 project 分组 threads 是本轮最接近 PiDock Project→Session 的一端，但仍无 Task 抽象层。Claude Code Desktop 的 scheduled task→fresh session 机制最接近 PiDock Scheduled Run，但其余层级仍不对齐。新颖性主张：部分成立（partial），建议 continue（保留分层设计，收缩验证优先级）。

## Findings

### F1. PiDock 基准（本地权威定义，直接证据，高置信度）

1. **Claim:** PiDock Project＝业务系统的可复用仓库、普通目录、服务和环境集合（非单个 repo、非一次任务）；Task＝跨多仓库/目录、可并行的目标工作；Task Workspace＝单任务代码副本＋运行状态（普通目录可共享原件）；Environment＝命名运行配置＋远程依赖选择；Agent Session＝围绕任务的一段对话＋执行上下文；Scheduled Task 拥有固定工作区并按规则建会话，Scheduled Run 关联当次新会话、不继承上下文但共享工作区。**Sources:** 本地 CONTEXT.md。**Support:** direct evidence（本地原文转述）。**Confidence:** high。researcher inference：以下所有比对均以此为准绳。

### F2. JetBrains ThinkRail —— 部分相似（源码/文档证明，高置信度）

1. **Claim:** ThinkRail V1 自定义为 Worktree IDE：open a git repo as a project，workspaces 为 git worktree（each its own branch and cwd），多个并发 pi chat sessions 全部 scoped to the active worktree。**Sources:** [S1](https://github.com/JetBrains/thinkrail/blob/main/README.md)（main，live fetch 2026-09-23）。**Support:** direct evidence（README 原文）。**Confidence:** high。
2. **Claim:** 领域模型源码层面：Project 只有单一 path（id/name/path/slug…），Workspace 只有单一 projectId＋branch＋worktreePath＋baseBranch（＋kind default|external）。**Sources:** [S2](https://raw.githubusercontent.com/JetBrains/thinkrail/main/packages/contracts/src/domain.ts)（main raw，live fetch 2026-09-23，未 pin commit）。**Support:** direct evidence（源码原文）。**Confidence:** high。
3. **Claim:** workspace 语义＝own branch 下的 git worktree；每个 project 有且仅有一个内建 Default workspace（worktreePath 即 project folder 本身，不可删/改名）；用户附加的既有 worktree 记为 kind external，原位使用不改 checkout。**Sources:** [S3](https://raw.githubusercontent.com/JetBrains/thinkrail/main/packages/server/src/workspaces/SPEC.md)（main raw，live fetch）。**Support:** direct evidence。**Confidence:** high。
4. **Claim:** 顶层架构与产品规格确认 project (git repo) → workspace (git worktree) → chats/files/terminals；V2 范围为 workflow layer、spec layer、self-improvement、configurable automations、remote/phone over Tailscale、cost ledger／per-step routing。**Sources:** [S6](https://github.com/JetBrains/thinkrail/blob/main/architecture.md)、[S4](https://raw.githubusercontent.com/JetBrains/thinkrail/main/goal-and-requirements.md)（main，live fetch）。**Support:** direct evidence。**Confidence:** high。
5. **Claim:** 自 2026-09-21 以来 remote/automations V2 未稳定交付：latest 仍为 v0.1.2（tag commit 282f5a1ab8adf47af081ae10a2b2a8fd1f2afb6d）；最新发布为 v0.2.0-nightly.8（published_at 2026-09-22T05:57:18Z，prerelease=true，target commit adda755df6f9ae8d6bc635e573a7e812bea4d06c，body 仅 themed macOS title bar）。**Sources:** [S5](https://api.github.com/repos/JetBrains/thinkrail/releases/latest)＋releases?per_page=10（live fetch）。**Support:** direct evidence（API 元数据）。**Confidence:** high。
6. **Verdict（ThinkRail）：部分相似。** 结构性差异（源码证明）：无"一任务多仓库成员归属＋追加/回收"语义；无 Environment/Shared Template/Task Override 服务编排模型；chat 会话归属 workspace 而非 PiDock 式 Task。未证明需实测：多 workspace 手工协作成本、外部工具补齐服务配方的可行性。

### F3. Anthropic Claude Code（含 Desktop）—— 部分相似（文档证明，高置信度）

1. **Claim:** session＝tied to a project directory 的 saved conversation；支持 resume/branch/switch；transcripts 存于 ~/.claude/projects/。**Sources:** [S7](https://code.claude.com/docs/en/sessions)（官方 docs，live fetch 2026-09-23）。**Support:** direct evidence。**Confidence:** high。
2. **Claim:** 并行隔离靠 git worktree（--worktree 在 .claude/worktrees/ 下建独立 checkout＋分支）；subagents 是 one session 内的分工，cross-session messaging 在 worktree sessions 间传 findings。**Sources:** [S8](https://code.claude.com/docs/en/worktrees)（官方 docs，live fetch）。**Support:** direct evidence。**Confidence:** high。
3. **Claim:** Desktop scheduled tasks 每次触发 start a fresh session（independent of manual sessions），本地任务需 app 打开＋机器唤醒，Routines 页同时支持云端 remote routines。**Sources:** [S9](https://code.claude.com/docs/en/desktop-scheduled-tasks)（官方 docs，live fetch）。**Support:** direct evidence。**Confidence:** high。researcher inference：这是本轮唯一与 PiDock Scheduled Run（固定工作区＋每次新会话）机制级相似的原生设计，但 Claude 的 task 无固定多仓工作区语义，project≈directory。
4. **Claim:** Desktop 宣传 parallel sessions with Git isolation、each conversation is a session（own chat history/project folder/code changes）。**Sources:** [S10](https://code.claude.com/docs/en/desktop)（官方 docs；本轮直接 fetch 失败，系 web_search 摘要 discovery，未作直接证据）。**Support:** interpretation。**Confidence:** medium。
5. **Verdict（Claude Code）：部分相似。** 原生术语 session/project directory/worktree/thread 均存在，并行＋定时触发→新会话两项机制各自相似，但无 PiDock 式 Project（多仓集合）＋Task（跨仓并行容器）层。

### F4. OpenAI Codex —— 部分相似（未达直接证据门槛，中置信度）

1. **Claim:** Codex app 的 worktrees 让"multiple independent tasks in the same project"互不干扰；automations 跑在 dedicated background worktrees；可手动在 worktree 上 start threads，用 Handoff 在 Local↔Worktree 间移动 thread。**Sources:** [S11](https://developers.openai.com/codex/app/worktrees)（官方 docs；本轮 fetch 两次 HTTP 403，仅 web_search 摘要，属 discovery aid）。**Support:** interpretation。**Confidence:** medium。
2. **Verdict（Codex）：部分相似（未验证完全）。** 可见 project/task/thread/worktree 四词共存且语义接近"任务隔离"，但因 403 未能抓取原文确认 project 是否支持多仓库、task 是否为一等容器。不得作为强结论引用，需后续换通道重抓。

### F5. Cursor —— 部分相似（文档证明，高置信度）

1. **Claim:** Worktrees let Agent work in isolated Git checkouts；Each task gets its own files/dependencies/changes；支持 .cursor/worktrees.json setup 脚本、/worktree 单次隔离运行、/best-of-n 多模型各跑各 worktree。**Sources:** [S12](https://cursor.com/docs/configuration/worktrees)（官方 docs，live fetch）。**Support:** direct evidence。**Confidence:** high。
2. **Claim:** Cloud Agents 运行于 isolated VMs（cloned repos＋deps＋secrets＋startup commands），与本地 worktree 隔离属两条线。**Sources:** [S13](https://cursor.com/docs/cloud-agent)（官方 docs，search 摘要级）。**Support:** interpretation。**Confidence:** medium。
3. **Verdict（Cursor）：部分相似。** task≈一次隔离运行＋worktree 隔离edisposable，project 仍为单 repo checkout 语义；无多仓 Task 容器、无 Environment/服务编排、无定时→新会话语义。

### F6. Cline / Roo Code —— 部分相似（文档＋源码证明，高置信度）

1. **Claim（Cline）:** Every interaction happens within a task；task＝self-contained work session（conversation＋code changes＋command executions＋decisions），有唯一 ID、独立存储目录、token/cost 追踪，可中断恢复，checkpoints 快照。**Sources:** [S14](https://docs.cline.bot/core-workflows/task-management)（官方 docs，live fetch）。**Support:** direct evidence。**Confidence:** high。researcher inference：Cline 的 task 实为 PiDock Session＋Workspace 混合物（task＝conversation＋work unit），且无上层 Project。
2. **Claim（Roo Code）:** 源码 class Task 含 taskId/rootTaskId/parentTaskId/childTaskId/taskNumber/workspacePath/mode（Code/Architect/Ask/Debug…），支持父子任务与 sub-tasks。**Sources:** [S15](https://github.com/RooCodeInc/Roo-Code/blob/main/src/core/task/Task.ts)（官方 repo main raw 169KB，live fetch；commit 未 pin）。**Support:** direct evidence。**Confidence:** high（模型存在性）；medium（多仓语义：workspacePath 为单路径，未见多仓成员模型）。
3. **Verdict（Cline/Roo）：部分相似。** task 词与"目标工作"最贴近，但 task≈session（一任务一对话），无 Project（多仓集合）层；Roo 的 modes 是角色分工而非 PiDock Environment。

### F7. Zed AI —— 部分相似（本轮最接近者，文档证明，高置信度）

1. **Claim:** Parallel Agents：多个 agent threads＋Terminal Threads 并行，各有独立 agent/context/history；Threads Sidebar 按 project 分组，linked Git worktree threads 归于同一 project。**Sources:** [S16a](https://zed.dev/docs/ai/parallel-agents)（官方 docs，live fetch）。**Support:** direct evidence。**Confidence:** high。
2. **Claim:** 单个 project 可为 multi-root folder project（多文件夹），agents 可在 single thread 内跨所有 folders 读写。**Sources:** [S16b](https://zed.dev/docs/ai/parallel-agents)（同页 multi-root 节，live fetch）。**Support:** direct evidence。**Confidence:** high。researcher inference：这是本轮唯一原生支持"单线程跨多目录"的桌面产品，最接近 PiDock"一任务多仓库"，但其 project 仍是文件夹集合＋threads 分组，无 Task（目标工作容器）抽象，thread≈session。
3. **Verdict（Zed）：部分相似（最接近）。** Project→threads 分组＋multi-root＋worktree isolation 三项贴近，但缺 Task 层、缺 Environment/服务编排、缺定时→新会话。

### F8. GitHub Copilot（含 Copilot Workspace 技术预览）—— 部分相似（文档证明）

1. **Claim（Copilot app）:** Each session runs in its own isolated workspace，可并行多 sessions（各有 branch），sidebar 按 repository 分组；Chats 为无 branch/worktree 的轻量对话。**Sources:** [S17](https://docs.github.com/en/copilot/how-tos/github-copilot-app/agent-sessions)（GitHub Docs，live fetch）。**Support:** direct evidence。**Confidence:** high。
2. **Claim（Workspace preview）:** 自称 task-centric；Everything begins with a task＝natural language description of intent，其 context 恒为 a GitHub repository（issue/PR/template/ad-hoc 四类）。**Sources:** [S18](https://github.com/githubnext/copilot-workspace-user-manual/blob/main/overview.md)（githubnext 官方手册 repo，live fetch）。**Support:** direct evidence。**Confidence:** high（但注意：该手册为技术预览归档，非现行 Copilot app 主线）。
3. **Verdict：部分相似。** session/workspace/task 三词齐备且 session≈PiDock Session，但 task 恒系单 repo，project≈repo；无多仓 Task、无 Environment、无定时语义。

### F9. Windsurf / Continue / Aider —— 不相似（文档证明）

1. **Claim:** Windsurf 的 workspace＝Cascade rules 作用域（global_rules.md vs .windsurf/rules），非任务容器。**Sources:** [S19](https://docs.devin.ai/desktop/cascade/memories)（官方 docs，search 摘要级）。**Support:** interpretation。**Confidence:** medium。
2. **Claim:** Continue 的 workspace＝config 作用域，模式为 Agent/Chat/Edit/Autocomplete，cn CLI 以 session 为单位。**Sources:** [S20](https://docs.continue.dev/)（官方 docs，search 摘要级）。**Support:** interpretation。**Confidence:** medium。
3. **Claim:** Aider 以 git repo＋chat session 为单位（/add 文件进 chat，git history 作上下文），无 project/task 分层。**Sources:** [S21](https://aider.chat/docs/git.html)（官方 docs，live fetch）。**Support:** direct evidence。**Confidence:** high。
4. **Verdict：不相似。** 三者均无 Project-Task-Session 三层；workspace 一词系规则/配置作用域，与 PiDock Task Workspace 完全不同。

### F10. LangGraph Studio / Flowise / Dust / AutoGen Studio / CrewAI —— 不相似（类别不可比，文档证明）

1. **Claim:** LangSmith Studio 自定位为 agent IDE for visualizing/interacting/debugging Agent Server graphs；thread＝persistent conversation container maintaining state across runs（assistant＋thread＋run 三元组）。**Sources:** [S22](https://docs.langchain.com/langsmith/use-threads)、[S23](https://docs.langchain.com/langsmith/studio)（官方 docs，live fetch＋search）。**Support:** direct evidence。**Confidence:** high。
2. **Claim:** CrewAI 的 Task＝description＋agent 指派＋依赖链，归属于 Crew/Flow；AutoGen Studio＝low-code multi-agent workflow builder。**Sources:** [S24](https://docs.crewai.com/)、[S25](https://www.microsoft.com/en-us/research/blog/introducing-autogen-studio-a-low-code-interface-for-building-multi-agent-workflows/)（官方 docs，search 摘要级）。**Support:** interpretation。**Confidence:** medium。
3. **Verdict：不相似（类别裁决）。** research inference：此组为 orchestration canvas（编排/调试智能体图），非 desktop coding workbench；其 thread/run 与 PiDock Session/Run 同形异义，不纳入相似性 matrix 主排序，仅作排除项记录。

### F11. 其他 Electron/Tauri 原生三层 workbench —— 未验证（即"未发现符合门槛者"）

1. **Claim:** 本轮以 project/task/session hierarchy＋官方 docs 或源码领域模型为收录门槛做搜索，未发现除上述产品外符合门槛的新 workbench。**Sources:** 无（检索边界陈述）。**Support:** missing evidence（未发现≠不存在）。**Confidence:** low。一律记未验证。

### Per-product verdict + evidence 表

| 产品 | Verdict | 一手证据状态 |
| --- | --- | --- |
| JetBrains ThinkRail | 部分相似 | 源码＋规格＋Release API 重验（S1–S6）；pinned：v0.1.2=282f5a1…；nightly.8=adda755…(prerelease) |
| Anthropic Claude Code/Desktop | 部分相似 | 官方 docs 直抓（S7–S9 高置信；S10 摘要级中置信） |
| OpenAI Codex | 部分相似（证据不足） | 官方 docs 两次 403，仅 search 摘要（S11）；需重抓 |
| Cursor | 部分相似 | 官方 docs 直抓（S12 高置信；S13 摘要级） |
| Cline | 部分相似 | 官方 docs 直抓（S14） |
| Roo Code | 部分相似 | 官方源码直抓 main（S15，未 pin commit） |
| Zed AI | 部分相似（最接近） | 官方 docs 直抓（S16a/b） |
| GitHub Copilot app / Workspace preview | 部分相似 | 官方 docs＋官方手册 repo 直抓（S17/S18） |
| Windsurf / Continue / Aider | 不相似 | Aider 直抓（S21）；Windsurf/Continue 摘要级（S19/S20） |
| LangGraph Studio/Flowise/Dust/AutoGen/CrewAI | 不相似（类别不可比） | LangSmith 直抓（S22/S23）；其余摘要级（S24/S25） |
| 其他 Electron/Tauri workbench | 未验证 | 无符合门槛者 |

### Comparison matrix（PiDock 概念 × 各产品最接近原生概念）

| PiDock 概念 | ThinkRail | Claude Code | Codex | Cursor | Cline/Roo | Zed | Copilot |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Project（多仓/目录/服务/环境集合） | project＝单个 Git repo（源码证明，结构性差异） | project directory（单目录；差异） | project（语义未证实，需重抓） | project root（单 checkout；差异） | 无（差异） | project，可 multi-root 多文件夹（最接近，仍缺服务/环境） | project＝repo/folder（差异） |
| Task（跨仓目标工作，可并行） | 无；多 workspace≠统一任务（源码证明差异） | 无独立 Task；并行靠 sessions＋worktrees（差异） | task 见于文案（未证实一等容器） | task≈单次隔离运行（差异） | task≈session（一任务一对话；差异） | 无 Task；并行靠 threads（差异） | Workspace preview task 恒系单 repo（差异） |
| Task Workspace（单任务副本＋运行态） | workspace＝单 worktree（单 branch/cwd；差异） | worktree＝单 checkout 隔离（部分机制相似） | background worktree（摘要级相似） | worktree＋worktrees.json setup（部分相似） | checkpoints/Git 快照（机制不同） | worktree isolation＋恢复（部分相似） | isolated workspace per session（部分相似） |
| Environment（命名配置＋远程依赖＋各任务本地实例） | 无对应模型（规格核查） | 无（未发现） | environments 见于 Cloud（未证实本地编排） | cloud env／snapshot（云端，非本地多服务编排） | 无 | 无 | cloud sandbox（云端隔离，非本地服务编排） |
| Agent Session（围绕任务的对话＋执行上下文） | chats（workspace 下并发会话；相似） | session（tied to dir，可 resume/branch；相似） | thread（摘要级相似） | agent run/chat（相似） | task 会话（相似但层级错位） | thread（独立 context/history；相似） | session（相似）；Chats 轻对话 |
| Scheduled→Run（固定区＋每次新会话＋历史可续） | automations 列 V2 未交付（API 证明） | scheduled task→fresh session（机制级相似，最接近） | automations（语义未证实） | 未发现 | 未发现 | 未发现 | 未发现 |

源码/文档证明 vs 未证明需实测 vs 结构性差异：
- 源码/文档证明：ThinkRail 单 repo→单 worktree→chats（S1–S4）；V2 未交付（S5）；Claude session/worktree/scheduled→fresh session（S7–S9）；Cursor worktree/task 隔离（S12）；Cline task 定义（S14）；Roo Task 类（S15）；Zed threads/project 分组＋multi-root（S16）；Copilot session/workspace＋task-centric 单 repo（S17/S18）；Aider git+session（S21）；LangSmith thread 定义（S22）。
- 未证明需实测：Codex 全维度（403）；Windsurf/Continue/Flowise/Dust/AutoGen/CrewAI 的摘要级条目；Roo commit pin；Claude Desktop 页原文；所有产品的真实多任务并行成本、服务配方可否外补、浏览器接管可行性。
- 结构性差异：PiDock Task 的多仓成员归属＋追加/回收、Environment/Task Override/Shared Template 三层配置、Task Browser View 任务级登录隔离＋Agent 主导验证——在全部已验产品中无一等对应物。

## Contradictions

- ThinkRail 自述 desktop-and-mobile/mobile-first（README）vs 产品规格 remote/phone 列 V2：属"方向 vs 现状"而非事实矛盾；本轮 API 证实 V2 仍未稳定交付，沿用 09-21 文档判断。
- Copilot Workspace 技术预览手册自称 task-centric vs 现行 Copilot app 以 session 为主：属产品代际差异（preview 归档 vs 现行），不记为矛盾，按 S17（现行）为准、S18 仅作历史参照。
- 其余产品间无直接矛盾；Codex 摘要与他品无冲突，但因 403 不作强证据。

## Missing evidence

1. Codex developers.openai.com 原文（worktrees/threads/automations/project 定义＋隔离机制），需换通道（非 403）重抓。
2. Roo Code Task.ts 的 commit pin；Roo/Cline 多 workspace 或多 repo 支持的官方说明。
3. Claude Desktop 页原文直抓（本轮失败一次）；Cursor Cloud env、Zed multi-root 上限与跨仓服务编排边界。
4. Windsurf/Continue/Flowise/Dust/AutoGen Studio/CrewAI 的官方 docs 直抓（本轮仅摘要级，按"不相似"记但强度为中）。
5. ThinkRail main→stable 的后续变化追踪（nightly.8 之后 V2 是否转正）；是否有本轮未列出的原生三层 Electron/Tauri workbench（以官方领域模型为门槛）。

## 跟进验证（2026-09-23 第二轮，primary-source only）

本轮对 Missing evidence 1–5 做 live 复抓。新主张编号 F12+，新来源编号 S26+（原 S1–S25 不重编号）。

### F12. Codex —— 仍被拦截，verdict 维持"证据不足"（直接证据：HTTP 状态本身；内容主张仍仅 discovery）

1. **Claim:** developers.openai.com/codex/* 经 4 种通道复试全部返回 HTTP 403：readable 模式（/app/worktrees）、raw 模式（/app/worktrees，透出 Vercel 风格 403 blocked 页面）、readable（/codex-manual.md）、readable（/app/automations）。openai.com/index/introducing-the-codex-app/ 与 help.openai.com 文章亦 403。**Sources:** [S26](https://developers.openai.com/codex/app/worktrees)（live fetch，readable＋raw 双通道 403，2026-09-23）。**Support:** direct evidence（仅证明"不可抓取"这一事实）。**Confidence:** high（拦截事实）；content claims 仍 medium（见下）。
2. **Claim（discovery only，不作强证据）:** web_search 发现相邻官方页面：worktrees 页摘要复述"multiple independent tasks in the same project…automations run on dedicated background worktrees…start threads on a worktree manually…Handoff moves thread Local↔Worktree"；automations 页摘要提及"project-scoped automations…machine must be powered on…project must still be available on disk"；openai.com 发布页摘要称"Agents run in separate threads organized by projects"；openai/codex repo 有 threads/projects sidebar 相关 issue（#11019 project folder moved 后 threads 不可达、#18640 thread/list 只加载最近 50）。**Sources:** [S27](https://developers.openai.com/codex/app/automations)（search 摘要级 discovery）、发布页与 Help Center（同为摘要级）。**Support:** interpretation（discovery aid）。**Confidence:** medium-low。researcher inference：project/thread/worktree 三词共存且 project 疑似以本地目录为锚点（#11019 搬目录即断链），但多仓库支持、task 是否一等容器仍未证实；verdict 不变。
3. **Verdict（Codex）：部分相似（证据不足，维持）。** 拦截通道与状态已精确记录（readable/raw/search 三通道，均为 403），后续需浏览器人工或自托管抓取通道。

### F13. Roo Code —— commit pin 已关闭，workspacePath 单路径主张升级为高置信度（源码证明）

1. **Claim:** Roo-Code main HEAD（2026-09-23 live API）为 b867ec9145750d0ae1ff7f02d35406e9bf2a0b16（2026-05-15，Remove roocode.com web app #12375）；按该 SHA 重新抓取 Task.ts 原文：`readonly workspacePath: string` 单路径字段；子任务强制继承父路径（`this.workspacePath = parentTask ? parentTask.workspacePath : (workspacePath ?? getWorkspacePath(...))`）。**Sources:** [S28](https://raw.githubusercontent.com/RooCodeInc/Roo-Code/b867ec9145750d0ae1ff7f02d35406e9bf2a0b16/src/core/task/Task.ts)（pinned commit raw，live fetch）。**Support:** direct evidence。**Confidence:** high。
2. **Claim:** Roo 官方 Worktrees 文档明确限制：Multi-root workspaces are not supported；Workspace must be at the repository root (not a subfolder)；worktree＝same repository 多分支并行目录。**Sources:** [S29](https://roocodeinc.github.io/Roo-Code/features/worktrees)（官方 docs，live fetch）。**Support:** direct evidence。**Confidence:** high。researcher inference：Roo 的 task 无多仓成员模型，且官方明确排除 multi-root——与 PiDock Task 结构性差异成立，F6 verdict 维持并加固。
3. **Claim（Cline）:** task-management 官方页重抓确认 task＝self-contained work session 定义不变（F6/S14 维持）；该页无多 workspace/多 repo 支持声明（absence 观察，非引证）。**Sources:** [S30](https://docs.cline.bot/core-workflows/task-management)（官方 docs，live fetch 复验）。**Support:** direct evidence（定义复验）；absence 属 researcher observation。**Confidence:** high（定义）；low（absence 不证明不存在）。

### F14. Claude Code Desktop 页直抓成功（S10 升级为直接证据）；Cloud multi-repo 为 Cursor 独有，Claude 仍单目录

1. **Claim:** Desktop Code tab 直抓成功：每个 conversation 即 session（own chat history＋project folder）；启动前配 Environment（Local/Cloud/SSH/WSL）＋Project folder；**cloud sessions 可 add multiple repositories**；sidebar 可按 status/project/environment 过滤、按 project 分组；Git 项目可选 worktree 隔离（存于 `<project-root>/.claude/worktrees/`）。**Sources:** [S31](https://code.claude.com/docs/en/desktop)（官方 docs，live fetch 2026-09-23，直抓成功）。**Support:** direct evidence。**Confidence:** high。researcher inference：S10 由摘要级升级为直接证据；Cloud 多 repo 属云端能力，本地仍 project folder 单目录语义——F3/F5 verdict 不变；Claude 是本轮唯一在官方文档明确写出 cloud multi-repo 的桌面系产品，但其非本地 Task 容器语义。
2. **Claim（Cursor Cloud env 边界，直抓升级）:** Cloud Agents 运行 isolated VMs；**支持 multi-repo environments**（frontend/backend/infra/shared-library 跨仓 inspect＋coordinated changes＋各仓开 PR），但 Long-running is not available for multi-repo environments；Environments 可 scoped to one repo or to a group of repos。**Sources:** [S32](https://cursor.com/docs/cloud-agent)＋[S33](https://cursor.com/docs/cloud-agent/settings)（官方 docs，live fetch）。**Support:** direct evidence。**Confidence:** high。researcher inference：Cursor Cloud 的 multi-repo 是云端 agent 运行环境能力，无本地 Task 容器、无 Environment/服务编排本地对应物，F5 verdict 不变但 S13 由摘要级升级为直接证据。
3. **Claim（Zed 边界，直抓升级）:** Windows & Projects 页确认：单窗口多 projects（threads sidebar 分组）、each project has its own file tree/git state/search scope、threads tied to project context；Add Folder to Project＝在当前 project file tree 加 additional root（即 multi-root）；文档未声明 folder 数量上限（absence 观察）。**Sources:** [S34](https://zed.dev/docs/windows-and-projects)（官方 docs，live fetch）。**Support:** direct evidence（模型部分）；absence 属 observation。**Confidence:** high（模型）；low（上限未声明≠无上限）。researcher inference：Zed 仍无 Task 层、无服务编排声明，F7 verdict 不变；"multi-root 上限"缺口仍 open（文档无数值）。

### F15. Windsurf/Continue 类别排除升级为直接证据（F9 加固）

1. **Claim:** Windsurf Cascade Memories & Rules 官方页（docs.windsurf.com 规范地址）直抓：workspace＝rules/memories 作用域（Global `~/.codeium/windsurf/memories/global_rules.md` vs Workspace `.devin/rules/*.md` 优先、`.windsurf/rules/*.md` fallback）；Memories associated with the workspace they were created in，跨 workspace 不可用。**Sources:** [S35](https://docs.windsurf.com/windsurf/cascade/memories.md)（官方 docs，live fetch）。**Support:** direct evidence。**Confidence:** high。researcher inference：workspace 系规则/记忆作用域，非任务容器——F9 Windsurf 条由摘要级升级为直接证据，verdict 不变。附带观察：Windsurf 文档出现 Devin Desktop 品牌残留（`.devin/` 优先），疑似改名过渡期，属旁注非裁决依据。
2. **Claim:** Continue 官方首页直抓：Agent/Chat/Edit/Autocomplete 四模式＋`config.yaml` 自定义；无 Project/Task/Session 三层领域模型。**Sources:** [S36](https://docs.continue.dev/)（官方 docs，live fetch）。**Support:** direct evidence。**Confidence:** high。F9 Continue 条升级为直接证据，verdict 不变。

### F16. Flowise/Dust/CrewAI/AutoGen 类别排除升级为直接证据（F10 加固）

1. **Claim:** Flowise 官方文档自定位：open source generative AI development platform，主构建器为 Assistant/Chatflow/Agentflow（visual builders）——编排画布类别。**Sources:** [S37](https://docs.flowiseai.com/)（官方 docs，live fetch）。**Support:** direct evidence。**Confidence:** high。
2. **Claim:** Dust Pods Tasks 官方页直抓：Tasks 为 Pod 内轻量事项（Open→In progress→Done），可 start an agent on task 并建 linked conversation——这是本轮编排组中唯一 task＋conversation 显式链接的设计，但 Pod 为协作空间非多仓 project，且无 desktop workbench 语境。**Sources:** [S38](https://docs.dust.tt/docs/user-documentation/pods/tasks)（官方 docs，live fetch）。**Support:** direct evidence。**Confidence:** high。researcher inference：类别排除维持，但 Dust 列为"编排组中最接近 task-session 链接者"旁注。
3. **Claim:** CrewAI Tasks 官方页直抓：Task＝description＋agent＋tools＋context＋output 归属于 Crew 的编排单元（sequential/hierarchical 执行），非桌面工作区容器。**Sources:** [S39](https://docs.crewai.com/en/concepts/tasks)（官方 docs，live fetch）。**Support:** direct evidence。**Confidence:** high。
4. **Claim:** AutoGen Studio（MS Research 官方博客）直抓：low-code multi-agent workflow builder（Build/Test/Deploy agent workflows，v0.1.0），非 desktop coding workbench。**Sources:** [S25-reverify](https://www.microsoft.com/en-us/research/blog/introducing-autogen-studio-a-low-code-interface-for-building-multi-agent-workflows/)（官方博客原文，live fetch 复验；原 S25 为 search 摘要级，现升级）。**Support:** direct evidence。**Confidence:** high。
5. **Verdict（F10）：不相似（类别不可比）维持，证据强度由"中"整体升级为高（直接证据）。**

### F17. ThinkRail V2 追踪（2026-09-23 复验）：stable 未动，main 无新提交，remote/automations 仍未交付

1. **Claim:** releases/latest 复抓仍为 v0.1.2（282f5a1，published 2026-09-20T09:16:30Z，prerelease=false）；tags API（per_page=10）顶部仍为 v0.2.0-nightly.8（adda755）；branches/main HEAD＝adda755（2026-09-21T18:00:47Z）；commits API 近 5 条最新即 adda755（title bar #458），其后无新提交。**Sources:** [S40](https://api.github.com/repos/JetBrains/thinkrail/releases/latest)＋tags＋branches/main＋commits?per_page=5（live fetch 2026-09-23）。**Support:** direct evidence（API 元数据）。**Confidence:** high。附带发现：v0.2.0-nightly.7 与 v0.1.2 指向同一 commit 282f5a1（nightly.7 实为 stable commit 的重打 tag）。
2. **Verdict：V2 未转正判断维持；F2/S5 结论不变。**

## Sources

- Kept:
  - [S1] ThinkRail README（main，live fetch 2026-09-23）(https://github.com/JetBrains/thinkrail/blob/main/README.md) —— project/worktree/chat 定义，V1 Worktree IDE 自述。
  - [S2] ThinkRail domain.ts（main raw，live fetch）(https://raw.githubusercontent.com/JetBrains/thinkrail/main/packages/contracts/src/domain.ts) —— Project/Workspace 单一 path/projectId 源码证明。
  - [S3] ThinkRail workspaces/SPEC.md（main raw，live fetch）(https://raw.githubusercontent.com/JetBrains/thinkrail/main/packages/server/src/workspaces/SPEC.md) —— Default/external workspace 语义。
  - [S4] ThinkRail goal-and-requirements.md（main raw，live fetch）(https://raw.githubusercontent.com/JetBrains/thinkrail/main/goal-and-requirements.md) —— V1/V2 范围，automations/remote 列 V2。
  - [S5] ThinkRail Releases API（live fetch 2026-09-23）(https://api.github.com/repos/JetBrains/thinkrail/releases/latest) —— latest=v0.1.2（282f5a1…）；nightly.8=adda755… prerelease 2026-09-22，V2 未交付证明。
  - [S6] ThinkRail architecture.md（main，live fetch）(https://github.com/JetBrains/thinkrail/blob/main/architecture.md) —— repo→worktree→chats 架构链。
  - [S7] Claude Code Sessions（官方 docs，live fetch）(https://code.claude.com/docs/en/sessions) —— session tied to project directory。
  - [S8] Claude Code Worktrees（官方 docs，live fetch）(https://code.claude.com/docs/en/worktrees) —— --worktree 并行隔离。
  - [S9] Claude Code Desktop Scheduled Tasks（官方 docs，live fetch）(https://code.claude.com/docs/en/desktop-scheduled-tasks) —— scheduled→fresh session。
  - [S10] Claude Code Desktop（官方 docs，search 摘要，直抓失败）(https://code.claude.com/docs/en/desktop) —— parallel sessions 摘要级。
  - [S11] Codex Worktrees（官方 docs，search 摘要；两次 403）(https://developers.openai.com/codex/app/worktrees) —— discovery only。
  - [S12] Cursor Worktrees（官方 docs，live fetch）(https://cursor.com/docs/configuration/worktrees) —— task 隔离＋worktrees.json。
  - [S13] Cursor Cloud Agents（官方 docs，search 摘要）(https://cursor.com/docs/cloud-agent) —— 云端隔离参照。
  - [S14] Cline Task Management（官方 docs，live fetch）(https://docs.cline.bot/core-workflows/task-management) —— task＝self-contained session。
  - [S15] Roo Code Task.ts（官方 repo main raw，live fetch，未 pin）(https://github.com/RooCodeInc/Roo-Code/blob/main/src/core/task/Task.ts) —— Task 类父子/mode 模型。
  - [S16] Zed Parallel Agents（官方 docs，live fetch）(https://zed.dev/docs/ai/parallel-agents) —— threads 按 project 分组＋multi-root。
  - [S17] Copilot App Agent Sessions（GitHub Docs，live fetch）(https://docs.github.com/en/copilot/how-tos/github-copilot-app/agent-sessions) —— per-session workspace。
  - [S18] Copilot Workspace Overview（githubnext 官方手册，live fetch）(https://github.com/githubnext/copilot-workspace-user-manual/blob/main/overview.md) —— task-centric 单 repo（历史参照）。
  - [S19–S25] Windsurf/Continue/Aider/LangSmith/CrewAI/AutoGen 官方 docs（Aider、LangSmith 直抓；其余 search 摘要级）—— 不相似/类别排除依据。
  - [S26] Codex 拦截事实（live fetch 2026-09-23，第二轮）(https://developers.openai.com/codex/app/worktrees) —— readable＋raw 双通道 HTTP 403（Vercel 风格 blocked 页，request id hnd1::s27hq-1790101361379-8dbd7267619b）；同轮 /codex-manual.md、/app/automations、openai.com 发布页、help.openai.com 文章亦 403。仅证明不可抓取。
  - [S27] Codex 相邻官方页 search 摘要 discovery（第二轮）(https://developers.openai.com/codex/app/automations) —— worktrees/automations/troubleshooting/commands 摘要＋openai.com 发布页"threads organized by projects"＋openai/codex issues #11019/#18640/#25818。discovery only，不作强证据。
  - [S28] Roo Code Task.ts pinned commit b867ec9145750d0ae1ff7f02d35406e9bf2a0b16（2026-05-15，live fetch 第二轮）(https://raw.githubusercontent.com/RooCodeInc/Roo-Code/b867ec9145750d0ae1ff7f02d35406e9bf2a0b16/src/core/task/Task.ts) —— `readonly workspacePath: string` 单路径＋子任务继承父路径源码证明。
  - [S29] Roo Code Worktrees 官方 docs（live fetch 第二轮）(https://roocodeinc.github.io/Roo-Code/features/worktrees) —— Multi-root not supported；workspace 须为 repo root；worktree＝同仓多分支并行。
  - [S30] Cline Task Management 复验（live fetch 第二轮）(https://docs.cline.bot/core-workflows/task-management) —— task 定义复验，无多 repo 声明（absence 观察）。
  - [S31] Claude Code Desktop 直抓成功（live fetch 第二轮，S10 升级）(https://code.claude.com/docs/en/desktop) —— session＝conversation＋project folder；Environment 四选项；cloud sessions 可 multiple repositories；sidebar 按 project 分组；worktree 隔离路径。
  - [S32] Cursor Cloud Agents 直抓（live fetch 第二轮，S13 升级）(https://cursor.com/docs/cloud-agent) —— isolated VMs；multi-repo environments 跨仓改动＋各仓 PR；long-running 不支持 multi-repo。
  - [S33] Cursor Cloud Agents settings 直抓（live fetch 第二轮）(https://cursor.com/docs/cloud-agent/settings) —— Environments scoped to one repo or group of repos。
  - [S34] Zed Windows & Projects 直抓（live fetch 第二轮）(https://zed.dev/docs/windows-and-projects) —— 单窗多 projects＋threads 分组；各 project 独立 file tree/git/search；Add Folder to Project＝additional root；无 folder 上限声明。
  - [S35] Windsurf Cascade Memories & Rules 规范地址直抓（live fetch 第二轮，S19 升级）(https://docs.windsurf.com/windsurf/cascade/memories.md) —— workspace＝rules/memories 作用域；memories 不跨 workspace。
  - [S36] Continue 官网直抓（live fetch 第二轮，S20 升级）(https://docs.continue.dev/) —— Agent/Chat/Edit/Autocomplete＋config.yaml，无三层模型。
  - [S37] Flowise 官方文档直抓（live fetch 第二轮）(https://docs.flowiseai.com/) —— Assistant/Chatflow/Agentflow visual builders，编排画布类别确认。
  - [S38] Dust Pods Tasks 直抓（live fetch 第二轮）(https://docs.dust.tt/docs/user-documentation/pods/tasks) —— Pod tasks Open/In progress/Done＋linked conversation，协作空间类别。
  - [S39] CrewAI Tasks 直抓（live fetch 第二轮，原 S24 升级）(https://docs.crewai.com/en/concepts/tasks) —— Task 归属 Crew 的编排单元。
  - [S40] ThinkRail 复验 API 组（live fetch 第二轮 2026-09-23）(https://api.github.com/repos/JetBrains/thinkrail/releases/latest) —— latest 仍 v0.1.2；tags 顶部仍 nightly.8；main HEAD＝adda755；nightly.7 与 v0.1.2 同 commit 282f5a1。
- Rejected/deprioritized:
  - 博客/营销/聚合页（含 thinkrail.ai blog、tomevault 等）—— 非一手来源，仅作发现线索。
  - developers.openai.com 的 403 页面—— 不可抓取，不列为证据。
  - 本地 prior brief 与 thinkrail 研究文档—— 仅作起点假设，每条已重验，不作二手引用。

## Next steps

1. 换通道重抓 Codex 官方 docs（S11），确认 project/task 是否为一等容器——关闭本轮最大单一缺口。
2. 给 Roo Task.ts 打 commit pin，并补抓 Cline/Roo 多 repo 支持声明；直抓 Claude Desktop 页与 Cursor/Zed 服务编排边界。
3. 追踪 ThinkRail nightly→stable（V2 转正即重估）；新 workbench 收录坚持"官方 docs 或源码领域模型自证三层"门槛。

##  closing verdict（新颖性裁决＋stop/continue）

- Novelty claim：部分成立（partially supported）。一手来源下，无产品实现 PiDock 一等三元组；最接近的单项（Zed multi-root、Claude scheduled→fresh session、Cursor/Copilot worktree 隔离、Cline/Roo task 词）各自只命中一个切面，且层级错位或单仓约束明确，结构性差异成立。不判 fully supported（Codex 未证实＋摘要级条目＋无实测），更不判 refuted。
- Stop/continue：continue——保留 Project-Task-Session（含 Scheduled Run）分层作为设计基准；不以"新颖性已证实"为由直接投入生产实现，优先补齐 Missing evidence 1–3 后再做构建/复用决策。

## closing verdict 修订（2026-09-23 第二轮后）

- Novelty claim：部分成立（partially supported）——维持。变化：S26–S40 把 F9/F10 的"不相似" verdict 证据强度由中升级为高（直接证据），Roo 单路径主张 pin commit 后升级为高置信，Claude Desktop（S31）与 Cursor multi-repo（S32/S33）由摘要级升级为直接证据且 verdict 不变；唯一未升级的是 Codex（四通道仍 403，verdict 维持"证据不足"）与 Zed multi-root 数值上限（文档无声明，仍 open）。
- Stop/continue：continue——维持。Missing evidence 2–4 已基本关闭（Roo pin 完成；Desktop/Cloud/Zed/Windsurf/Continue/Flowise/Dust/CrewAI/AutoGen 均获直接证据）；残留缺口仅剩 Codex 原文（Missing 1）、Zed folder 上限数值、ThinkRail 后续转正追踪（Missing 5）。建议下一构建决策前只需盯住 Codex 一条。
