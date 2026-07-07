#!/usr/bin/env bash
# HiAgent 开发启动脚本：清理残留 → 重建 kernel sidecar → 启动 Tauri 应用
# 用法：./dev.sh
set -euo pipefail

cd "$(dirname "$0")"

# === 补全工具链 PATH（nvm node + bun + cargo + homebrew）===
export PATH="$HOME/.nvm/versions/node/v22.21.1/bin:$HOME/.bun/bin:$HOME/.cargo/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"

# 加载环境变量（含 DEEPSEEK_API_KEY 等）
[ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc" 2>/dev/null || true

echo "=== 1. 清理残留进程 ==="
pkill -9 -f "target/debug/hiagent" 2>/dev/null || true
pkill -9 -f "hiagent-kernel" 2>/dev/null || true
lsof -ti:9776 2>/dev/null | xargs kill -9 2>/dev/null || true
lsof -ti:5173 2>/dev/null | xargs kill -9 2>/dev/null || true
sleep 1

echo "=== 2. 重新编译 kernel sidecar（含最新改动）==="
bun run --filter @hiagent/kernel build

echo "=== 3. 启动 Tauri 应用（前端 + Rust + kernel sidecar）==="
echo "    窗口弹出后即可使用，Ctrl+C 退出"
echo ""
cd src-tauri
npx @tauri-apps/cli@2.11 dev
