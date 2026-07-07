@echo off
REM Windows 资源管理器双击入口:检查 bun → cd 项目根 → bun run dev
REM 脚本自身只做环境检查和转发,启动逻辑全在 scripts/dev.ts 里。
chcp 65001 >nul
cd /d "%~dp0"

where bun >nul 2>nul
if errorlevel 1 (
  echo ================================================
  echo   错误:未找到 bun
  echo   请先安装:https://bun.sh
  echo   安装后重新双击此文件
  echo ================================================
  echo.
  pause
  exit /b 1
)

echo [start] bun 就绪,启动 hiagent...
echo [start] 浏览器会自动打开 http://localhost:5180
echo [start] 按 Ctrl+C 停止
echo.

bun run dev
