#!/usr/bin/env bash
# ==================================================
#  HiAgent - Quick Start (macOS)
#  Tauri 窗口 + Bun kernel sidecar + Vite 前端
#
#  双击此文件即可启动，或在终端运行 ./start.sh
#
#  运行时快捷键：
#    r/R  = 重启应用（重新编译 kernel + 重启 tauri）
#    q/Q  = 退出（停所有进程 + 关窗口）
# ==================================================
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
TAURI_DIR="$ROOT_DIR/src-tauri"

# ---- 补全工具链 PATH（nvm node + bun + cargo + homebrew）----
export PATH="$HOME/.nvm/versions/node/v22.21.1/bin:$HOME/.bun/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
# 加载环境变量（含 DEEPSEEK_API_KEY）
[ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc" 2>/dev/null || true

# 全局 PID（tauri dev 主进程）
APP_PID=""

# ---- 颜色 ----
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${GREEN}[ OK ]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()   { echo -e "${RED}[ERR ]${NC} $*"; }
title() { echo -e "${CYAN}$*${NC}"; }

# ---- 端口清理 ----
killport() {
    local port="$1" label="${2:-}" pid
    pid=$(lsof -ti ":$port" 2>/dev/null || true)
    if [ -n "$pid" ]; then
        warn "端口 $port ($label) 被 PID $pid 占用，清理中..."
        kill -9 $pid 2>/dev/null || true
        sleep 1
        info "端口 $port 已释放"
    fi
}

# ---- 环境检查 ----
check_env() {
    echo "=================================================="
    echo "  HiAgent - 启动中..."
    echo "=================================================="
    echo ""
    echo "[INFO] 检查环境..."

    local missing=0
    if ! command -v bun &>/dev/null; then err "bun 未找到，安装: https://bun.sh"; missing=1; fi
    if ! command -v node &>/dev/null; then err "node 未找到，安装: https://nodejs.org"; missing=1; fi
    if ! command -v cargo &>/dev/null; then err "cargo 未找到，安装 Rust: https://rustup.rs"; missing=1; fi
    [ "$missing" -eq 1 ] && exit 1

    # 检查 DEEPSEEK_API_KEY（agent 回复必需）
    if [ -z "${DEEPSEEK_API_KEY:-}" ]; then
        warn "DEEPSEEK_API_KEY 未配置，agent 发消息后会报 No API key 错误"
        warn "配置方法：echo 'export DEEPSEEK_API_KEY=\"你的key\"' >> ~/.zshrc"
    fi

    info "bun + node + cargo 就绪"
}

# ---- 安装依赖 ----
install_deps() {
    if [ ! -d "$ROOT_DIR/node_modules" ]; then
        warn "依赖未安装，正在安装..."
        (cd "$ROOT_DIR" && bun install) || { err "依赖安装失败"; exit 1; }
        info "依赖安装完成"
    fi
}

# ---- 停止应用 ----
stop_app() {
    echo "[INFO] 停止应用..."
    # 杀 tauri 主进程 + kernel sidecar
    pkill -9 -f "target/debug/hiagent" 2>/dev/null || true
    pkill -9 -f "hiagent-kernel" 2>/dev/null || true
    if [ -n "$APP_PID" ] && kill -0 "$APP_PID" 2>/dev/null; then
        kill -TERM "$APP_PID" 2>/dev/null || true
        wait "$APP_PID" 2>/dev/null || true
    fi
    killport 9776 Kernel
    killport 5173 Frontend
    APP_PID=""
    info "应用已停止"
}

# ---- 启动应用 ----
start_app() {
    echo "[INFO] 编译 kernel sidecar..."
    (cd "$ROOT_DIR" && bun run --filter @hiagent/kernel build) || { err "kernel 编译失败"; return 1; }
    info "kernel sidecar 编译完成"

    echo "[INFO] 启动 Tauri 应用..."
    cd "$TAURI_DIR"
    npx @tauri-apps/cli@2.11 dev &
    APP_PID=$!
    cd "$ROOT_DIR"

    echo -n "        等待应用窗口"
    local ok=0
    for i in $(seq 1 30); do
        if lsof -ti:9776 >/dev/null 2>&1; then ok=1; break; fi
        echo -n "."
        sleep 1
    done
    echo ""
    if [ "$ok" -eq 1 ]; then
        info "kernel 就绪 (ws://127.0.0.1:9776)"
    else
        warn "kernel 可能未就绪（Rust 首次编译较慢，请稍候）"
    fi

    echo ""
    echo "=================================================="
    info "HiAgent 应用已启动！窗口应已弹出"
    echo "  Kernel   : ws://127.0.0.1:9776"
    echo "  Frontend : http://localhost:5173 (dev)"
    echo "=================================================="
}

# ---- 退出清理 ----
cleanup() {
    echo ""
    echo "[INFO] 正在停止所有进程..."
    stop_app
    echo ""
    info "已全部停止，再见！"
}
trap cleanup EXIT INT TERM HUP

# ---- 菜单 ----
show_menu() {
    echo ""
    echo "+------------------------------------------------+"
    echo "|  [R] 重启应用          [Q] 退出                 |"
    echo "+------------------------------------------------+"
}

lowercase() { echo "$1" | tr '[:upper:]' '[:lower:]'; }

# ---- 主流程 ----
main() {
    check_env
    install_deps

    # 首次启动：清理残留 → 启动
    stop_app 2>/dev/null || true
    echo ""
    start_app

    # 交互循环
    while true; do
        show_menu
        read -r -n 1 -p "> " key
        echo ""
        case "$(lowercase "$key")" in
            r)
                stop_app
                echo ""
                start_app
                ;;
            q)
                stop_app
                # 关闭 Terminal 窗口（macOS 双击启动时）
                osascript -e 'tell application "Terminal" to close front window' 2>/dev/null || true
                exit 0
                ;;
        esac
    done
}

main
