# #47 S8：四页原型 A 对照登记

这份文件记录生产页与 `prototypes/pidock-ui/` 原型 A 的元素对照、当前 Host 接线依据和明确缺口；**不是“已对齐完成”的验收结论**。只核对「环境与服务」「本机设置」「能力管理」「需要处理」四页。原型源码注释声明其数据与操作只保存在内存中，不能作为真实 Host 数据依据。

分类：**(a)** 有真实 Host op 且已在生产页渲染；**(b)** Host 已有相关能力或可由渲染层完成，但本片不接；**(c)** Host 没有该能力的 op，页面必须说明缺什么。`file:line` 均指本仓库源码；原型的定义行以 Prototype A 当前实现为准。

## 环境与服务

原型元素见 `prototypes/pidock-ui/app.js:75`、`management.js:31-35,60`；生产差异见 `packages/renderer/src/components/DesktopEnvironmentPage.tsx:211-258`。

| 原型 A 元素 | 分类 | 生产现状 / 依据 |
|---|---|---|
| 项目选择、关联任务数 | (a) | 生产页使用应用的项目与任务上下文；`DesktopInventory.tsx:398` 将它们传入页面，项目 Host bridge 为 `projectOp`（`shellBridge.ts:33`，主进程 `runtime.ts:2021-2029`）。 |
| 环境选择、列出与新增环境 | (a) | `serviceCatalogOp` 的 `listEnvironments`、`createEnvironment`：页面读取/创建 `DesktopEnvironmentPage.tsx:150-168,187-208`；Host 分支 `service-catalog-ipc.ts:331-343`。环境只在获得 Host 回执后显示。 |
| 管理环境（重命名、删除） | (c) | 原型管理对话框见 `management.js:31-34`。生产按钮仍禁用，且页面可见登记说明 Host 环境目录操作仅列出与创建：`DesktopEnvironmentPage.tsx:215,220`。缺少环境重命名与删除 op。 |
| 从 `.vscode` 导入 | (c) | 原型按钮见 `app.js:75`。生产没有从 `.vscode` 自动导入/写入 op，因此不声称整段导入已接线。生产另外提供只读仓库草案扫描，是不同、受限的已接线能力，见下行。 |
| 任务、共享、本机私有配置作用域按钮 | 任务覆盖与通用私有变量：(c)；共享作用域切换：(b) | 按钮保持禁用。具名登记位于 `DesktopEnvironmentPage.tsx:246-251`：Host 无项目环境变量/任务覆盖和通用本机私有变量表；共享服务配方本身虽已接线，但环境变量作用域切换未接。 |
| KEY / VALUE / 生效来源表格、编辑、新增、删除、保存及模板差异预览 | (c) | 表格不填样例值，明确登记缺少项目环境变量表、任务覆盖及敏感值遮蔽后的生效配置读取操作：`DesktopEnvironmentPage.tsx:252-254`。上述内容不是共享服务配方表。 |
| 服务启动配方列表、添加/编辑及任务绑定 | (a) | 真实服务模板由 `serviceCatalogOp` 的 `list/create/update` 返回并渲染：`ProjectServiceTemplates.tsx:125-150,274-305,321-355`；Host 操作分支 `service-catalog-ipc.ts:345-386`。任务绑定入口由 `TaskServiceBinding.tsx:57-103` 调用 `taskBindings/bind/adoptBinding`；没有展示原型样例服务。 |
| 查看模板更新、审阅差异后应用 | (a) | 更新使用 `serviceCatalogOp {op:"update", confirm:false|true}`，先核对 Host 差异再写入：`ProjectServiceTemplates.tsx:295-355`、`service-catalog-ipc.ts:364-386`。 |
| 本片新增/生产替代项：仓库配置草案扫描 | (a) | 生产只读取所选任务 worktree 的根与配置候选，遮蔽值；填入表单不自动保存/绑定/启动。`task/fileRoots`、`task/serviceImportHints` 与渲染见 `DesktopEnvironmentPage.tsx:36-73,91-105`；Host 操作名在 `shellBridge.ts:143-145,890-905`。 |

## 本机设置

原型设置弹窗见 `prototypes/pidock-ui/app.js:83`；生产页见 `packages/renderer/src/components/DesktopSettingsPage.tsx:162-184`。

| 原型 A 元素 | 分类 | 生产现状 / 依据 |
|---|---|---|
| 应用配置目录 `~/.pi/dock`、配置文件路径及平台说明 | (c) | 原型路径是示意值；生产不猜路径，并明确 Host 无应用配置目录读取操作：`DesktopSettingsPage.tsx:170-175`。 |
| 默认任务根目录输入、目录选择、仅影响新任务的说明、保存 | (c) | 页面保留禁用输入和选择/保存控件，分别标明 Host 无默认任务根目录读取、目录校验、选择和保存操作：`DesktopSettingsPage.tsx:177-182`。未接线不能读成已配置或保存失败。 |
| 本片外、已接线的外部编辑器设置 | (a) | 生产新增的外部编辑器读/保存/清除通过 `shell/editorSettingsOp`，主进程入口 `runtime.ts:1991-2004`，渲染桥接与请求 `editorSettings.ts:43-77`；页面标注「外部编辑器已接线」`DesktopSettingsPage.tsx:167`。这不是原型猜测的配置目录或默认任务根接口。 |

## 能力管理

原型分类、汇总、列表、启停、详情及安装入口见 `prototypes/pidock-ui/capabilities.js:28-33`；生产页见 `packages/renderer/src/components/DesktopCapabilitiesPage.tsx:6-39`。

| 原型 A 元素 | 分类 | 生产现状 / 依据 |
|---|---|---|
| Skills、MCP Servers、Extensions、Packages 分类 | (c)（分类按钮本身只切换本地标签） | 同名标签可浏览，但没有 Host 清单数据。每个分类面板都明确说明缺少该类别真实清单、来源、运行时状态读取以及添加/安装/启停操作：`DesktopCapabilitiesPage.tsx:30-37`。 |
| 四类数量/已启用摘要 | (c) | 原型数字来自内存样例；生产不显示 0 或样例数字，四项显示「未接线」，每类缺口说明见 `DesktopCapabilitiesPage.tsx:25-28,35-37`。 |
| 能力来源、作用域、风险、状态、详情和启停 | (c) | Host 没有能力清单/来源/运行时加载 op；因此生产不造清单行，添加按钮禁用：`DesktopCapabilitiesPage.tsx:22,35-37`。 |
| 添加 Skill、MCP Server、Extension、安装 Package | (c) | Host 没有能力登记、安装、更新或启停操作；页面按钮禁用且面板具名解释原因：`DesktopCapabilitiesPage.tsx:22,35-37`。 |
| MCP 的受控桥接说明、Prompts / Resources | (c) | 当前 Host 无能力清单/运行时操作，也无 Prompts / Resources 操作；生产说明见 `DesktopCapabilitiesPage.tsx:33,37`。 |

## 需要处理

原型跨项目待处理弹窗及「打开会话」见 `prototypes/pidock-ui/closure.js:15-16`；生产专页见 `packages/renderer/src/components/DesktopAttentionPage.tsx:63-79`。

| 原型 A 元素 | 分类 | 生产现状 / 依据 |
|---|---|---|
| 跨项目待确认、失败、确认过期、完成未读记录与分组 | (a) | Host `task/attention` 提供真实账本记录，生产解析/分组后渲染；`DesktopAttentionPage.tsx:14-49,75-79`、bridge `shellBridge.ts:829-839`、Host 白名单 `packages/shell/src/rpc/protocol.ts:289-292`。任务清单的生命周期核验也作为页面前置状态。 |
| 项目、任务、会话、状态与记录详情 | (a) | 使用 Host attention payload 的任务名/会话/状态/详情；`DesktopAttentionPage.tsx:20-33,63-64`。错误单独报告，不作为“没有事项”。 |
| 打开记录所处会话 | main：(a)；非 main 原会话：(c) | main 项打开任务的 SDK main 会话，`DesktopAttentionPage.tsx:63-67`、`DesktopInventory.tsx:399`、`sdkSession.ts:7,48`。非 main 原会话保留禁用按钮，并可见说明缺少 Host 恢复/定位操作：`DesktopAttentionPage.tsx:66,72-73`。 |
| 刷新及完成未读的标记已读（生产新增） | (a) | 刷新重新读账本；仅完成未读项使用 `task/markAttentionRead`，并核验 Host 清除回执：`DesktopAttentionPage.tsx:51-61,71`、`shellBridge.ts:858-870`、Host 白名单 `protocol.ts:289-292`。查看会话不会自动标记已读。 |

## 本片未接，等待 Host 侧能力

以下是当前 Host 语义下的明确天花板。本片只做可见登记，没有增加 Host/RPC op、没有扩充 `ShellTaskOp`，没有以假数据代替真实清单。当前 renderer task-op 集合见 `shellBridge.ts:108-167`，Host 允许集合见 `packages/shell/src/rpc/protocol.ts:225-317`；已存在的 `serviceCatalogOp` 环境操作仅列出和创建，见 `service-catalog-ipc.ts:331-343`。

1. **项目环境变量配置**：Host 缺少项目环境变量表、任务覆盖、通用本机私有环境变量表、敏感值遮蔽后的生效配置读取，以及对应保存/变更预览操作。生产以具名空态呈现，不显示 KEY/VALUE 样例。共享服务模板操作不等同于这些变量层。
2. **环境管理和作用域**：Host 环境目录没有重命名/删除操作；也没有项目变量的任务/共享/本机私有作用域切换操作。原型 `.vscode` 的整段导入/写入也没有 Host op。生产仓库扫描只读，候选需人工填入真实服务模板表单。
3. **本机目录设置**：Host 没有应用配置目录的权威读取接口，也没有默认任务根目录的读取、目录校验/选择、保存接口；生产不把原型 `~/.pi/dock` 或输入占位符伪装成现值。
4. **能力库存**：Host 没有 Skills、MCP Servers、Extensions、Packages 的清单/来源/作用域/风险/运行时状态接口，也没有注册、安装、更新、启停接口。Prompts / Resources 同样无对应操作。
5. **旧会话定位**：Host/SDK 当前没有从这些非 main 记录恢复或定位原会话的操作；生产只开放已支持的 main 会话入口，保留其余记录并说明原因。

## 已接线登记

- 项目上下文来自应用项目 Host 通路；项目环境列表/创建：`shell/projectOp`、`shell/serviceCatalogOp {op:"listEnvironments"|"createEnvironment"}`。
- 项目选定环境的服务配方列表、创建、差异审阅/更新与任务绑定：`shell/serviceCatalogOp {op:"list"|"create"|"update"|"taskBindings"|"bind"|...}`；操作/确认仍以主进程为准。
- 仓库配置候选只读扫描：`task/fileRoots`、`task/serviceImportHints`；仅显示 Host 扫描结果，敏感值遮蔽，不自动写入。
- 外部编辑器：`shell/editorSettingsOp` 的 read/save/clear；只针对外部编辑器设置，不代表应用配置目录/默认任务根接线。
- 需要处理账本：`task/attention`、`task/markAttentionRead`；main 会话由 renderer 导航打开。

## 双尺寸真实 Host 截图

截图来自 `electron-issue47-shell-capture.mjs`：启动生产 Electron 与 Host，文件名里的 `1440x900` / `720x560` 指窗口逻辑 viewport；Electron 以 2x device scale 写入未裁剪 PNG（分别为 2880×1800 / 1440×1120 像素）。capture harness 会在隔离临时目录创建合成项目/任务/服务模板以驱动真实页面与 Host 通路；这些不是用户数据或产品示例，截图不证明该服务在真实工作区运行。四页缺口仍按 Host op 清单呈现；能力页不填样例，未接功能不被表示成可用。只更新本片四页，其他页面证据未改。Harness 对所有截图测得 `overflow`、`overflowClient`、`overflowContent` 均为 0。Capture 命令 exit code 为 0，但同时有 task-op 错误诊断：`工作树没有可读取的 HEAD 提交`、`unknown-service`、`navigation-denied`；不把这些错误日志当成任一能力已接通或截图无误的额外证据。

| 页面 | 1440×900 | 720×560 |
|---|---|---|
| 环境与服务 | [1440x900-environment-page.png](1440x900-environment-page.png) | [720x560-environment-page.png](720x560-environment-page.png) |
| 本机设置 | [1440x900-settings-page.png](1440x900-settings-page.png) | [720x560-settings-page.png](720x560-settings-page.png) |
| 能力管理 | [1440x900-capabilities-page.png](1440x900-capabilities-page.png) | [720x560-capabilities-page.png](720x560-capabilities-page.png) |
| 需要处理 | [1440x900-attention-page.png](1440x900-attention-page.png) | [720x560-attention-page.png](720x560-attention-page.png) |
