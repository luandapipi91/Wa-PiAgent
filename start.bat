@echo off
chcp 65001 >nul
cd /d "%~dp0"

REM Check bun is installed
where bun >nul 2>nul
if errorlevel 1 (
  echo ================================================
  echo   bun not found
  echo   Install: https://bun.sh
  echo ================================================
  echo.
  pause
  exit /b 1
)

echo [start] bun ready, installing dependencies...
call bun install
if errorlevel 1 (
  echo [start] dependency install failed, please retry
  pause
  exit /b 1
)

echo [start] starting wa-pi (kernel auto-recompiles latest source on every start)...
echo [start] browser will open http://localhost:5180
echo [start] press R to reload frontend and backend code, press Ctrl+C to stop
echo.

bun run dev
