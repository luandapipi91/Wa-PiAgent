@echo off
chcp 65001 >nul
setlocal
rem GPU 诊断 demo 一键运行（Windows）：跑「无开关 / 四个强制开关」两遍，结果落盘并回显。
rem 用法：本文件与 gpu-diagnose.cjs 在 packages\desktop\scripts\ 下，双击即可。
rem 需要 packages\desktop 下已 bun install（提供 node_modules\.bin\electron）。
rem 注意：electron.exe 是 GUI 子系统程序，console.log 不会进 cmd，所以结果一律以文件为准。
cd /d "%~dp0"
set "ELECTRON=%~dp0..\node_modules\.bin\electron.cmd"
if not exist "%ELECTRON%" (
  echo [错误] 找不到 electron：%ELECTRON%
  echo        请先在本仓 packages\desktop 下执行 bun install。
  pause
  exit /b 1
)
set "LOG=%USERPROFILE%\gpu-diagnose.log"
del "%LOG%" 2>nul
echo.
echo [1/2] 正在测「无开关」配置（对照）...
call "%ELECTRON%" "%~dp0gpu-diagnose.cjs" --variant=none
echo [2/2] 正在测「四个强制开关」配置（当前线上配置）...
call "%ELECTRON%" "%~dp0gpu-diagnose.cjs" --variant=prod
echo.
echo ============ 结果（文件：%LOG%） ============
type "%LOG%"
echo ============================================
echo 请把两个 variant 的 [摘要] 与 [时间线] 发回即可。
pause
