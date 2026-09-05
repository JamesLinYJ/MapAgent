# +-------------------------------------------------------------------------
#
#   地理智能平台 - Windows Worker 进程入口
#
#   文件:       run-worker.ps1
#
#   日期:       2026年07月21日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5.6 Sol
#
#   维护记录 (2026-07-23):
#     作者: JamesLinYJ
#     协助: OpenAI Codex:GPT-5.6 Sol
#     说明: 移除开发期 Uvicorn reload 子监督器，统一由平台监督进程生命周期。
# --------------------------------------------------------------------------

$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath((Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)))
Set-Location -LiteralPath $Root

$ConfiguredPython = [Environment]::GetEnvironmentVariable('WORKER_PYTHON', 'Process')
if (-not $ConfiguredPython) {
    throw 'Worker 启动失败：缺少 WORKER_PYTHON。'
}

$PythonCommand = if (Test-Path -LiteralPath $ConfiguredPython -PathType Leaf) {
    if ([IO.Path]::IsPathRooted($ConfiguredPython)) {
        [IO.Path]::GetFullPath($ConfiguredPython)
    } else {
        [IO.Path]::GetFullPath((Join-Path $Root $ConfiguredPython))
    }
} else {
    $Resolved = Get-Command $ConfiguredPython -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $Resolved) {
        throw 'Worker 启动失败：WORKER_PYTHON 指向的解释器不存在。'
    }
    $Resolved.Source
}

$WorkerPort = 0
if (-not [int]::TryParse($env:WORKER_PORT, [ref]$WorkerPort) -or $WorkerPort -lt 1 -or $WorkerPort -gt 65535) {
    throw 'Worker 启动失败：WORKER_PORT 必须是 1 到 65535 之间的整数。'
}

$Arguments = @(
    # HTTP 控制面保持单进程；科学计算并发由应用内可终止进程池统一承载。
    '-m', 'uvicorn',
    'worker_app.sidecar:app',
    '--app-dir', 'apps/worker/src',
    '--host', '127.0.0.1',
    '--port', [string]$WorkerPort,
    '--no-access-log'
)

& $PythonCommand @Arguments
exit $LASTEXITCODE
