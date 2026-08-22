#!/usr/bin/env bash
# macOS Finder 双击入口:检查 bun → cd 项目根 → bun run dev
# 脚本自身只做环境检查和转发,启动逻辑全在 scripts/dev.ts 里。
set -euo pipefail

# cd 到脚本所在目录(即仓库根,无论从哪里双击)
cd "$(dirname "$0")"

# bun 环境检查
if ! command -v bun &>/dev/null; then
  echo "================================================"
  echo "  错误:未找到 bun"
  echo "  请先安装:https://bun.sh"
  echo "  安装后重新双击此文件"
  echo "================================================"
  echo ""
  read -rp "按回车键关闭窗口..."
  exit 1
fi

echo "[start] bun 就绪,启动 wa-pi..."
echo "[start] 浏览器会自动打开 http://localhost:5180"
echo "[start] 按 R 重新加载前后端代码,按 Ctrl+C 停止"
echo ""

# 转发给 scripts/dev.ts(端口清理、并行启动、开浏览器都在里面)
exec bun run dev
