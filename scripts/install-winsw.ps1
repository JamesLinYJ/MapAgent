# +-------------------------------------------------------------------------
#
#   地理智能平台 - WinSW 固定版本安装器
#
#   文件:       install-winsw.ps1
#
#   日期:       2026年07月21日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5.6 Sol
# --------------------------------------------------------------------------

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Manifest = Get-Content -LiteralPath (Join-Path $Root 'vendor\operations\checksums.json') -Raw | ConvertFrom-Json
$Version = [string]$Manifest.winSW.version
if ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') {
    throw '当前 WinSW 固定安装包仅支持 Windows amd64。'
}
$Expected = [string]$Manifest.winSW.windows_amd64
$ToolRoot = [IO.Path]::GetFullPath((Join-Path $Root "runtime\tools\winsw\$Version"))
New-Item -ItemType Directory -Path $ToolRoot -Force | Out-Null
$Executable = Join-Path $ToolRoot 'WinSW.exe'
if (-not (Test-Path -LiteralPath $Executable)) {
    Invoke-WebRequest -Uri "https://github.com/winsw/winsw/releases/download/v$Version/WinSW-x64.exe" -OutFile $Executable -UseBasicParsing
}
$Actual = (Get-FileHash -LiteralPath $Executable -Algorithm SHA256).Hash.ToLowerInvariant()
if ($Actual -ne $Expected.ToLowerInvariant()) {
    Remove-Item -LiteralPath $Executable -Force
    throw "WinSW 发布包 SHA256 校验失败；期望 $Expected，实际 $Actual。"
}
Write-Output $Executable
