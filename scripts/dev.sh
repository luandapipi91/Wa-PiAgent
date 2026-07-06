#!/usr/bin/env bash
set -e
cd "$(dirname "$0")/.."
echo "=== 启动 Bun 编排内核（后台）==="
bun run packages/kernel/src/index.ts &
KERNEL_PID=$!
trap "kill $KERNEL_PID 2>/dev/null" EXIT
sleep 2
echo "=== 启动 Tauri（前端 + 窗口）==="
cargo tauri dev
