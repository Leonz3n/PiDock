# 工具链预热记录

状态：2026-09-22 在 macOS 开发机完成首轮预热。预热产物都在本机缓存中，不进入仓库，也不构成技术选型决定。

## 目的

实现工单开始前，把需要从 GitHub 等外部源下载的大体积依赖预先拉取到本机缓存，避免实现会话把时间花在等待下载或网络排障上。范围覆盖：

- 工单 01（可见浏览器控制原型）需要的 Electron + TypeScript + Playwright 组合。
- 工单 02、10、11–13、15 已能确定的依赖：pi SDK、终端 PTY、SQLite、打包工具。

规格要求技术原型通过后才冻结实现选择，因此本记录只预热已核对存在的包，不代表这些包已经入选。

## 本机环境

| 项目 | 版本 | 备注 |
| --- | --- | --- |
| 系统 | macOS 26.6.2 (arm64) | Electron 二进制按 darwin-arm64 预热 |
| Node | v22.23.2（ABI 127） | 同时满足 Electron `>=22.12`、pi SDK `>=22.19`、electron-vite 要求 |
| npm | 10.9.8 | 备用包管理器缓存 |
| pnpm | 11.25.0 | 主用包管理器缓存 |
| Xcode 命令行工具 | Apple clang 21.0.0 | 原生模块编译 |
| python3 | 3.9.6 | node-gyp 依赖 |

## 网络与代理

实测（2026-09-22）：

| 目标 | 直连 | 经 `http://127.0.0.1:10808` |
| --- | --- | --- |
| `registry.npmjs.org` | 约 8s（接近超时） | 约 2.7s |
| `github.com` | 超时 | 约 2.1s |
| `objects.githubusercontent.com` | 可达但慢 | 约 1.1s |
| `cdn.playwright.dev` | 可达 | 可达 |

三条下载链路读取的环境变量不同，需要同时设置：

```bash
export npm_config_proxy=http://127.0.0.1:10808
export npm_config_https_proxy=http://127.0.0.1:10808
export HTTPS_PROXY=http://127.0.0.1:10808
export HTTP_PROXY=http://127.0.0.1:10808
# Electron 二进制走 @electron/get，需要显式开启代理支持
export ELECTRON_GET_USE_PROXY=true
export GLOBAL_AGENT_HTTPS_PROXY=http://127.0.0.1:10808
export GLOBAL_AGENT_HTTP_PROXY=http://127.0.0.1:10808
```

代理地址仅是本机开发约定，不写入 `.npmrc` 或其他可提交配置；失效时改回直连即可。

## 已预热内容

| 组件 | 版本 | 缓存位置 | 体积 | 相关工单 |
| --- | --- | --- | --- | --- |
| Electron 二进制（darwin-arm64） | 44.4.3 | `~/Library/Caches/electron` | 128M | 01 |
| Playwright Chromium + headless shell + ffmpeg | 1.63.0 / chromium 1243 | `~/Library/Caches/ms-playwright` | 557M | 01、06 |
| pnpm store | v11 | `~/Library/pnpm/store/v11` | 459M | 全部 |
| npm cache | — | `~/.npm` | 529M | 全部（备用） |
| Electron 头文件 | 44.4.3 | `~/.electron-gyp/44.4.3` | 2M | 原生模块 |
| node-pty（已针对 Electron 44 ABI 重编译） | 1.1.0 | `~/Library/pnpm/store/v11` | — | 10 |
| pi SDK 及 6 个子包 | 0.87.0 | pnpm store / npm cache | — | 02、11、12、13 |
| better-sqlite3（tarball 自带全平台 prebuild） | 13.0.3 | pnpm store / npm cache | — | 持久化 |
| electron-builder / @electron/rebuild / electron-vite / vite / TypeScript / Playwright 测试库 | 见下表 | pnpm store / npm cache | — | 01、15 |

已验证的版本集合：

```json
{
  "@earendil-works/pi-coding-agent": "0.87.0",
  "@electron/rebuild": "4.2.0",
  "@playwright/test": "1.63.0",
  "@swc/core": "1.16.2",
  "@types/node": "^24.9.0",
  "better-sqlite3": "13.0.3",
  "electron": "44.4.3",
  "electron-builder": "26.15.3",
  "electron-vite": "5.0.0",
  "node-pty": "1.1.0",
  "playwright-core": "1.63.0",
  "typescript": "7.0.2",
  "vite": "7.3.6"
}
```

`electron --version`、`tsc --version`、`electron-builder --version`、`playwright --version`、pi SDK 导入与 `electron-rebuild -w node-pty` 均已实测通过。

## 关键发现

1. **Electron 44 移除了 `postinstall`**，改为提供 `install-electron` bin。包管理器安装后不会自动下载二进制，必须显式执行 `node node_modules/electron/install.js`，否则要到首次启动才暴露缺失。
2. **pnpm 11 不再读取 `package.json` 的 `pnpm.onlyBuiltDependencies`**，构建脚本白名单要写在 `pnpm-workspace.yaml` 的 `allowBuilds`。默认情况下 electron、esbuild、node-pty、`@swc/core` 的构建脚本会被跳过。
3. **electron-vite 5.0.0 的 peer 是 `vite@^5||^6||^7`，而 Vite 最新为 8.3.0**。使用 npm 会直接 ERESOLVE 失败。实现时应固定 `vite@7.3.6`。
4. **better-sqlite3 13.0.3 与 node-pty 1.1.0 都在 npm tarball 内自带多平台 prebuild**（含 `win32-x64`、`win32-arm64`），不需要从 GitHub 下载预编译产物。但 node-pty 需要针对 Electron ABI 重编译，已用 `@electron/rebuild` 验证可行。
5. **当前 Node 22.23.2 无需升级**：Electron 44 要求 `>=22.12`，pi SDK 要求 `>=22.19`，两者同时满足。
6. 在无 GUI 权限的上下文中直接执行 Electron 二进制会 `SIGABRT`，这与缓存无关；校验版本需在允许启动 GUI 的环境执行。

## 尚未预热

- Windows 与 Intel（darwin-x64）Electron 二进制：本机为 arm64，只拉取了 darwin-arm64。Windows 机器需各自执行一次。
- electron-builder 首次打包所需的外部产物（Windows NSIS、winCodeSign、macOS dmg 组件），均从 GitHub 下载，经代理可用，待工单 15 需要时再拉取。
- Playwright Firefox / WebKit：产品只用 Electron 内嵌 Chromium，暂不需要。
- 试点业务仓库自身的工具链（Go 服务、front-monorepo 的 pnpm 依赖）不属于本仓库预热范围。

## 复现方式

见 [`scripts/warm-toolchain.sh`](../scripts/warm-toolchain.sh)。脚本在临时目录中创建一次性工程并复用上述缓存，不修改本仓库依赖，也不写入任何产物到仓库内。
