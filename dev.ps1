# +-------------------------------------------------------------------------
#
#   地理智能平台 - PowerShell 开发入口
#
#   文件:       dev.ps1
#
#   日期:       2026年04月14日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5.6 Sol
# --------------------------------------------------------------------------

# 平台的跨系统开发语义由 TypeScript 启动器统一拥有；本文件只保留 PowerShell 进程入口。
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$LauncherArguments
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $Root
if ($env:GEO_AGENT_PLATFORM_NODE_EXECUTABLE) {
    $NodeDirectory = Split-Path -Parent ([IO.Path]::GetFullPath($env:GEO_AGENT_PLATFORM_NODE_EXECUTABLE))
    $env:Path = "$NodeDirectory$([IO.Path]::PathSeparator)$env:Path"
}
& npm run dev --workspace '@geo-agent-platform/operations-supervisor' -- @LauncherArguments
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
