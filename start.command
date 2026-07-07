#!/usr/bin/env bash
# 双击启动入口：macOS Finder 对 .command 文件会自动用 Terminal 执行
# 切换到本文件所在目录（双击时 cwd 默认是 $HOME）
cd "$(dirname "$0")" || exit 1
# 自愈：编辑器/工具覆写可能丢失执行权限，确保 start.sh 可执行
[ -x ./start.sh ] || chmod +x ./start.sh 2>/dev/null
# 启动主脚本；失败时暂停，避免 Terminal 窗口瞬间关闭看不到错误
./start.sh
rc=$?
if [ "$rc" -ne 0 ]; then
    echo ""
    echo "[start.command] start.sh 退出码=$rc"
    echo "按回车键关闭窗口..."
    read
fi
