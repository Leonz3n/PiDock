# 试点环境实测记录（2026-09-23）

状态：supervisor 于 2026-09-23 在用户指定的试点环境上执行了**真实登录与页面探查**，
用于把 [对账单详情同步查询](pilot-synchronous-query.md) 的候选链路落到可复现的路径。
这是**诊断性探查，不是 #13 的验收流程**：查询走的是已部署环境的远程 BFF，本工单要求
的本地 BFF／本地 invoice／本地 shipment 未启动，盒子 2–9 仍未证明。

凭据只由 supervisor 在被测浏览器里手工使用，**未写入本仓库、提交、工单或日志**；本文
不记录任何口令、令牌、DSN 或账号标识。探查未启动任何业务服务，未修改试点仓库
（`/Users/adber/workspace/shipber/**` 全程只读）。

证据类别标注：**【实测】**＝本次真实命令／浏览器运行；**【源码】**＝本地仓库源码核对；
**【未定】**＝本次未确认，不猜测。

## 1. 环境入口

- 用户指定的试点环境为 `http://srb.reconcile.adber.tech`（与
  [仓库核对](pilot-repository-inspection.md#试点环境入口由-supervisor-只读探测本次未重复执行)
  记录的静态外壳一致）。**【实测】**
- 外壳是 CDN 上的静态 SPA（`Server: Tengine` + `x-oss-*`，`<title>shipber-saas</title>`），
  业务接口**不在**该主机上：API 基址为 `http://api.reconcile.adber.tech:30080`，
  REST 路径位于 `/shipber/uc/...`、`/shipber/common/...`，GraphQL 端点为同一基址下的
  `POST /graphql`。**【实测】**
- 登录路由是 `/sassLogin`（注意拼写），页面为邮箱＋密码两项，本次未见验证码。**【实测】**

## 2. 登录链路

真实登录成功，按顺序观察到（均为 200）：**【实测】**

1. `POST /shipber/uc/auth/login`
2. `POST /shipber/uc/tenant/user/current`
3. `GET /shipber/uc/resource/user/tree?rootParentCode=shipberSaas` — 动态权限菜单，本次
   租户返回 341 个节点
4. `GET /shipber/common/custom/config/get?code=collectMenu`
5. 登录后 GraphQL 走 `POST /graphql`（例如 `platformAgreementUserCheck`、`GetTaskProgresses`）

会话令牌由应用保存在 `localStorage` 的 `GlobalState`（字段 `.token`），另有 `TabsState`。
这意味着「已登录状态」属于浏览器剖面，不能靠写死 URL 复原；菜单同理由上面的资源树动态
注册，源码里没有可用于通用入口的固定页面地址。**【实测】**

## 3. 导航模型

- 左侧是 64px 图标栏 `.aside-split`，条目为 `.split-list .split-item`，图标形如
  `svg use[href="#icon-<name>"]`；**标签只出现在 hover 提示里**，DOM 中没有菜单文字，
  按文本选择器定位会失败。**【实测】**
- 本次观察到的图标与标签：`icon-shipment`＝运单、`icon-data-box`＝账单管理、
  `icon-fulfillment`＝财务中心、`icon-employee-icon`＝客户管理、`icon-star-uncheck`＝我的收藏。**【实测】**
- 点击图标后展开第二级 aside（240px），其中的条目才是模块子菜单（例：账单管理 →
  账单列表／对账单／账单明细）。**【实测】**
- 模块按需加载微前端：进入账单管理后加载 `/tms-web/assets/js/...` 资源，路由变为
  `/tms-saas/SaasBillMgt/reconciliationList`。**【实测】**
- 定位菜单项时，图标上的 Element Plus tooltip 会在点击瞬间遮挡第二级条目并拦截指针事件；
  实测需要先把鼠标移开后用脚本点击，否则 `locator.click` 一直超时。**【实测】**

## 4. 对账单列表（账单管理 → 对账单）

**【实测】** 页面为 `/tms-saas/SaasBillMgt/reconciliationList`，表头为
服务商账号／对账单号／账单日期／对账状态／账单金额／匹配金额／跟踪单／匹配度／对账完成度／
更新时间／标签／对账金额／操作；搜索框占位符为「搜索服务商账号或对账单号」。

- 列表与汇总用的是同一个 GraphQL 操作 `ReconciliationListSummary`，变量形如
  `{filters:{currentPage,pageSize,invoiceDate:{gte,lte},searchText}}`；默认日期窗口
  （约 3 个月）返回 0 行，必须在搜索框填入单号才会命中。**【实测】**
- 用户 2026-09-23 指定的对账单为 **`000000K1013A336`**（服务商账号 `K1013A`，账单日期
  08/15/2026，对账状态「已对账」，跟踪单 23，匹配度 23/23）。金额数据不记录。**【实测】**
- 该列表**不是**详情入口：对账单号单元格是可复制控件，行的操作列只有 csv／pdf 下载图标，
  点击单号不打开详情弹层。**【实测】**

## 5. 详情链路（源码核对：消费流水 → 详情 → `GetReconciliationInvoices`）

**【源码】** 详情由「消费流水」页面的关联服务号链接触发，而不是上面的账单管理列表：

1. 消费流水页面：`front-monorepo/apps/saas-legacy-web/src/disco/views/sass/ucenter/tenantMgt/subscribe/flowLog/index.vue`。
   当 `row.businessType === 'RECONCILIATION'` 且 `row.relatedServiceId` 不是 `system`／
   `System Upgrade` 时，remark 列渲染可点击链（`:301`），点击调用
   `previewReconciliationDetail(row.relatedServiceId)`（`:644-646`）。
2. 该函数调用详情组件的 `openInfo({ invoiceNumber, type: 2 })`；组件挂载于同文件 `:327`，
   定义在 `front-monorepo/apps/saas-legacy-web/src/businessComponent/PreviewReconciliationDetail/index.vue`
   （`openInfo` 在 `:432`）。
3. 详情组件用 `useGetReconciliationInvoicesLazyQuery`（同文件 `:268` 导入、`:298` 解构）发起
   `GetReconciliationInvoices($after, $first, $filter)`：
   `front-monorepo/apps/saas-legacy-web/src/api/graphql/reconciliation.graphql:30`，返回
   `reconciliationInvoices.nodes{invoiceAmount,invoiceNumber,carrierCode,accountNumber,
   totalMatchedShipments,totalTrackingNumbers,reconciliationStatus,totalReconciledShipments,
   shipmentAccount{accountNumber},logisticsInvoice{invoiceDate,parsingStatus,isArtificial},
   charges{name,netChargeAmount,categoryCode}}`。
4. 菜单节点：`订阅管理`（在本次资源树中 code `subscribeManager`，path
   `/shipberSaas/ucenter/subscribeManager`），子项为 `订阅概况`、`流量日志`（`trafficLog`）、
   `流量日志`（`usageRecord`）。**【实测＋源码】**
5. 该页在 saas-legacy-web 的路由为 `/saas-web/ucenter/subscribeManager/usageRecord`
   （详情路由 `.../usageRecord/detail`）：`front-monorepo/apps/saas-legacy-web/src/routers/index.ts:1086-1097`。**【源码】**

**【未定】** 从图标栏到「订阅管理」的**可见菜单点击路径**本次没有最终确定：底部设置入口
（`disco/layouts/index.vue` 的 `.power-box` / `blue-setting` → `showSetting`）在多次尝试中
只稳定弹出「业务设置／物流设置／打印设置／自动化设置／对接设置／账单设置／财务设置」分组，
未定位到订阅管理所在分组，探查因此中止。真实运行时必须在任务浏览器里用可见菜单落定这条
路径并记录页面地址，不能改用直接地址跳转，也不能把它当成已确认。

## 6. 本地运行前置条件（本机实测）

- **GUI 可用**：headless 与 headed Chromium 均可启动（headed 真实开窗成功），因此
  Electron GUI 运行在本机可行。**【实测】**
- **PiDock 仓库尚未安装 Electron**：`node_modules/electron` 不存在，启动应用前必须先安装。**【实测】**
- **本地 Redis 未监听**：`127.0.0.1:6379` 无监听；invoice 的 reconcile 配置使用该 Redis 的 db 2。**【实测】**
- 远程 MySQL `114.242.60.59:30881`、远程 RabbitMQ `114.242.60.59:30672` TCP 可达。**【实测】**
- `go1.27.1 darwin/arm64` 已安装（试点仓库声明 Go 1.26.0，满足）。**【实测】**

## 7. 安全与合规标记（必须先确认再启动本地服务）

用户指定的 invoice reconcile 配置是仓库外的本地文件
`/Users/adber/workspace/shipber/invoice-service/.vscode/reconcile.yaml`（未跟踪）。按 key 名
核对后记录如下，**不复制任何口令、DSN 或连接串**：**【实测】**

- MySQL 指向数据库 `shipber_prod_restore`，即**生产还原库**，不是干净的测试库。
- RabbitMQ 指向**共享 vhost**（`.../leon_vhost`）。`docs/pilot-repository-inspection.md`
  已警告：共享队列时本地产生的任务可能被远程 worker 取走、反之亦然。
- 同一文件里 `shipment_service_v1.addr` 写的是 `dns:///127.0.01:9000`（`127.0.01` 是笔误，
  不可解析），与文档记录的「env 与 config 漂移」一致。

结论：**用这份配置启动本地 invoice 不是「非生产环境」的干净组合**，可能读写生产数据并与他人的
队列互相消费。工单要求的是非生产环境，因此本地服务启动前必须由用户明确接受或改用隔离的库／
vhost，不能默认按现状开跑。

## 8. 本次证明了什么、没有证明什么

已证明（诊断层）：环境可达、真实登录链路与动态菜单可用、对账单 `000000K1013A336` 在该
环境的账单管理列表中真实存在、详情链路的源码入口与 `GetReconciliationInvoices` 字段在本地
仓库中成立、本机具备 GUI 与 Go 运行条件。**【实测＋源码】**

未证明（#13 的验收内容）：盒子 2–9 全部未通过——没有本地 BFF／invoice／shipment 实例，
没有本地 RPC 日志与网络目标的关联，没有在 PiDock 任务浏览器内完成的操作，没有双任务隔离
对照，也没有「修改后重新加载」的实例归属证据。上述远程链路结果**不能**替代本工单要求的
本地闭环。**【未定】**
