#!/usr/bin/env bash
# 预热 PiDock 桌面应用所需的本地缓存（Electron 二进制、Playwright 浏览器、pnpm/npm 依赖、Electron 原生模块头文件）。
#
# 用法：
#   scripts/warm-toolchain.sh              # 默认经本地代理 http://127.0.0.1:10808
#   PROXY= scripts/warm-toolchain.sh        # 直连
#   PROXY=http://127.0.0.1:10808 scripts/warm-toolchain.sh
#
# 只写本机缓存（~/Library/Caches、~/Library/pnpm/store、~/.npm、~/.electron-gyp）与临时目录，
# 不改动仓库内容。详见 docs/toolchain-warmup.md。

set -euo pipefail

PROXY="${PROXY-http://127.0.0.1:10808}"
WORKDIR="${WORKDIR:-$(mktemp -d "${TMPDIR:-/tmp}/pidock-warmup.XXXXXX")}"

if [[ -n "$PROXY" ]]; then
  export npm_config_proxy="$PROXY" npm_config_https_proxy="$PROXY"
  export HTTPS_PROXY="$PROXY" HTTP_PROXY="$PROXY" https_proxy="$PROXY" http_proxy="$PROXY"
  # Electron 二进制走 @electron/get，需要显式开启代理支持
  export ELECTRON_GET_USE_PROXY=true
  export GLOBAL_AGENT_HTTPS_PROXY="$PROXY" GLOBAL_AGENT_HTTP_PROXY="$PROXY"
  echo "== 使用代理 $PROXY =="
else
  echo "== 直连（未设置代理）=="
fi

echo "== 工作目录 $WORKDIR =="
cd "$WORKDIR"

cat > package.json <<'JSON'
{
  "name": "pidock-warmup",
  "private": true,
  "version": "0.0.0",
  "description": "一次性工程，仅用于预热 PiDock 工具链缓存。",
  "devDependencies": {
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
}
JSON

# pnpm 11 起，构建脚本白名单只从 pnpm-workspace.yaml 读取。
cat > pnpm-workspace.yaml <<'YAML'
allowBuilds:
  electron: true
  esbuild: true
  node-pty: true
  better-sqlite3: true
  '@swc/core': true
  '@google/genai': false
  electron-winstaller: false
  protobufjs: false
YAML

echo "== pnpm install =="
pnpm install --reporter=append-only

# Electron 44 不再提供 postinstall，需显式下载二进制。
echo "== electron 二进制 =="
node node_modules/electron/install.js

echo "== Playwright Chromium =="
pnpm exec playwright install chromium

# 让原生模块（终端 PTY）在 Electron ABI 下可用。
echo "== electron-rebuild node-pty =="
pnpm exec electron-rebuild -f -w node-pty

echo
echo "== 校验 =="
./node_modules/.bin/electron --version || echo "（无 GUI 权限时 Electron 自检会 SIGABRT，可忽略）"
./node_modules/.bin/tsc --version
./node_modules/.bin/playwright --version
./node_modules/.bin/electron-builder --version
node -e "import('@earendil-works/pi-coding-agent').then(() => console.log('pi SDK import ok'))"

echo
echo "预热完成。缓存位置见 docs/toolchain-warmup.md；临时工程保留在 $WORKDIR。"
