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

# 从 ~/.zshrc 提取 DEEPSEEK_API_KEY（不 source 整份 zsh 配置，避免 zsh 专用语法在 bash 下报错）
# 说明：start.sh 是 bash 脚本，不能直接 source ~/.zshrc（含 autoload/setopt 等 zsh 专用语法）
if [ -z "${DEEPSEEK_API_KEY:-}" ] && [ -f "$HOME/.zshrc" ]; then
    DEEPSEEK_API_KEY="$(grep -E '^[[:space:]]*export[[:space:]]+DEEPSEEK_API_KEY=' "$HOME/.zshrc" \
        | tail -1 \
        | sed -E "s/^[^=]+=//; s/^\"//; s/\"$//")"
    [ -n "$DEEPSEEK_API_KEY" ] && export DEEPSEEK_API_KEY
fi

# 全局 PID（tauri dev 主进程 + kernel watch 进程）
APP_PID=""
WATCH_PID=""

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

    # fswatch 是 kernel 热更新的依赖（macOS 自带，缺失时降级为手动 R 重启）
    if ! command -v fswatch &>/dev/null; then
        warn "fswatch 未安装，kernel 自动热更新不可用"
        warn "安装方法：brew install fswatch（之后重启 start.command）"
        warn "在此之前可手动按 R 重启 kernel"
    fi

    # 检查 DEEPSEEK_API_KEY（agent 回复必需）
    if [ -z "${DEEPSEEK_API_KEY:-}" ]; then
        warn "DEEPSEEK_API_KEY 未配置，agent 发消息后会报 No API key 错误"
        warn "配置方法：echo 'export DEEPSEEK_API_KEY=\"你的key\"' >> ~/.zshrc"
    fi

    info "bun + node + cargo 就绪"
}

# ---- 确保 pi-intercom broker 可用 ----
# kernel 启动时无条件连接 broker socket，socket 丢失会直接 ENOENT 崩溃。
# 常见诱因：broker 进程还在但 socket 文件被清理（僵尸状态）。
# 这里在 kernel 启动前自愈：socket 不可连就重启 broker。
BROKER_SOCK="$HOME/.pi/agent/intercom/broker.sock"
PI_AGENT_DIR="$HOME/.pi/agent/npm"

ensure_broker() {
    # socket 存在且可连 → 无需处理
    if [ -S "$BROKER_SOCK" ]; then
        info "broker socket 就绪"
        return 0
    fi

    warn "broker socket 不存在（${BROKER_SOCK}），尝试自愈..."

    # 清理僵尸 broker 进程（进程在但 socket 丢了）
    local stale
    stale=$(pgrep -f "pi-intercom/broker/broker.ts" 2>/dev/null || true)
    if [ -n "$stale" ]; then
        warn "发现僵尸 broker 进程（${stale}），清理中..."
        echo "$stale" | xargs kill -9 2>/dev/null || true
        sleep 1
    fi

    # 重启 broker（需要在装了 pi-intercom 的目录执行 npm exec）
    if [ ! -d "$PI_AGENT_DIR" ]; then
        err "pi-agent 目录不存在：$PI_AGENT_DIR"
        err "kernel 会因连不上 broker 而崩溃，请先安装 pi-agent"
        return 1
    fi

    echo "[INFO] 启动 broker..."
    (cd "$PI_AGENT_DIR" && nohup npm exec tsx \
        "$PI_AGENT_DIR/node_modules/pi-intercom/broker/broker.ts" \
        > /tmp/hiagent_broker.log 2>&1 &)

    # 等待 socket 出现（最多 8 秒）
    local i
    for i in $(seq 1 8); do
        [ -S "$BROKER_SOCK" ] && break
        sleep 1
    done

    if [ -S "$BROKER_SOCK" ]; then
        info "broker 已就绪（等待 ${i} 秒）"
    else
        err "broker 启动失败，详见 /tmp/hiagent_broker.log"
        err "kernel 会因连不上 broker 而崩溃"
        return 1
    fi
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
    stop_watch
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

# ---- 启动 kernel 源码 watch（热更新编译）----
# 监听 kernel/src + shared/src → 500ms 去抖 → bun build 重编二进制
# Rust 侧的 notify 会自动检测到新二进制并重启 sidecar（无需这里操心）
start_watch() {
    # 已在跑就先停
    stop_watch
    # fswatch 缺失则跳过（check_env 已 warn 过）
    command -v fswatch &>/dev/null || return 0

    echo "[INFO] 启动 kernel 源码监听（热更新）..."
    (
        # -l 500 = 500ms latency 去抖；-r 递归；-o 只输出事件计数
        fswatch -o -r -l 500 \
            "$ROOT_DIR/packages/kernel/src" \
            "$ROOT_DIR/packages/shared/src" \
        | while read -r _; do
            echo "[watch] 检测到 kernel/shared 源码变化，重编中..."
            if (cd "$ROOT_DIR" && bun run --filter @hiagent/kernel build 2>&1); then
                info "[watch] 重编完成，Rust 将自动重启 sidecar"
            else
                err "[watch] 重编失败（TS/编译错误？），修正后保存自动重试"
            fi
        done
    ) &
    WATCH_PID=$!
    info "kernel 源码监听已启动 (PID=$WATCH_PID)"
}

# ---- 停止 watch 进程 ----
stop_watch() {
    if [ -n "$WATCH_PID" ] && kill -0 "$WATCH_PID" 2>/dev/null; then
        kill -9 "$WATCH_PID" 2>/dev/null || true
        wait "$WATCH_PID" 2>/dev/null || true
        info "kernel 源码监听已停止"
    fi
    WATCH_PID=""
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
    echo "  热更新   : 改 kernel/shared 自动重编+重启 sidecar"
    echo "             改 frontend 由 Vite HMR 自动生效"
    echo "=================================================="

    # 启动 kernel 源码监听（热更新）
    start_watch
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
    echo "|  热更新已自动开启（改 kernel/shared 自动生效）  |"
    echo "|  [R] 全量重启（兜底）  [Q] 退出                 |"
    echo "+------------------------------------------------+"
}

lowercase() { echo "$1" | tr '[:upper:]' '[:lower:]'; }

# ---- 主流程 ----
main() {
    check_env
    ensure_broker
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
