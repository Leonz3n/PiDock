# Electron 打包（S6 候选产出）

日期：2026-09-22（Asia/Shanghai）
状态：macOS arm64 **已实测产出未签名 DMG 候选**；Windows x64 **载荷已产出，安装器在 arm64 主机上被架构阻塞**。
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
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm package:win    # Windows x64 NSIS EXE
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

- `release/win-unpacked/` 已产出：`PiDock.exe` 与 `resources/app.asar`（41 条目，含 `dist/host/host.js`）；`du -sh` 约 `374M`。
- NSIS 单一 EXE 安装器**构建失败**：
  `Cannot spawn …/nsis-3.0.4.1/mac/makensis: Error: spawn Unknown system error -86`。
  原因：该 `makensis` 是 **Mach-O x86_64** 可执行文件，而主机为 **arm64 且无 Rosetta**，因此 `EBADARCH (-86)`。
- 结论：Windows 安装器需要在 x86_64 macOS（或已装 Rosetta 的 arm64、或 Windows/Linux CI）上重跑；**Windows 运行时行为完全未测**。

## 签名与公证路径（未执行）

发布时设置以下环境变量后，`electron-builder` 会走 `@electron/osx-sign` 并对嵌套二进制（`PiDock Helper*.app`、Frameworks、utilityProcess 宿主等）统一签名：

- `CSC_LINK` / `CSC_KEY_PASSWORD`：Developer ID Application 证书（`.p12`）
- `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`：公证凭据

`afterSign` 钩子调用 `@electron/notarize` 的 `notarize({ appPath, appleId, appleIdPassword, teamId })`。`hardenedRuntime: true` 与 `packaging/entitlements.mac.plist`（JIT、unsigned executable memory、dyld 环境变量、library validation）已就位。Windows 侧签名需要 `CSC_LINK` 指向代码签名证书。

## 未完成 / 边界

- 未设置应用图标（仍用 Electron 默认图标）。
- 尚无 pi / 原生资源依赖随包分发：S1 的 utilityProcess 仍是 Node Host stub，因此只确认了 **utilityProcess 入口**随包分发，**pi 依赖与原生模块的随包分发尚未验证**。
- Windows 运行时、安装、签名均未验证；不得据此声明跨平台通过。
