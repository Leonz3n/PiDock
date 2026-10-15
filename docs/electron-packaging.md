# Electron 打包（S6 候选产出）

## 当前需求与候选（#95 / #97）

桌面内置终端已按业主要求撤销：正式桌面工具栏/面板不再挂载终端，主进程拒绝旧终端 IPC。内存演示与兼容组件测试保留，不能作为当前桌面功能或发布验收。Agent SDK 的命令执行及任务进程归属/退出回收继续保留。

当前版本候选为 **0.1.6**，用于 Windows x64 **内部/自用、未签名 MSI**：#97 修复冷启动重开任务后，生命周期写入将 Windows 等价分隔符误判成任务归属不匹配、导致退出重试后 exit 1。采用既有路径身份规则比较，不迁移或重写 task.json，不放宽任务 ID/真实目录/链接与外来任务拒绝校验。

当前已核验安装为 **0.1.5**（PR #96 已合并，exe/asar 与候选一致），业主已确认无终端入口且可以退出，并接受 1 秒内退出；三次空闲实例全部观察进程在 0.103–0.109s 退出。但随后隔离的真实任务验收复现了上述重开退出失败，不能将空闲基线沿用到任务场景。0.1.6 构建/安装证据归 #97/#92；本次不自动关闭或替换用户应用。0.1.2 服务归属拒绝、0.1.3 `8009001d` 与 0.1.4 未确认的终端行为仍为历史，不改记为通过。

当前安装验收检查应用启动、任务/会话、文件浏览/预览/差异/外部编辑器及退出收敛；不再要求在 MSI 内运行内置终端。#80 对外签名/macOS 仍暂停，#88 中断任务不在本次处理。下列按日期记录的终端载荷与旧版终端观察均属历史。

日期：2026-09-22（Asia/Shanghai）
状态：macOS arm64 **已实测产出未签名 DMG 候选**；macOS 侧 node-pty 原生载荷随包分发已实测（2026-10-13，见「macOS：node-pty 原生载荷随包分发」）；Windows x64 安装资产为 MSI（[ADR 0004](adr/0004-windows-installer-msi-instead-of-nsis-exe.md)，2026-10-13），**已在 win32-x64 主机上实测产出未签名 MSI，并完成安装/启动/覆盖升级/卸载复核**（2026-10-14，见「Windows x64 MSI 实测」）；该主机的代码签名、公证、干净系统安装、多用户账户与 >1 版本升级矩阵**仍未验证**。
实际发布验收归 #15；本文件只记录候选工具链与实测边界。

## 工具链

- Electron `44.4.3`（`packages/shell` devDependency）
- electron-builder `26.15.3`（devDependency）
- 配置：`packages/shell/electron-builder.config.cjs`
- 应用图标（`win.icon`，msi 目标硬必需）：`packages/shell/packaging/icon.svg`
- macOS 授权文件：`packages/shell/packaging/entitlements.mac.plist`
- 签名/公证钩子：`packages/shell/scripts/notarize.cjs`（无 Apple 凭据时空跑）

## 命令

```bash
export PATH="/private/tmp/pidock-pnpm/node_modules/.bin:$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
cd packages/shell
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm package:dir    # 未打包目录候选
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm package:mac    # macOS arm64 DMG
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm package:win    # Windows x64 MSI
```

`electronDist` 在 macOS 目标下复用已安装的 `node_modules/electron/dist`。Windows 默认下载 win32-x64 Electron；若下载失败，可在 Windows x64 主机显式指定已安装且版本匹配的运行时，例如 `CSC_IDENTITY_AUTO_DISCOVERY=false pnpm --filter @pidock/shell package:win -c.electronDist=E:/Workspace/Leonz3n/PiDock/packages/shell/node_modules/electron/dist`。该路径是本机示例；须记录实际命令和 Electron 版本，不更改 MSI 身份或跳过前置 build。

`package:dir` / `package:mac` / `package:win` 各自前置 `pnpm build`（`packages/shell/package.json`）。打包只消耗 `dist/`（`files: ["dist/**/*", "package.json"]`），**不再需要人工先跑一遍 build**：不前置 build 的话，`electron-builder` 会静默把当时磁盘上的 `dist/` 打成包，安装器随之发出过期的 host bundle。

## macOS arm64 实测

- 产物：`packages/shell/release/PiDock-0.1.0-arm64.dmg`
- 体积：`127763304` bytes（约 122 MiB）；`PiDock.app` 目录 `318M`
- sha256：`26f4f4b3096b312b25ab7f2836ef7995466937f04de070a46d89b05b590dde68`
- `hdiutil attach` 挂载成功，卷内含 `PiDock.app` 与 `Applications` 链接
- 未签名（`CSC_IDENTITY_AUTO_DISCOVERY=false`），未公证；`[notarize] skipped`
- 包内 `app.asar` 共 41 个条目，含 `dist/host/host.js`（utilityProcess 入口）、`dist/main/main.js`、`dist/preload/preload.cjs`、`dist/renderer/{index,task}.html`

### 启动时间（打包后 app，`PIDOCK_PRINT_STARTUP=1`）

| 运行 | `processUptimeMs` | `readyToLoadedMs` | 进程 wall time |
| --- | --- | --- | --- |
| 1（首次/最冷） | 466 | 387 | 3.26s |
| 2（预热） | 279 | 222 | 0.58s |
| 3（预热） | 283 | 228 | 0.42s |

`shellUrl` 为 `file://…/PiDock.app/Contents/Resources/app.asar/dist/renderer/index.html`，证明 shell 页面确实从包内 asar 载入。

### 监听面与访问边界

运行打包 app（窗口模式）后，用 `lsof -nP -iTCP -sTCP:LISTEN` / `-iUDP` 检查主进程与全部渲染/工具子进程：

- **无任何 TCP LISTEN 套接字，也无 UDP 套接字**；进程树为主进程 + 3 个 `PiDock Helper`（GPU/utility，含 utilityProcess 宿主）+ 3 个 `PiDock Helper (Renderer)`。
- 当前 shell 未开放调试端口或本机 TCP 监听；CDP 证据走进程内 `webContents.debugger`（S4/S5），不需要监听端口。
- 若将来启用 `--remote-debugging-port`/远程 CDP，需要重新评估监听面与访问控制。

## macOS：node-pty 原生载荷随包分发（2026-10-13 实测）

命令：`CSC_IDENTITY_AUTO_DISCOVERY=false pnpm --filter @pidock/shell package:dir` → `packages/shell/release/mac-arm64/PiDock.app`（未签名）。本轮打包只用于测量：**本次没有再启动打包 app，也没有在它里面起过终端**（2026-09-22 的启动时间与监听面观测见上节）。对照 2026-09-22 的「41 条目」观测（见上「macOS arm64 实测」，那是当时的观测值；本节为 2026-10-13 复测），当前发行闭包实测为：

- `app.asar`（`@electron/asar` 的 `listPackage`）：**11790** 条目，其中含 `node_modules` 的 **11501** 条、含 `dist/host` 的 113 条；`node-pty` 相关 198 条，含 `node_modules/node-pty/build/` 的条目 **0** 条。
- `app.asar` 100956265 B，sha256 `928a2b66ccb5fbd687a83ff53439fd5feb3d8a7ca9d9e25f2ca82070b6dfb86f`。
- `app.asar.unpacked/node_modules/` = `node-pty`、`@earendil-works/pi-tui`、`@esbuild/*`、`esbuild`（`ls`）；`node-pty/` 下没有 `build/`、`lib/build/`、`lib/prebuilds/`——即终端预检拒绝的全部 5 个竞争加载目录都不在包里。
- 被钉住的预编译件（`stat -f '%N %Lp %z'` + `shasum -a 256`）：`prebuilds/darwin-arm64/pty.node` **85496** B、mode **644**、sha256 `e6457d66f45af3facd02920a5b212164e80fe0bb758afe6e6eab1eceeba3fc9a`；`prebuilds/darwin-arm64/spawn-helper` **50480** B、mode **755**、sha256 `21c589109bca43e287df884f3c34ab888033a83927ea7d273949ac5030583f26`。这组值与 `packages/shell/src/host/node-pty-preflight.ts:9-10` 的常量逐位一致。

也就是说「pi 依赖与原生模块的随包分发尚未验证」这句话在 **macOS** 上已被上述实测取代：载荷确实被收集、被解包成磁盘上的真实文件，并且正是预检钉死的那两份字节。**Windows 侧的打包载荷已在 win32-x64 主机上观测到同样形态**（见「Windows x64 MSI 实测」）。

> **更新（2026-10-14，#55 / #61）**：本节末尾原先写的「**产品内**那一次 spawn 仍不通过」**已被 #55/#61 取代**。#55 让预检 pin 记录接纳 `win32-x64` 且 `ptySpawnerAvailable()` 在该平台为 true；#61（`9ec1a25`）修掉了让产品路径根本起不来终端的根因（`plan.cwd` 在 win32 上混用分隔符，与驱动的 `normalize(cwd) === cwd` 契约冲突）。win32-x64 上现在有自动化的真实 PTY 用例覆盖 Host 记录 → plan → 会话层 → 驱动 → 真实 ConPTY（`packages/shell/src/host/terminal-sessions.test.ts` 的 `win32RealIt`）。**仍未验证**的边界保留在下面「未完成 / 边界」：没有在**已安装的 MSI 应用内**跑过终端（打包 app 的产品路径在 `9ec1a25` 之后未复测）。本行只记录事实，不代 `#22` 勾选 T4。

### 为什么固定 `asarUnpack` 与 `npmRebuild: false`

- `asarUnpack: ["node_modules/node-pty/**"]`（`packages/shell/electron-builder.config.cjs:49`）：预检要用 `O_RDONLY | O_NOFOLLOW` 打开载荷并复检 `fstat`（size/sha256/mode），所以被审计的文件必须是磁盘上的真实文件，而不是只存在于 archive 里的成员。实测对照：同一份配置去掉该键（`-c.asarUnpack=[]`）产出的 `app.asar` 与它**逐字节相同**（同为 11790 条目、同一 sha256、同一 unpacked 文件列表），因为 builder 的 smart-unpack 遇到 `.node` 载体时本来就会整包解出（`app-builder-lib/out/asar/unpackDetector.js`）。因此这条键是**确定性 pin**：把被审计载荷的解包固定下来，不随启发式规则漂移，而不是今天的行为差异。
- `npmRebuild: false`（`packages/shell/electron-builder.config.cjs:59`）：默认的重编译步骤 `@electron/rebuild` 会把 node-pty **从源码**编译进 `<package>/build/Release/{pty.node,spawn-helper}` 并随包发出，而 node-pty 自己的加载顺序（`node-pty/lib/utils.js:19`：`['build/Release', 'build/Debug', 'prebuilds/<platform>-<arch>']`；`:17` 是 `loadNativeModule` 声明、`:18` 是其注释）优先选它，终端预检则把 `build/Release` 当作竞争加载目录拒绝（`packages/shell/src/host/node-pty-preflight.ts:69-76`）。两者叠加的结果是：**留着默认值就会给每个包一份预检必拒的载荷，终端每次启动都 `preflight-unavailable`**。
- 实测 before/after（同一命令、同一主机、离线、未签名）：默认配置的包 `• executing @electron/rebuild … moduleName=node-pty`（`/tmp/pack-before.log`）→ 11794 / 11505 / 202 条目，`build/` 4 条；设 `npmRebuild: false` 后 `• skipped dependencies rebuild reason=npmRebuild is set to false`（`/tmp/pack-after.log`）→ 11790 / 11501 / 198 条目，`build/` 0 条（条目数按 总 / 含 `node_modules` / 含 `node-pty` / 含 `node-pty/build/` 计）。
- 没有其他随包发出的原生模块需要 Electron ABI 重编译：node-pty 1.1.0 是 N-API（`node-addon-api` ^7.1.0，darwin-arm64 `pty.node` 引用 38 个 `napi_*` 符号），`@earendil-works/pi-tui` 通过 `dlsym` 解析 N-API 且自带 prebuild，`esbuild` 是独立可执行文件。
- **批准出处**：本条决策由父会话在 macOS PTY 打包切片中于 2026-10-13 批准，依据是该切片的实测证据（即本节与上面的包内测量）；本节就是该批准的 in-repo 记录（工单 #15）。
- **项目级代价**：`npmRebuild` 是顶层键，因此**所有平台、所有原生依赖都不再重编译**（含 Windows MSI 路径）。将来若引入非 N-API、确实需要 Electron ABI 重编译的原生依赖，它与预检的 pin 设计直接冲突（与「签名改写原生字节」属于同一类冲突），只能先决策，不能靠重新打开 `npmRebuild` 解决。

### 本节仍未验证的

- **本轮没有启动打包 app**，也**没有任何终端在它里面运行过**（本次没有 Electron GUI 启动、没有 PTY；2026-09-22 的打包 app 启动观测见上节）：载荷能被预检接受，是拿真包在磁盘上的真实文件跑预检得到的（只读，只访问 `app.asar.unpacked/` 下的文件），不是从 app 内部观察到的。
- **Electron 自己的 asar resolver 未执行**：预检接受 app.asar 拼写的前提是「打包 app 里 `require.resolve` 报告 archive 成员」这个文档行为，它由测试注入验证，未经应用实测；若它报告别的路径，预检会按名拒绝（fail-closed）。
- **签名未解决**：`hardenedRuntime` / `entitlements` / `afterSign` 已就位但未执行（无证书），而签名会改写被 pin 的原生 Mach-O 字节，与 `pty.node` / `spawn-helper` 的 sha256/大小 pin 冲突，必须在 #15 的发布路径上先决策（见「签名与公证路径（未执行）」）。

## Windows x64 候选状态

Windows 安装资产为 **MSI**（[ADR 0004](adr/0004-windows-installer-msi-instead-of-nsis-exe.md)，2026-10-13 人工决定），不再是 NSIS 单一 EXE。MSI 已在 **win32-x64 主机**上实测产出并完成安装/启动/覆盖升级/卸载复核（2026-10-14，见「Windows x64 MSI 实测」）；产物未签名。

以下三条是 **darwin-arm64 主机**（2026-09-22）的记录，只说明「这台机器为什么不构建 MSI」，不代表 Windows 主机的状态：

- `release/win-unpacked/` 已产出：`PiDock.exe` 与 `resources/app.asar`（41 条目，含 `dist/host/host.js`）；`du -sh` 约 `374M`。
- 2026-09-22 的 **NSIS 单一 EXE 安装器构建失败**（当时目标为 NSIS，该目标已被 ADR 0004 取代）：
  `Cannot spawn …/nsis-3.0.4.1/mac/makensis: Error: spawn Unknown system error -86`。
  原因：该 `makensis` 是 **Mach-O x86_64** 可执行文件，而主机为 **arm64 且无 Rosetta**，因此 `EBADARCH (-86)`。
- 改成 MSI 并不解除该主机的阻塞：MSI 目标需要 WiX `4.0.0.5512.2`（构建时下载，`app-builder-lib/out/targets/MsiTarget.js:73`），非 Windows 宿主还要跑 x86_64 版 Wine（`app-builder-lib/out/toolsets/wine.js`），与本机 arm64 无 Rosetta 属同一类架构问题。因此 MSI 不在 darwin-arm64 主机上构建。

## Windows x64 MSI 实测（2026-10-14，win32-x64 主机）

主机：Windows 11 `10.0.26200` x64、Node `v24.21.0`、pnpm `11.22.0`、**已提升会话**。本轮改动 = `win.icon` 指向 `packages/shell/packaging/icon.svg` + 新增该图标源（见「应用图标」）。逐条命令与原始日志记在 #58 的评论；这里只记录观测。

- **构建**：`CSC_IDENTITY_AUTO_DISCOVERY=false pnpm --filter @pidock/shell package:win`（**仓库配置，无 `-c.win.icon` 覆盖**）→ exit 0；产物 `packages/shell/release/PiDock-0.1.0-x64.msi`，`145801336` bytes，sha256 `e36bc66f80a41868d4c36a302f8968c035c3191f592b7269f1997424d25adc6e`。构建日志首次出现 `• downloaded label=icons-bundle.tar.gz`（落到 `%LOCALAPPDATA%\electron-builder\Cache\icons@1.1.0`）。**这一枚已被 #58 的后续修复取代**：打包脚本先前没有 `build` 前置，因此它可能装的是过期的 `dist/`；修好后用同一命令重建，产物改为 `145801336` bytes、sha256 `78a5c6b22e70b19c5b1707334d7b4706ccfb34f3acaf08075bee0f208d7b3490`（逐条证据见 #58 的最新评论）。
- **安装**：`msiexec /i PiDock-0.1.0-x64.msi /qn /l*v` → exit 0；`APPLICATIONFOLDER = C:\Users\<user>\AppData\Local\Programs\PiDock\`、`MSIINSTALLPERUSER = 1`，全程无 UAC 提升。
- **启动**（已安装副本）：`PIDOCK_PRINT_STARTUP=1 PiDock.exe --print-startup` → exit 0，`PIDOCK_STARTUP_RESULT={"electron":"44.4.3","processUptimeMs":1245,"readyToLoadedMs":255,"shellUrl":"file:///C:/Users/<user>/AppData/Local/Programs/PiDock/resources/app.asar/dist/renderer/smoke.html"}`。
- **覆盖升级**：把 `packages/shell/package.json` 临时升到 `0.1.1`（**不入库**，复核后 `git checkout --` 复原）再构建第二枚 MSI `PiDock-0.1.1-x64.msi`（`145797240` bytes，sha256 `0545439715d2eb9c2e97a3a97aa7e40527c01fad6962eb3c955ccbf6b35f70a7`）。两枚 MSI 的 `UpgradeCode` 相同（`{CDB945E1-46B2-5696-A0EE-65A2309F5245}`，由 `appId` 推导），`ProductCode` 不同（`{6BD892FC-A9D5-48AF-949C-7CFE17FAB3FB}` → `{5320C5E9-99DD-4647-82DD-2F97447FCB2A}`）。在 0.1.0 之上装 0.1.1 → exit 0；日志 `FindRelatedProducts` 报 `Adding WIX_UPGRADE_DETECTED property. Its value is '{6BD892FC-…}'` 并执行 `RemoveExistingProducts`；ARP 只剩一条 `0.1.1.0`（无并列安装）；`%APPDATA%\@pidock\shell` 下的标记文件仍在；升级后的 `PiDock.exe` 启动 exit 0（`readyToLoadedMs` 273），包内 `app.asar` 的 `package.json` 版本为 `0.1.1`。
- **卸载**：`msiexec /x {ProductCode} /qn /l*v` → exit 0（`Removal completed successfully` / `MainEngineThread is returning 0`）；安装目录、开始菜单与桌面快捷方式、ARP 键全部消失，`%APPDATA%\@pidock\shell` 保留。
- **ARP 落 HKLM（观测，不是决策）**：按用户安装（`MSIINSTALLPERUSER=1`，文件与快捷方式都在用户级、无 UAC）却把 ARP 键写在 `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{ProductCode}`；`HKLM\SOFTWARE\WOW6432Node\…` 与 `HKCU\…` 都查不到该条，卸载后也从 HKLM 消失。仓库里没有可改这个 hive 的选项（MSI 模板不写注册表，`perMachine:false` 只发 `ALLUSERS=2` + `MSIINSTALLPERUSER=1`），因此如实记录现象，不解释语义。
- **签名**：`Get-AuthenticodeSignature` 对两枚 MSI 与已安装 `PiDock.exe` 都是 `NotSigned`（`SignerCertificate = <null>`）；构建日志里的 `• signing with signtool.exe path=…` 行照常打印，但本机无证书，实际未签名。

### 应用图标

- `win.icon = "packaging/icon.svg"`（1024×1024 矢量源，纯 `rect`/`path`/`transform`，无 `<text>`）。builder 用 icons 工具集把它栅格化成 `packages/shell/release/.icon-ico/icon.ico`（`21897` B，sha256 `bbe8e68c57ea847624f0e4760b27807e5e4580428f52ae4413277c3a3c46e1f3`）：**7 帧**（16/24/32/48/64/128/256），7 帧都是 PNG 压缩帧。
- **msi 目标没有图标就构建不出来**：MSI 模板只在 `iconPath` 存在时才发 `<Icon Id="${iconId}"/>`，而 `MsiTarget` 无条件用 `Icon="${iconId}"`（快捷方式与 ProgId）⇒ 缺图标必然 `light.exe` LGHT0094。`msi.icon` 这个键不存在，唯一入口是 `win.icon`/顶层 `icon`；图标源放在 `packaging/`（已跟踪）而不是 electron-builder 默认的 `build/`（被 `.gitignore` 忽略）。
- 图标确实进了产物：MSI `Icon` 表一行 `PiDockIcon.exe`（stream `21897` B），Windows Installer 抽到 `%APPDATA%\Microsoft\Installer\{ProductCode}\PiDockIcon.exe` 后 sha256 与 `release/.icon-ico/icon.ico` 相同；已安装 `PiDock.exe` 的 `RT_GROUP_ICON`（id 1、lang 1033）有 7 帧，7 帧字节与 `icon.ico` 对应帧 sha256 逐一相同；开始菜单与桌面快捷方式的 `IconLocation` 指向 `…\Installer\{ProductCode}\PiDockIcon.exe,0`。

### 本节仍未验证（不得据本节推断通过）

- **代码签名与公证**：本机 0 张代码签名证书 ⇒ MSI 与 `PiDock.exe` 均 `NotSigned`；签名未执行。
- **干净系统安装**：只在同一台已装 dev 工具链与 builder 缓存的机器上做过；未在干净 Windows 上安装。
- **多用户账户**：只在本机单一账户下安装/卸载；未验证第二账户下按用户安装的行为。
- **MSI 侧「安装前先关掉正在运行的应用」**（#84 box D，2026-10-15 静态核对，**未构建**）：本仓库能配的 MSI 面上没有这一步。`app-builder-lib@26.15.3` 的 `templates/msi/template.xml` 里没有 `util:CloseApplication`（模板中没有任何 `util:` 元素，`grep -rl CloseApplication out templates` 为空），`MsiOptions` 只允许 `additionalWixArgs` / `additionalLightArgs`，而单独 `-ext WixUtilExtension` 没有元素可指就加不上什么；所以覆盖安装/卸载碰到仍在运行的 PiDock 时，Windows Installer 的 FilesInUse 提示仍是唯一出口（1602 的来源）。可达的一半在应用侧：关掉最后一个窗口现在有界收敛并真正退出（#84）。
- **>1 版本升级矩阵**：只做了 `0.1.0 → 0.1.1` 一次覆盖升级；没有跳版本、降级、per-machine 与 per-user 混装的证据。
- **产品内终端**（更新 2026-10-14）：`#22` 的 T4 原先的两条阻断原因（平台门/钉、cwd 规范化）已由 #55 与 #61（`9ec1a25`）消除；win32-x64 上有自动化真实 PTY 用例覆盖 Host 记录 → plan → 会话层 → 驱动 → 真实 ConPTY。**仍未验证**：没有在已安装的 MSI 应用里跑过终端（打包 app 的产品路径在 `9ec1a25` 之后未复测），因此本行不代 `#22` 勾选。

## 签名与公证路径（未执行）

发布时设置以下环境变量后，`electron-builder` 会走 `@electron/osx-sign` 并对嵌套二进制（`PiDock Helper*.app`、Frameworks、utilityProcess 宿主等）统一签名：

- `CSC_LINK` / `CSC_KEY_PASSWORD`：Developer ID Application 证书（`.p12`）
- `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`：公证凭据

`afterSign` 钩子调用 `@electron/notarize` 的 `notarize({ appPath, appleId, appleIdPassword, teamId })`。`hardenedRuntime: true` 与 `packaging/entitlements.mac.plist`（JIT、unsigned executable memory、dyld 环境变量、library validation）已就位。Windows 侧签名需要 `CSC_LINK` 指向代码签名证书。

## 未完成 / 边界

- 应用图标已设置：`win.icon` 指向 `packages/shell/packaging/icon.svg`（msi 目标缺它就无法构建），MSI 的 `Icon` 表与 `PiDock.exe` 的图标资源都实际用了它（见「Windows x64 MSI 实测 · 应用图标」）；macOS 与 Linux 仍未设置图标。
- Windows 侧的**打包载荷**已观测：`release/win-unpacked/resources/app.asar.unpacked/node_modules/node-pty/prebuilds/win32-x64/` 下有 `conpty.node`（`ee8f4e6f…`）、`pty.node`（`ae323edd…`）等真实文件，sha256 与 #22 第二轮记录逐位一致；`app.asar` 内 `dist/host/` 与 `@earendil-works/pi-*` 条目均在。但这不代表「**产品内**那一次 PTY spawn 仍被平台门/钉具名拒绝」——该说法**已不成立**（更新 2026-10-14）：#55 的 pin 记录接纳 `win32-x64` 且 `ptySpawnerAvailable()` 在该平台为 true，#61（`9ec1a25`）修掉了产品路径无法启动终端的根因；win32-x64 上已有自动化真实 PTY 用例覆盖这条产品路径。**仍未在已安装的 MSI 应用内运行过终端**，打包 app 的产品路径也未在 `9ec1a25` 之后复测。
- Windows 的 **MSI 构建、安装、启动、覆盖升级与卸载已实测**（见「Windows x64 MSI 实测」，2026-10-14）；**代码签名、公证、干净系统安装、多用户账户与 >1 版本升级矩阵仍未验证**；不得据此声明 Windows 资产已签名或可在干净系统上发布。

## Windows MSI 人工验收（在 Windows 机器上执行）

**darwin-arm64 主机没有构建、安装或签名任何 MSI**；在这台机器上跑 `package:win` **预计**会先下载 WiX，随后在 x86_64 版 Wine 上以同类架构错误失败（同 2026-09-22 记录的 `-86`；**本节未实测**，属预期而非观察结果）。win32-x64 主机上的构建/安装/启动/卸载/覆盖升级已按下列步骤（的静默等价命令）执行过，结果见「Windows x64 MSI 实测」；下面保留的是**仍需人工完成**的部分：在干净 Windows 机器与第二个用户账户上重跑，以及签名。在人工回报结果之前，任何文档或结论都不得声称 Windows 资产可用或已签名。

**交互向导（#76）：** 上面这些人工步骤已串成可执行向导 `scripts/windows-release-wizard.sh`（运行 `bash scripts/windows-release-wizard.sh`）：选择并采集 Authenticode 签名方式（凭据只写进被 gitignore 的 `.env.signing`）、如实说明 CI 里没有消费签名密钥的工作流、按精确文件与行指路（但不改动）electron-builder 的签名接线、用 `Get-AuthenticodeSignature` 与 `signtool verify` 采集签名与时间戳的原始输出、干净机器安装与任务文件面板、第二账户与升级矩阵，最后把观测回记到 #22。它只引导与采集证据，**不代任何人勾选验收项**。

### 构建

```powershell
corepack enable                                 # 提供 pnpm（仓库固定 pnpm@11.22.0）
cd <包含本次改动的检出>                          # 核对本次候选的已提交源码身份
pnpm install --frozen-lockfile
pnpm --filter @pidock/shell package:win          # = electron-builder --config electron-builder.config.cjs --win msi --x64
# 等价写法：cd packages/shell ; pnpm package:win
```

产物路径：`directories.output` 是 `release`，`msi.artifactName` 是 `${productName}-${version}-${arch}.${ext}`（`packages/shell/electron-builder.config.cjs`），所以预期文件名为
`packages/shell/release/PiDock-<version>-x64.msi`（本仓库当前版本 `0.1.6` → `PiDock-0.1.6-x64.msi`）。这里写的是表达式而不是写死的名字，是为了让 `.${ext}` 继续跟随实际目标格式；如果目录里出现别的名字，以实际文件名为准并在回报中写明。

### 内部/自用分发的版本与产物身份

不同内容的新分发包先递增 `packages/shell/package.json` 的三段版本号并提交，再运行 `package:win`；本轮候选为 `0.1.6`（#97 修复已安装 0.1.5 冷重开任务的生命周期路径身份误判；0.1.5 已移除桌面内置终端且安装身份与入口缺席已确认；`0.1.1` 是历史升级实验，`0.1.2` 候选服务归属门禁失败见 #90，`0.1.3` 安装后 Windows PowerShell 报 `8009001d`，`0.1.4` 补齐 OS 启动环境见 #85，安装身份已核验但 GUI 终端成功未确认）。正式分发不使用临时修改版本后复原的方式。仅重复构建同一候选时也须重算哈希；字节变化就重新核验，旧产物的验收结论不能沿用。

每枚候选记录源码提交、应用版本、文件名、大小、SHA-256、MSI 的 `ProductCode` / `UpgradeCode` / `ProductVersion`、包内 `package.json` 版本及签名观测。安装后核对注册版本和 `app.asar` 的哈希与构建候选一致，再做任务文件面板、会话与退出检查；文件时间只作旁证。

electron-builder `26.15.3` 的 `templates/msi/template.xml` 使用 `<Product Id="*">`，并明确设置 `<MajorUpgrade AllowSameVersionUpgrades="yes" …/>`；`MsiTarget.js` 从 `appId` 推导稳定的 `UpgradeCode`。因此每次构建的随机 `ProductCode` **不表示**不支持同版本升级；递增分发版本是为了识别不同候选，不需要固定 `ProductCode` 或更改 `appId`。模板支持升级不等于本次安装已验证，实际结果仍需 MSI 日志、安装后版本与载荷哈希证明。

升级前退出应用并确认受管进程已结束；保留旧 MSI 和证据，按相同安装范围验证旧版 → 新版。若调用 `msiexec` 自动测量，须使用能保留 Windows 参数的方式（例如 PowerShell `Start-Process -Wait -PassThru`），记录真实退出码与详细日志；不能用管道末端命令的退出码代替安装器结果。

### 验收步骤

1. 产物存在且是 MSI：`Get-Item .\PiDock-<version>-x64.msi`，记录文件名与大小；
   `Get-FileHash .\PiDock-<version>-x64.msi -Algorithm SHA256`。
2. 签名：`Get-AuthenticodeSignature .\PiDock-<version>-x64.msi | Format-List Status, SignerCertificate`。
   未配置代码签名证书时它必然报 `NotSigned`——这是当前状态、不是失败；只有正式发布才要求有效的 Authenticode 签名。
3. 安装：双击 MSI。预期：出现交互式向导（`oneClick:false`），并显示**安装范围选择页**——`oneClick:false` 时 WiX UI 同时启用 `WixUISupportPerUser` 与 `WixUISupportPerMachine`（已安装 builder 的 `templates/msi/template.xml:46-51,61-74`）。**默认**是安装范围为**当前用户**（`perMachine:false`）、无需管理员提升；若在向导中选择“为所有用户安装”，则按 per-machine 安装并出现 UAC 提升提示（这是正常路径，不是失败）。安装后从开始菜单／桌面快捷方式启动 PiDock，确认主窗口正常打开并可退出。
4. 卸载：设置 → 应用 → 已安装的应用 → PiDock → 卸载；确认应用目录与快捷方式消失，且用户数据（工作区、配置、会话）按规格保留。
5. 升级：先安装**同一 `appId`（`com.pidock.desktop`）的旧版本 MSI**，再安装新版本 MSI。预期：覆盖升级成功、应用内版本更新、用户数据保留、不出现并列安装。`upgradeCode` 由 `appId` 推导、没有写死（见 ADR 0004），所以 `appId` 一变升级身份就变。

### 回报内容

版本号、架构、产物文件名、SHA-256、`Get-AuthenticodeSignature` 的 `Status`，以及上面每一步的实际结果（通过／失败／未执行）与失败原文。**在 Windows 上发现的问题按新工单／新发现回报，不要在这台 macOS 机器上盲改代码或配置。**
