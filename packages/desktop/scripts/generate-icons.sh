#!/bin/bash
# 从 icon-mac.png 生成标准 .icns（用 Apple iconutil，避免 electron-builder 内置转换产生 JPEG-2000 花屏图标）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_PNG="$SCRIPT_DIR/../src/assets/icon-mac.png"
DST_ICNS="$SCRIPT_DIR/../src/assets/icon-mac.icns"
ICONSET="$(mktemp -d -t wa-pi-iconset)/wa-pi.iconset"

cleanup() { rm -rf "$(dirname "$ICONSET")"; }
trap cleanup EXIT

mkdir -p "$ICONSET"

echo "[generate-icons] 从 $SRC_PNG 生成 $DST_ICNS"

# 生成各尺寸 PNG（Apple iconset 规范）
sips -z 16 16     "$SRC_PNG" --out "$ICONSET/icon_16x16.png"
sips -z 32 32     "$SRC_PNG" --out "$ICONSET/icon_16x16@2x.png"
sips -z 32 32     "$SRC_PNG" --out "$ICONSET/icon_32x32.png"
sips -z 64 64     "$SRC_PNG" --out "$ICONSET/icon_32x32@2x.png"
sips -z 128 128   "$SRC_PNG" --out "$ICONSET/icon_128x128.png"
sips -z 256 256   "$SRC_PNG" --out "$ICONSET/icon_128x128@2x.png"
sips -z 256 256   "$SRC_PNG" --out "$ICONSET/icon_256x256.png"
sips -z 512 512   "$SRC_PNG" --out "$ICONSET/icon_256x256@2x.png"
sips -z 512 512   "$SRC_PNG" --out "$ICONSET/icon_512x512.png"
sips -z 1024 1024 "$SRC_PNG" --out "$ICONSET/icon_512x512@2x.png"

iconutil -c icns "$ICONSET" -o "$DST_ICNS"
echo "[generate-icons] ✅ $DST_ICNS ($(stat -f%z "$DST_ICNS") bytes)"
