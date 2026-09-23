# 首个真实用例：对账单详情同步查询

状态：用户已接受同步查询方向，以下具体路径由源码核对选定；尚未登录、发送请求或运行业务服务。试点仓库路径为 `/Users/adber/workspace/shipber/`（用户 2026-09-23 指定，源码链接已按此路径改写并复查，见 [仓库核对](pilot-repository-inspection.md#2026-09-23-重新核对用户指定路径)）。

## 业务操作

用户在任务内浏览器登录现有 SaaS（2026-09-23 指定的试点环境为 `http://srb.reconcile.adber.tech`），进入订阅消费流水。Agent 找到一条用户有权查看的既有对账单记录，点击关联账单号，在详情弹层观察已有数据。该用例不要求新增账单、发起对账或启动后台 worker。

该环境的静态前端外壳已确认可访问，但本用例的判定要求查询经本地 BFF、本地 invoice 与本地 shipment 并有关联 RPC 证据，所以任务浏览器必须指向任务内的本地服务：BFF 地址除 `VITE_BFF_URL` 外还存在 localStorage 覆盖（[client.ts](/Users/adber/workspace/shipber/front-monorepo/apps/saas-web/src/graphql/client.ts:153)），只改构建变量无法证明页面已不再调用远程地址。静态外壳可达不构成盒 2–9 的任何证据。

页面由后台菜单动态注册，源码没有可作为通用入口的固定 URL。登录后以实际菜单进入，并保存当前环境的页面路径；不能臆造一个账单 URL。

## 已核对的请求链路

1. 消费流水点击关联服务编号，打开 `PreviewReconciliationDetail`：[flowLog/index.vue](/Users/adber/workspace/shipber/front-monorepo/apps/saas-legacy-web/src/disco/views/sass/ucenter/tenantMgt/subscribe/flowLog/index.vue:301)，打开逻辑位于同文件 644 行。
2. 详情组件发起 `GetReconciliationInvoices`，使用账单号过滤、取一条：[详情组件](/Users/adber/workspace/shipber/front-monorepo/apps/saas-legacy-web/src/businessComponent/PreviewReconciliationDetail/index.vue:432)、[GraphQL query](/Users/adber/workspace/shipber/front-monorepo/apps/saas-legacy-web/src/api/graphql/reconciliation.graphql:30)。
3. SaaS BFF 的 `reconciliationInvoices.nodes` 调用 invoice 的 `ListReconciliationInvoices`：[connection resolver](/Users/adber/workspace/shipber/front-monorepo/apps/saas-bff/src/modules/invoice/reconciliation-invoice/reconciliation-invoice-connection.resolver.ts:40)。
4. invoice 同步查询仓库并返回：[service](/Users/adber/workspace/shipber/invoice-service/internal/service/reconciliationinvoice.go:33)、[业务查询](/Users/adber/workspace/shipber/invoice-service/internal/biz/reconciliationinvoice.go:1284)。该列表查询本身不入队。
5. 详情中的 shipmentAccount 等字段通过 shipment 的 `batchGetAccounts` 解析：[shipment-account loader](/Users/adber/workspace/shipber/front-monorepo/apps/saas-bff/src/modules/transport/shipment-account/shipment-account.loader.ts:17)。物流账单和费用字段继续同步调用 invoice。

登录校验仍依赖远程 account 服务，消费流水页面还会访问所选环境中的其他服务。这些依赖需要可达，但不要求全部本地启动。

## 候选运行组合

- 本地：SaaS legacy 主壳、SaaS BFF、invoice 主服务、shipment 主服务；页面实际涉及 React 子应用时再选择该子应用。
- 远程：现有登录/账号及消费流水所需服务，数据库、缓存等按已确认环境策略复用。
- apis：初次查询保持消费者发布依赖；另设协议变化用例验证本任务生成与绑定，避免把最新协议兼容性混入首次业务启动。
- worker、scheduler 与一次性业务脚本不参与这个查询用例。

## 操作验收

1. 创建两个包含相同试点仓库的任务，给各自服务分配不同本地端口，记录代码与配置版本。
2. 用户在任务一的浏览器完成登录；Agent 通过可见菜单进入消费流水并打开已有对账单详情。
3. 详情展示来自本地 BFF 的同步查询结果。网络目标指向任务一实例，响应中没有被 UI 忽略的 GraphQL 错误。
4. invoice 查询及 shipment 账户查询的本地日志与当前页面请求关联；证明没有通过旧 REST 或另一个任务完成主要查询。
5. 任务二重复该操作，确认浏览器状态和运行资源独立。既有查询数据可以相同，共享数据库内容不是隔离失败的判据。
6. 任务一的代码发生相关修改并重新编译/启动后，再次执行同一查询；结果归属新的运行实例，任务二继续使用自己的代码。

## 运行归属证据

- 浏览器保留 operation、任务入口、响应状态及必要的错误信息。
- BFF 的 TraceIdInterceptor 在有 active span 时返回 `trace-id`：[interceptor](/Users/adber/workspace/shipber/front-monorepo/apps/saas-bff/src/common/interceptors/trace-id.interceptor.ts:24)。实际是否存在需要运行核对，不把缺省 trace 当成成功关联。
- BFF 向下游透传 OTel trace；invoice 日志含 RPC operation、code、latency、service/version 和 trace 信息：[middleware](/Users/adber/workspace/shipber/invoice-service/internal/server/middleware.go:47)。
- PiDock 将日志关联到已登记的 cwd、进程身份、监听端口、构建来源和代码状态。代码状态包括未提交修改，不能只记录 Git HEAD。
- 当前没有直接返回精确代码版本的统一业务响应字段；若现有日志不足以消除歧义，应将验证标为证据不足，而不是只凭成功响应宣称已验证当前修改。

## 不能作为完整验收的替代

- 普通对账单列表走旧 REST：`axiosInvoiceList` 调用 `/reconciliation-invoice/list`，不能证明本地 invoice RPC 工作：[billMgtPort.ts](/Users/adber/workspace/shipber/front-monorepo/apps/saas-legacy-web/src/api/modules/billMgtPort.ts:68)。
- 如果完整页面暂受远程依赖阻塞，可以在相同登录上下文做直接 GraphQL 查询来定位服务问题，但只能报告接口验证结果，不能标记浏览器页面闭环完成。
- 该同步用例不证明消息任务或 DTM 回调已隔离；这些保持独立验收。
