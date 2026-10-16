# 打包版冷启动取证脚本（隔离环境版）。
#
# 为什么必须隔离：本机同时运行着生产实例（安装版 WA PI Agent + WaPiKernel）。用独立
# WA_PI_DIR（数据/日志/登记簿）+ 独立端口 + 独立 user-data-dir 起 smoke 实例，日志互不
# 污染，也绝不会碰到生产进程。测完只杀自己起的这棵树。
#
# 用法：
#   powershell -File smoke-coldstart.ps1 -Tag before1 -Wipe        # 全新数据目录首启
#   powershell -File smoke-coldstart.ps1 -Tag before2              # 复用数据目录（稳态启动）
#
# 输出：$env:TEMP\wapi-runs\<Tag>.log（本次新增的全部日志行）+ 控制台摘要。
param(
  [Parameter(Mandatory = $true)][string]$Tag,
  [switch]$Wipe,
  [int]$TimeoutSec = 900,
  [string]$Exe = "H:\workspace\hiagent\packages\desktop\release\win-unpacked\WA PI Agent.exe",
  [int]$Port = 9888
)

# 注意：这里不能用 Stop —— taskkill 对「已退出的子进程」会往 stderr 写字，
# Stop 模式下 PowerShell 会把它当终止错误直接中断脚本，导致摘要与清理半途而废。
$ErrorActionPreference = "Continue"
$dir = Join-Path $env:TEMP "wapi-smoke"
$udd = Join-Path $env:TEMP "wapi-smoke-udd"
$outDir = Join-Path $env:TEMP "wapi-runs"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$log = Join-Path $dir "logs\desktop.log"

# 只认自己的进程：命令行含本次独立 user-data-dir / 可执行文件在本仓库 release 下
function Get-SmokeProcs {
  Get-CimInstance Win32_Process | Where-Object {
    ($_.Name -eq "WA PI Agent.exe" -and $_.CommandLine -like "*wapi-smoke-udd*") -or
    ($_.Name -eq "WaPiKernel.exe" -and $_.ExecutablePath -like "*hiagent\packages\desktop\release*")
  }
}

# 杀干净并等到真的一干二净：Electron 的渲染/GPU 子进程与内核退出有延迟，
# 杀完立刻起下一个会被残留进程占着的单实例锁挡掉（表现为新实例 0.5s 就退出、日志无输出）
function Stop-AllSmokeProcs {
  for ($round = 1; $round -le 10; $round++) {
    $procs = Get-SmokeProcs
    if (-not $procs) { return $true }
    foreach ($s in $procs) { & taskkill /PID $s.ProcessId /T /F 2>&1 | Out-Null }
    Start-Sleep -Milliseconds 700
  }
  return (@(Get-SmokeProcs).Count -eq 0)
}

# 前置检查：确认没有上一次 smoke 残留占着端口/数据目录（否则读到的日志归属不清）
if (Stop-AllSmokeProcs -eq $false) { Write-Host "[smoke] 警告：残留 smoke 进程未能清干净" }

if ($Wipe) {
  Remove-Item -Recurse -Force $dir, $udd -ErrorAction SilentlyContinue
  Write-Host "[smoke] 已清空隔离数据目录（模拟首次安装后的首启）"
}
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null

# 记录起始行号：只取本次新增的日志（区分「本次启动」与历史行）
$before = 0
if (Test-Path $log) { $before = @(Get-Content $log -Encoding UTF8 -ErrorAction SilentlyContinue).Count }

$env:WA_PI_DIR = $dir
$env:WA_PI_WS_PORT = "$Port"

$t0 = Get-Date
$proc = Start-Process -FilePath $Exe -ArgumentList "--wa-pi-port=$Port", "--user-data-dir=$udd" -PassThru
Write-Host "[smoke] pid=$($proc.Id) 启动，等待 [startup] 时间线…"

$deadline = (Get-Date).AddSeconds($TimeoutSec)
$exited = $false
$sawStartup = $false
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 200
  if ($proc.HasExited) {
    $exited = $true
    Start-Sleep -Milliseconds 1500 # 退出时日志是异步写入，等一下再读（否则抢跑读到空）
  }
  if (Test-Path $log) {
    $lines = @(Get-Content $log -Encoding UTF8 -ErrorAction SilentlyContinue)
    if ($lines.Count -gt $before) {
      $new = $lines[$before..($lines.Count - 1)]
      if ($new | Where-Object { $_ -match '\[startup\].*firstFrame=' }) { $sawStartup = $true; break }
    }
  }
  if ($exited) { break }
}

$wall = [math]::Round(((Get-Date) - $t0).TotalMilliseconds)
$lines = @(Get-Content $log -Encoding UTF8 -ErrorAction SilentlyContinue)
$new = if ($lines.Count -gt $before) { $lines[$before..($lines.Count - 1)] } else { @() }
$new | Set-Content (Join-Path $outDir "$Tag.log") -Encoding UTF8

Write-Host "===== RUN $Tag ====="
Write-Host "[smoke] 启动→主窗口首帧 wall=${wall}ms  取样成功=$sawStartup  进程已自行退出=$exited"
Write-Host "[smoke] 日志新增 $($new.Count) 行 → $outDir\$Tag.log"
$new | Where-Object {
  $_ -match '\[startup\]|\[deps\]|kernel sidecar pid|kernel 就绪|\[GPU\]|\[node-runtime\]|\[runtime-bin\]'
} | ForEach-Object { Write-Host "  $_" }

# 清理：只杀本次起的这棵树（含 electron 渲染/GPU 子进程与 smoke kernel）
$clean = Stop-AllSmokeProcs
Write-Host "[smoke] 清理完成=$clean"
