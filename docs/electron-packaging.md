# Electron 打包（S6 候选产出）

日期：2026-09-22（Asia/Shanghai）
状态：macOS arm64 **已实测产出未签名 DMG 候选**；Windows x64 **仅 `win-unpacked` 载荷已产出；安装资产为 MSI（[ADR 0004](adr/0004-windows-installer-msi-instead-of-nsis-exe.md)，2026-10-13），本机未构建、未安装、未签名**。
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
- 尚无 pi / 原生资源依赖随包分发：S1 的 utilityProcess 仍是 Node Host stub，因此只确认了 **utilityProcess 入口**随包分发，**pi 依赖与原生模块的随包分发尚未验证**。
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
