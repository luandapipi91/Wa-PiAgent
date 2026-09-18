@echo off
chcp 65001 >nul
setlocal
rem GPU 诊断 demo 一键运行（Windows）：跑「无开关 / 四个强制开关」两遍，结果落盘并回显。
rem 用法：把本文件与 gpu-diagnose.cjs 放在 packages\desktop\scripts\ 下，双击即可。
rem 需要 packages\desktop 下已 bun install（提供 node_modules\.bin\electron）。
cd /d "%~dp0"
set "ELECTRON=%~dp0..\node_modules\.bin\electron.cmd"
if not exist "%ELECTRON%" (
  echo [错误] 找不到 electron：%ELECTRON%
  echo        请先在本仓 packages\desktop 下执行 bun install，或手工执行：
  echo        npx --yes electron@43 gpu-diagnose.cjs --variant=prod
  pause
  exit /b 1
)
set "OUT=%~dp0gpu-diagnose.log"
echo ==== GPU 诊断 demo ==== > "%OUT%"
echo 时间: %DATE% %TIME% >> "%OUT%"
for %%V in (none prod) do (
  echo. >> "%OUT%"
  echo ---------- variant=%%V ---------- >> "%OUT%"
  call "%ELECTRON%" "%~dp0gpu-diagnose.cjs" --variant=%%V >> "%OUT%" 2>&1
)
echo. >> "%OUT%"
echo ================================
echo 完成。结果文件：%OUT%
echo 请把 [摘要] 与 [时间线] 两行（连同 variant=none / variant=prod 的对比）发回。
echo ================================
type "%OUT%"
pause
