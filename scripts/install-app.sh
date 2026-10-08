#!/usr/bin/env bash
# scripts/install-app.sh — 從某個 git ref 建置 Harness.app 並安裝到 ~/Applications
# 用法：scripts/install-app.sh [ref]（預設 main）
# 在暫存的 worktree 裡建置：不受目前工作目錄的分支、未提交的變更與 npm run dev 影響。
# 資料（repo 清單、任務）與開發版共用 ~/Library/Application Support/harness。
set -euo pipefail
REF="${1:-main}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
DEST_DIR="$HOME/Applications"
DEST="$DEST_DIR/Harness.app"

# 正在執行時不覆蓋，免得中斷進行中的任務
if pgrep -f "$DEST/Contents/MacOS/" >/dev/null; then
  echo "Harness.app 正在執行，請先結束它再安裝" >&2
  exit 1
fi

COMMIT="$(git -C "$REPO" rev-parse --verify "$REF^{commit}")"
BUILD="$(mktemp -d "${TMPDIR:-/tmp}/harness-build.XXXXXX")"
cleanup() {
  git -C "$REPO" worktree remove --force "$BUILD" 2>/dev/null || rm -rf "$BUILD"
}
trap cleanup EXIT

echo "▸ 建置 $REF（${COMMIT:0:7}）於 $BUILD"
git -C "$REPO" worktree add --detach "$BUILD" "$COMMIT" >/dev/null
cd "$BUILD"
npm ci --no-audit --no-fund
npm run build
npx electron-builder --mac --dir --publish never

APP="$(find dist -maxdepth 2 -name 'Harness.app' -type d | head -n 1)"
if [ -z "$APP" ]; then
  echo "找不到建置出來的 Harness.app" >&2
  exit 1
fi

mkdir -p "$DEST_DIR"
rm -rf "$DEST"
ditto "$APP" "$DEST"
echo "✓ 已安裝 $DEST（${COMMIT:0:7}）"
echo "  從 Spotlight 或 Launchpad 開啟，或執行：open \"$DEST\""
