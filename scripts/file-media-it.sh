#!/usr/bin/env bash
# /file 媒体白名单 + Range 集成验收（第三层）。先启动隔离 kernel：
#   WA_PI_DIR=$(mktemp -d) bun run --filter @wa-pi/kernel dev
# Windows 下用 Git Bash 运行本脚本。
set -euo pipefail
BASE="${1:-http://localhost:9776}"
fail() { echo "❌ $1"; exit 1; }

# Git Bash 的 mktemp 返回 MSYS 挂载路径（/tmp/...），Node/Bun realpath 不识别；
# 文件操作用 POSIX 路径，传给 kernel 的一律用 cygpath -m 转成 Windows 混合路径（正斜杠，JSON 安全）
PROJ_POSIX=$(mktemp -d)
PROJ=$(cygpath -m "$PROJ_POSIX")
trap 'rm -rf "$PROJ_POSIX"' EXIT

# 注册项目（/file 白名单按项目 cwd 的 realpath 判定）
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/projects" \
	-H "Content-Type: application/json" \
	-d "{\"name\":\"media-it-$$\",\"cwd\":\"$PROJ\"}")
[ "$code" = "200" ] || fail "创建项目应返回 200，实际 $code"

# 1) 工作区内图片 → 200 + image/png
printf '\x89PNG\r\n\x1a\n' > "$PROJ_POSIX/pic.png"
headers=$(curl -s -D - -o /dev/null -G "$BASE/file" --data-urlencode "path=$PROJ/pic.png")
echo "$headers" | grep -q " 200" || fail "项目内图片应 200：$headers"
echo "$headers" | grep -qi "content-type: image/png" || fail "MIME 应为 image/png：$headers"

# 2) ../ 穿越到项目外 → 403
code=$(curl -s -o /dev/null -w "%{http_code}" -G "$BASE/file" \
	--data-urlencode "path=$PROJ/../../etc/passwd")
[ "$code" = "403" ] || fail "路径穿越应 403，实际 $code"

# 3) 项目外绝对路径 → 403
OUT_POSIX=$(mktemp)
OUT=$(cygpath -m "$OUT_POSIX")
code=$(curl -s -o /dev/null -w "%{http_code}" -G "$BASE/file" --data-urlencode "path=$OUT")
[ "$code" = "403" ] || fail "项目外路径应 403，实际 $code"
rm -f "$OUT_POSIX"

# 4) 视频 MIME + Range → 206 + content-range
head -c 100000 /dev/zero > "$PROJ_POSIX/clip.mp4"
headers=$(curl -s -D - -o /dev/null -G "$BASE/file" --data-urlencode "path=$PROJ/clip.mp4" \
	-H "Range: bytes=0-99")
echo "$headers" | grep -q " 206" || fail "Range 请求应 206：$headers"
echo "$headers" | grep -qi "content-type: video/mp4" || fail "MIME 应为 video/mp4：$headers"
echo "$headers" | grep -qi "content-range: bytes 0-99/100000" || fail "content-range 不符：$headers"

echo "✅ /file 媒体白名单 + Range 集成验收通过"
