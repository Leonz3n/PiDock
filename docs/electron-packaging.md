# Electron 打包（S6 候选产出）

日期：2026-09-22（Asia/Shanghai）
状态：macOS arm64 **已实测产出未签名 DMG 候选**；macOS 侧 node-pty 原生载荷随包分发已实测（2026-10-13，见「macOS：node-pty 原生载荷随包分发」）；Windows x64 **仅 `win-unpacked` 载荷已产出；安装资产为 MSI（[ADR 0004](adr/0004-windows-installer-msi-instead-of-nsis-exe.md)，2026-10-13），本机未构建、未安装、未签名**。
实际发布验收归 #15；本文件只记录候选工具链与实测边界。

## 工具链

- Electron `44.4.3`（`packages/shell` devDependency）
- electron-builder `26.15.3`（devDependency）
- 配置：`packages/shell/electron-builder.config.cjs`
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

`electronDist` 在 macOS 目标下复用已安装的 `node_modules/electron/dist`，因此 macOS 打包可离线完成；Windows 目标必须下载 win32-x64 Electron 发行包。

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

也就是说「pi 依赖与原生模块的随包分发尚未验证」这句话在 **macOS** 上已被上述实测取代：载荷确实被收集、被解包成磁盘上的真实文件，并且正是预检钉死的那两份字节。**Windows 侧仍未验证**（见下面「未完成 / 边界」与 Windows 各节）。

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

## Windows x64 候选状态（待测，不声称通过）

Windows 安装资产为 **MSI**（[ADR 0004](adr/0004-windows-installer-msi-instead-of-nsis-exe.md)，2026-10-13 人工决定），不再是 NSIS 单一 EXE。本机（darwin-arm64）**没有构建、安装或签名过任何 MSI**。

- `release/win-unpacked/` 已产出：`PiDock.exe` 与 `resources/app.asar`（41 条目，含 `dist/host/host.js`）；`du -sh` 约 `374M`。
- 2026-09-22 的 **NSIS 单一 EXE 安装器构建失败**（当时目标为 NSIS，该目标已被 ADR 0004 取代）：
  `Cannot spawn …/nsis-3.0.4.1/mac/makensis: Error: spawn Unknown system error -86`。
  原因：该 `makensis` 是 **Mach-O x86_64** 可执行文件，而主机为 **arm64 且无 Rosetta**，因此 `EBADARCH (-86)`。
- 改成 MSI 并不解除该阻塞：MSI 目标需要 WiX `4.0.0.5512.2`（构建时下载，`app-builder-lib/out/targets/MsiTarget.js:73`），非 Windows 宿主还要跑 x86_64 版 Wine（`app-builder-lib/out/toolsets/wine.js`），与本机 arm64 无 Rosetta 属同一类架构问题。因此 MSI 不在本机构建，改由人工在 Windows 机器上验收（见下节）。
- 结论：Windows 运行时、安装、升级与签名**完全未测**；不得据此声明跨平台通过。

## 签名与公证路径（未执行）

发布时设置以下环境变量后，`electron-builder` 会走 `@electron/osx-sign` 并对嵌套二进制（`PiDock Helper*.app`、Frameworks、utilityProcess 宿主等）统一签名：

- `CSC_LINK` / `CSC_KEY_PASSWORD`：Developer ID Application 证书（`.p12`）
- `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`：公证凭据

`afterSign` 钩子调用 `@electron/notarize` 的 `notarize({ appPath, appleId, appleIdPassword, teamId })`。`hardenedRuntime: true` 与 `packaging/entitlements.mac.plist`（JIT、unsigned executable memory、dyld 环境变量、library validation）已就位。Windows 侧签名需要 `CSC_LINK` 指向代码签名证书。

## 未完成 / 边界

- 未设置应用图标（仍用 Electron 默认图标）。
- Windows 侧尚无 pi / 原生资源依赖随包分发的证据：Windows 上只确认了 **utilityProcess 入口**随包分发，**pi 依赖与原生模块的随包分发尚未验证**（macOS 侧已实测，见「macOS：node-pty 原生载荷随包分发」）。
- Windows 运行时、MSI 安装、升级与签名均未验证；不得据此声明跨平台通过。

## Windows MSI 人工验收（在 Windows 机器上执行）

**本机（darwin-arm64）没有构建、安装或签名任何 MSI。** 下面每一步都必须在另一台 Windows x64 机器上由人工执行；在此机器上跑 `package:win` **预计**会先下载 WiX，随后在 x86_64 版 Wine 上以同类架构错误失败（同 2026-09-22 记录的 `-86`；**本节未实测**，属预期而非观察结果），证明不了任何 Windows 结论。在人工回报结果之前，任何文档或结论都不得声称 Windows 资产可用或已签名。

### 构建

```powershell
corepack enable                                 # 提供 pnpm（仓库固定 pnpm@11.22.0）
cd <包含本次改动的检出>                          # 本分支 issue-10-impl 尚未推送，需人工同步到该机器
pnpm install --frozen-lockfile
pnpm --filter @pidock/shell package:win          # = electron-builder --config electron-builder.config.cjs --win msi --x64
# 等价写法：cd packages/shell ; pnpm package:win
```

产物路径：`directories.output` 是 `release`，`msi.artifactName` 是 `${productName}-${version}-${arch}.${ext}`（`packages/shell/electron-builder.config.cjs`），所以预期文件名为
`packages/shell/release/PiDock-<version>-x64.msi`（本仓库当前版本 `0.1.0` → `PiDock-0.1.0-x64.msi`）。这里写的是表达式而不是写死的名字，是为了让 `.${ext}` 继续跟随实际目标格式；如果目录里出现别的名字，以实际文件名为准并在回报中写明。

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
