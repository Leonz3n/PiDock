# [UI 对齐 09] #33 — 其余管理页逐页对齐原型 A：验证日志

本文件记录这一切片**实际跑过**的检查、两侧读数与偏差。所有数字来自本机 headless Chromium
（`capture-pages.mjs`，同一轮内同时读渲染器与原型 A 的同一 class 选择器），不引用原型样例数字。

命令：

```
# 渲染器 127.0.0.1:4335（Vite dev，未重启） / 原型 A 127.0.0.1:4319/?variant=A（只读）
node docs/evidence/ui-alignment-s7b/capture-pages.mjs     # 183 assertions, 5 viewport tiers, 6 pages, exit 0
pnpm --filter @pidock/renderer test                        # 58 files / 494 tests
```

本文件在 #33 评审后经一轮修复（P1-1、P1-2、P2-1…P2-9）更新：断言 142 → 183，逐项变更见 §3 与 §4。

## 1. 逐页验收对照

| 页面 | 原型结构 | 本轮实现 | 判定 | 关键读数（1440×900，渲染器 vs 原型） |
| --- | --- | --- | --- | --- |
| 模型与 Provider | view-label `MODELS` + h1 + 添加 provider + intro + `.grid3` provider 卡（symbol/协议 badge/mono 端点/模型 chips/`N 个模型 · 凭据已设置`/编辑·选择模型）+「切换只影响当前会话」卡 | 同结构；chips `模型 · 窗口 · 图片`；编辑/同步模型列表/停用/删除；每模型明细表（既有 #12 能力）保留在卡内；选择模型 → 原型的无任务回退文案「在任务会话中选择」 | COVERED（1 处偏差见 §3） | `.provider-card` padding `20px`/radius `9px`、`.provider-symbol` `35×35`/`#f1eee8`/`#a8895f`/`18px`/`600`、`.provider-card p` `11px`/`rgb(148,151,156)`/`12px 0`、chips `flex`/`gap 5px`、`grid3` 3→1 列（960）全部一致 |
| Token 用量 | view-label `USAGE` + h1 + 两个 select + intro + `.grid4` 4 张 stat + `.grid2`（每日柱状 + 构成环形）+ `按X汇总` + `示例 · 不代表账单` + 6 列汇总表 + 空状态 | 同结构；4 张 stat 全部由 store 计算（916k / 最近一次调用 5,200 Tokens / 96 次 / 13 次）；柱高与环形扇区按真实记录算；6 列表格（维度/输入/输出/缓存读取/总计/完整性） | COVERED（第 2 张卡改写见 §3.14） | `.grid4` 4 列→2（1180）、`.stat` `28px`/`550`、`.bar-chart` `155px`/`gap 14px`、`.bar` `65%`/`max 38px`/`#aeb7cd`、`.usage-donut` `120×120`、`.table th` `11px 13px`/`#96999e`/`#fafbfc`、`.table td` `13px` 全部一致；柱宽 26px vs 38px 的差来自「全部(10 天)」与「近 7 天」的柱数差，切到同一个 7 天窗口（自定义）后两侧 chart 宽度都是 523px |
| 能力管理 | view-label `AGENT CAPABILITIES` + h1 + 按类型变化的添加按钮 + intro + `.capability-summary` 4 格 + 带计数的 `.capability-tabs` + MCP/Package inline-notice + `.capability-list`/`.capability-row` + 结尾 note | 同结构；计数与 tabs 计数来自 store（`2/1/1/2`，tab `4 / 6 已启用` 等）；notice 用原型原文；行内含类型/安装版本/bridge/连接/可用性/失败原因与操作 | COVERED | `.capability-summary` 4 列、cell padding `15px 18px`、strong `21px`/`550`、`.capability-tabs` gap `20px`、`.capability-row` padding `13px 15px`/gap `14px`/3 行轨、`.capability-icon` `36×36`/`#f1f3f6`/`#66758f`、`.capability-meta` `10px`/`#8a94a2` 全部一致 |
| 远程访问 | view-label `REMOTE ACCESS` + h1 + 状态 badge + 手机视图 + intro + `.remote-mode-picker` 3 卡（图标/标题/说明/推荐）+ `.remote-layout`（连接卡 + 权限卡 ‖ 设备卡 + guard 卡） | 同结构；3 模式来自 `REMOTE_ENTRY_ROWS`（图标 shield/server/globe、推荐、实验入口标签）；连接卡展示 Host 监听/Gateway/入口地址的真实读数，并按模式补上原型的 `.command-preview`（tailscale/funnel，用 Host 上报的 listener）与 `.remote-flow`/`.gateway-details`（gateway），`重新检测` 重读 Host；权限默认值只读展示；设备行含确认/拒绝/轮换/撤销 | COVERED（标签、色值与三处缺口见 §3.6/§3.7/§3.15…§3.18） | `.remote-mode-picker` 3 列/gap `10px`、按钮 `12px`/`8px`/`32px + 1fr`、symbol `32×32`/`#f1f3f6`/`#6a7892`、title `11px`、hint `9px`、`.remote-layout` `1.55fr/280px`、`.status-orb` `12×12`、`.connection-checks` 3 轨/`10px 12px`、`.permission-list label` gap `11px`/`10px 0`、`.device-row` 3 轨/`32px`/`12px 0`、`.device-symbol` `31×31` 一致 |
| 定时任务 | view-label `SCHEDULED TASKS` + h1 + 新建定时任务 + intro + `.schedule-summary` 3 格 + `.segmented` 过滤 + `.schedule-list` 行（155px 时间列 + 主区 + 操作）+ `执行记录` 5 列表 + note | 同结构；summary 取存储里的 已启用/最近执行/下次触发；segmented 真实过滤（全部 2 / 已启用 1 / 已暂停 1）；行内规则/时区/状态/任务·模型·权限/提示词/下次/失败原因；历史表保留 VirtualList（40+ 窗口化行）并加同列头 | COVERED | `.schedule-summary` 3 列/cell `16px 18px`/gap `6px`/strong `15px`/`550`、`.segmented` `3px`/`7px`/`#f4f5f7`、按钮 `6px 11px`/`5px`/`10px`、`.schedule-row` `155px + 1fr + auto`/gap `18px`/`16px 18px`、`.schedule-time` 2 轨/`20px` 图标、`.schedule-actions` 右对齐 flex wrap、表头 cell `11px 13px`/`10px`/`#96999e`/`#fafbfc` 一致 |
| 已归档 | h1（无 view-label）+ intro + 每个归档任务一张 `.card.between`（名称 + `N 个仓库 · 会话与浏览器状态已保留` + 恢复/清理…）+ `.empty` | 同结构；卡片头部换成原型的两栏（名称 + 形状行 + 归档 badge + 两个操作），卡内仍是 Host 的生命周期读数（worktree/进程身份、清理回执与恢复项） | COVERED | `.card` padding `20px`/radius `10px`/`1px`/白底一致；两侧按钮图标都是 `[0,0]`；原型空状态与渲染器卡片在同一轮内都截了图 |

`AttentionPage.tsx` / `SettingsPage.tsx` **未改动**：原型 A 的页面表里没有对应视图
（`render()` 的 `pages` 只有 project/env/providers/usage/schedules/capabilities/remote/archive，
`设置` 只在别的文案里作为词出现）。这两页留给后续有原型依据的切片，不凭空重画。

## 2. 数字来源（不硬编码原型样例）

- 4 张 stat：累计 Token = 筛选后记录之和（含缓存读写）；最近一次调用 = 按 `at` 取最新一条的
  token 与 `taskId · sessionId`；已记录调用 = 行数；未完整报告 = `missing + partial`。
- 柱状图：按当前时间范围内**真实存在调用的日期**聚合，高度按窗口内最大值归一化；零调用的那天
  只画 5px 且 40% 透明（原型的 `min-height:5px` 会让「0」看起来像一个小值）。
- 环形图：四段（输入/缓存读取/输出/缓存写入）按真实占比算 conic-gradient，中心是同一个总计。
- 6 列汇总表：`groupUsageRecords` 的分组，`总计 = 输入 + 输出 + 缓存读取 + 缓存写入`（表注说明
  缓存写入只在明细/汇总逐项列出，避免 7 列撑宽）。
- 能力计数、tab 计数、定时任务 summary/过滤、设备与权限行全部来自 store；MCP/Package 的
  `inline-notice` 用原型原文（这是产品的边界声明，不是数据）。

## 3. 有意偏差（已声明，不当作“已完成”）

1. **Provider 卡内保留了每模型明细表**（窗口 Tokens + 来源标签 + 最大输出 + 能力/推理）。
   原型卡只有 chips；这张表是 #12 已交付并有用例的可见能力（`provider-status-*` /
   `64000` / `手工值` 断言），因此没有删除，只把字体降到 11px。chips 与表格都在同一张卡里。
2. **Provider 卡的「选择模型」**：本应用在该页没有会话上下文，原型自身在无任务时也回退为
   「在任务会话中选择」，因此按原型回退处理，会话级模型选择仍在对话输入区。
3. **用量页新增 全部/自定义 两个时间档位**：原型的 统计日期 只有 近 7 天/今天/近 30 天，而本页是
   全量账本，默认「全部」保持既有读数（240 行）与既有用例稳定；「自定义」在手工改日期后选中。
4. **用量汇总表的完整性 badge**：原型第二行固定 `warn`；本实现由该组是否有未报告调用推出
   （`missing > 0` → 部分未报告）。
5. **用量页不再重复「分组 · X」面板**：原型的分组就体现在 6 列汇总表里，因此把分组面板并进
   表格；用例改为断言同一份分组数据（`usage-group-compaction/turn` 行）。
6. **远程入口标签用本应用的名称**（`自建 PiDock Gateway` / `Funnel 公网入口`）与远程页自身的
   模式名一致，原型写作 `自建 Gateway` / `Funnel`；三种模式一一对应。
7. **远程权限清单是只读默认值**：勾选反映配对时的默认值，真正授予发生在设备确认时（Host 没有
   全局权限写接口，不新增）；原型这里是可点的复选框。
8. **远程状态 badge 读 Host 上报的 Gateway 状态**（`gateway.status === "online"` 才算已连接），
   因此夹具下显示「尚未连接」；不伪造「已连接」。
9. **定时任务的启停仍是带文字的按钮**（原型是开关）：这些操作有「等回合结束才生效」的语义，
   文字按钮更明确，且 `managementFlows` 依赖按钮名。
10. **已归档页列出全部归档任务**（原型只列当前项目的）；卡片操作沿用本应用更精确的
    `恢复任务` / `预览清理清单`（原型为 `恢复` / `清理…`），两者都在用例里。
11. **页面块间距用页容器 `gap-4`**（原型用 `.capability-summary{margin:20px 0 8px}` 这类块级
    margin），因此这几处的 `marginTop/marginBottom` 有意不参与逐属性相等断言，其余属性仍逐项比对。
12. **强调色**：`.remote-mode-picker em`（推荐）与 `.schedule-time` 时钟图标用本应用 token
    `#233c78`，原型 A 末尾 "Review revision" 覆盖后是 `#4668cc`。这是 epic 级 D5 待定项，
   本轮照旧记录不切换（`pages.json` → `geometry.accentUsers`）。
13. **D4 图标**：管理页按钮按原型补了图标（provider `＋/齿轮/刷新/停/放`、capabilities `＋/刷新`、
    remote `地球/＋/勾/刷新`、schedules `＋/放/停`）；`archive` 两侧都无图标。`usage` 原型的
    `.page .btn` 为空数组，本页 4 个清理/重载按钮保持无图标。

### 3b. 评审修复轮新增的声明（#33 P1-2 / P2-1 / P2-4 / P2-6 / P2-7）

14. **用量页 intro 改写**（`UsagePage.tsx`）：原型写「…以下均为示例统计。」，本页写「…统计范围为本应用记录，不等同账户账单或供应商配额；未观测到的外部调用不伪造。本页数据为样例数据。」——这两句是本应用必须说清的事实（账本只记本机观测到的调用，且夹具不是账单），所以换成实话而不是删掉。脚本按页面钉死这段字符串，改一字即失败。
15. **计划任务页 intro 改写**：原型写「定时任务拥有固定工作区；每次触发在任务内新建 Agent 会话并发送预设提示词。」，本页写「定时任务拥有固定任务工作区，按规则新建独立会话；每次执行不继承上一次对话上下文，历史会话可查看并继续。」——描述的是本应用的真实行为（历史会话可查看并继续）。同样被脚本钉死。
16. **归档页 intro 多一句**：在原型两句之后补「恢复任务不自动启动服务或重新启用调度。」（Host 的真实语义，与 §3.10 同一回事）。
17. **用量页第 2 张 stat 卡的语义**（评审 P2-1）：原型是「当前会话」（值是当前任务的 tokens）；本页是项目级账本，没有会话上下文，所以改成「最近一次调用」（值 = 筛选后 `at` 最新的那条调用）。第 1/3/4 张卡与原型逐字一致，这一张被脚本单独钉死。
18. **协议展示名**（评审 P2-7）：卡片 badge 与编辑表单的 select 都用原型 `providerProtocols` 的展示名（`Anthropic Messages` / `OpenAI Responses` / `OpenAI Chat Completions`），**存储值仍是 wire id**（`anthropic-messages` …），未知 id 回退为 id 本身。脚本断言 badge 只出现展示名。
19. **远程页四处仍缺的控制**（评审 P2-4，Host 没有对应能力，**不新增**）：
    - `这台电脑的名称` 输入：`RemoteEntryState` 没有该字段，Host 也没有设置它的写接口。
    - `启用此入口／断开连接` 主按钮：Host 没有连接/断开写接口，`gateway.status` 是 Host 上报的只读值。
    - `扫码添加` 文案：保留「配对设备」（与配对弹窗、既有用例一致，同 §3.10 的 `恢复任务` 同一类）。原型另有 `撤销`，本页为「撤销设备」。
    - `实验入口` em：仅 Funnel 卡，属本应用对「实验性入口」的显式标注（原型只在 tailscale 卡写 `推荐`）。
    这四项在脚本里以“声明缺席”断言固定（`declaredAbsent` + `DECLARED_BUTTON_GAPS`），不会静默变成“已完成”。
20. **`.connection-checks` 三行文案**（评审 P2-4）：本页保留自己的三行（Host 监听／入口地址／Gateway），因为它们报的是 Host 实际上报的值，而原型这三行在 tailscale 模式下写的是示例文案（「原型示例：未检测到可用安装」）。行轨宽、padding、`.dot`、右侧 `.mono` 已全部逐属性断言。
22. **三处未声明的增补文案**（评审 P2-7，现已在脚本里锁住）：
    - Provider 页「切换只影响当前会话」卡在多一句「新会话在任务里新建后选择模型。」（本应用的会话模型选择确实在任务里发生）。原型原句保留在前。
    - 归档页卡片形状行用 `N 个普通目录`（原型只有 `普通目录`，没有数量），本应用有真实的 `directories` 列表所以报数量。
    - 归档页卡片多一个 `已归档` badge（原型靠所处页面表达该状态），与 `恢复任务`/`预览清理清单` 同属 §3.10。
    - 归档页 intro 在原型两句后补一句，见 §3.16。

21. **按钮图标是超集**（评审 P2-6）：除 `编辑`（provider 卡片，原型该按钮无图标）外，本应用带图标按钮的集合与原型一致；`schedules` 实际是 **5 个图标 / 21 个按钮**（先前报告写的 3/6 是错的，已更正）。脚本改为逐 label 双向比较（`button glyphs agree with the prototype @<page>`）而不是 `>=`。

### 3c. 评审修复轮真修的缺陷（不属声明）

- **P1-1 执行记录表头**：`run-history-head` 同时带 `table`（Tailwind `display:table`）与 `grid`，5 个表头格被当成匿名表格行竖排成 66px；已去掉 `table`，并把 body 行的 `px-[13px]` 下放到每个单元格，使表头与行的轨宽一致。
- **P2-2 死代码**：`remote-guard bg-[#faf9f5]` 输给 `Card` 的 `bg-paper`（实测白底），`.remote-layout .card{border-radius:8px}` 也从未生效；两处改用 `!` 修饰符。
- **P2-3 标记类无规则**：`.dot`/`.mono` 在本包没有任何规则，连接行画出空白 8px 列、端点/URL/用量数字不是等宽；已补上对应工具类（`tokens.css` 未改），并让证据 helper 采集 `fontFamily`。
- **P2-5 远程设备行挤压**：该行 `auto` 轨最多塞 4 个按钮，1440 档把名字列压到 **15px / 40 行折行**；改为按钮列竖排（轨仍为原型 3 轨），同行为 **147px / 3 行**。
- **P2-8 证据时钟炸弹**：用量反 no-op 断言依赖「机器当前周 ∩ 固定夹具 2026-09-12…21」，自 2026-09-28 起必失败。已改为用页面自己的「自定义」窗口钉住夹具日期，并用 2030 年窗口验证空态；另用 Playwright `context.clock` 将页面时钟前移 **+40 天 / +180 天** 复跑仍绿（旧断言在 +40 天时以 `weekly=0 all=240` 复现失败）。
- **P2-9 重复实现**：`CapabilitiesPage` 复制了 `InlineNotice` 的两段内联样式，已改用该原语。

## 4. 回归证据（本切片重跑，均 exit 0）

| 脚本 | 结果 |
| --- | --- |
| `ui-alignment-s2/capture-vertical.mjs` | `ok (6 card-free floor checks at 400px)` |
| `ui-alignment-s3/capture-execution.mjs` | `ok (42 measured states)`；原型 `.execution-panel` idle 68px / waiting 225px |
| `ui-alignment-s4/capture-composer.mjs` | `ok (22 measured states)`；`composer=143px`（失败态 174px，见既有残留） |
| `ui-alignment-s6/capture-conversation.mjs` | `ok (101 checks)` |
| `ui-alignment-s7a/capture-management.mjs` | `ok (167 assertions, 5 viewport tiers)` |
| `ui-alignment-s7b/capture-pages.mjs` | `ok (183 assertions, 5 viewport tiers, 6 pages)` |

### 4b. 负向验证（本轮新增，均已复现失败）

每条断言都先故意把代码改坏、确认脚本 `exit 1` 并打印可读原因，再恢复。共 10 项：

| 改坏的地方 | 捕获到的断言 |
| --- | --- |
| `run-history-head` 加回 `table` | `schedule history header is one row of five cells` / `…display is not table-cell` / `…lines up with the body row`（3 条：66,66,66,66,66） |
| 用量页把 近 7 天 当基线（旧行为） | 页面时钟前移 +40 天：`weekly=0 all=240`（旧断言原样复现） |
| 协议 badge 改回 wire id | `provider badge shows the protocol's display name, not the wire id` |
| `.dot` 去掉工具类 | `connection-check dot box` + `dots are circles on both sides`（8×0 vs 6×6） |
| `.mono` 去掉 `font-mono` | `every .mono marker renders in a monospace family` |
| `.remote-guard` 去掉 `!` | `remote guard card box` + `…is not plain white`（白底复现） |
| 设备行按钮改回横排 | `every device row keeps a usable name column`（15px / 40 行复现） |
| 用量 stat 卡改名 | `usage stat labels: … is the declared rewrite` |
| 删掉 `.remote-flow` | `gateway mode draws the request path instead of a command` |
| 用量 intro 多一句 | `intro deviation @usage is the declared rewrite` |

失败的运行**不会覆写** `pages.json`（写入 `pages.failed.json`），避免把带违规的报告当成证据提交——修复轮中确实发生过一次。

另有 6 条断言在改动当场就抓到真实缺陷（而非事后构造）：P1-1 表头竖排 66px、表头与行轨宽 15px 不一致、`.dot` 无尺寸、`.remote-guard` 白底、`.remote-layout .card` 10px、`重新检测` 多带图标。

以上脚本重跑会重写各自目录里的 JSON/PNG（会话 id 随机、PNG 字节差），本轮按仓库既有做法在提交前
`git checkout -- docs/evidence` 还原旧目录，只提交本切片的新目录；重跑结果记录在本文件与 issue 评论里。

## 5. 未做 / 未验证（RESIDUAL-UNTESTED，不得当作已完成）

- 真实网络：远程访问的 TLS、Tailscale Serve、自建 Gateway、手机浏览器都没有在本机运行；
  三种模式只是 Host 状态与文案。
- 真实文件系统：能力的来源目录、包内容、MCP 进程、`~/.agents/skills` 均未读取或安装。
- 真实调度：没有注册系统计划、后台唤醒或真实触发；`立即运行` 走的是 Host 内存投影。
- 真实 Provider 调用：用量页的 token 数来自 `memoryHost` 记账，不是供应商账单。
- 真实清理/归档：`预览清理清单` 只预览，不删除磁盘内容；`恢复任务` 不启动服务或重新启用调度。
- **修复轮未覆盖的残余**（按 reviewer 清单逐项处置，均已在上文给出实修或声明）：
  - 评审 P2-4 的 `这台电脑的名称` / `启用此入口` 两项不是“未做”，而是 Host 无字段/无写接口，属 §3.19 的声明；在 Host 提供对应能力前不会实现。
  - 评审 P2-6 的“renderer 给原型没有图标的行按钮加了图标”保留为 §3.21 的声明（本次只把新按钮 `重新检测` 的图标去掉，与原型一致）。
  - `usage` intro 的“样例数据”与“本应用记录”两句是产品文案，最终文本请以用户裁决为准（与 D5 同属待裁决项）。
- Electron GUI 冒烟、打包运行仍未验证（沿用 epic 既有的 RESIDUAL-UNTESTED 清单）。
