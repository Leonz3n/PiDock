#!/usr/bin/env bash
# Render every reference SVG to a 1440x900 PNG with headless Chromium.
# Override CHROME to use another Chromium/Chrome binary.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
design="$(cd "$here/.." && pwd)"
out="$design/reference"

CHROME="${CHROME:-$HOME/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell}"
if [[ ! -x "$CHROME" ]]; then
  candidate="$(find "$HOME/Library/Caches/ms-playwright" -path '*/chrome-headless-shell-mac-*/chrome-headless-shell' -type f 2>/dev/null | head -n 1 || true)"
  if [[ -n "${candidate:-}" ]]; then CHROME="$candidate"; fi
fi
if [[ ! -x "$CHROME" ]]; then
  echo "No Chromium headless shell found. Set CHROME=/path/to/chrome-headless-shell" >&2
  exit 1
fi

shopt -s nullglob
for svg in "$out"/*.svg; do
  name="$(basename "$svg" .svg)"
  "$CHROME" --headless --disable-gpu --hide-scrollbars \
    --force-device-scale-factor=1 --window-size=1440,900 \
    --screenshot="$out/$name.png" "file://$svg" >/dev/null 2>&1
  echo "rendered $name.png"
done
