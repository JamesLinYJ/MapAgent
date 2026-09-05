# +-------------------------------------------------------------------------
#
#   地理智能平台 - Windows 服务固定入口
#
#   文件:       run-windows-service.ps1
#
#   日期:       2026年07月21日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5.6 Sol
# --------------------------------------------------------------------------

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Supervisor')]
    [string]$Component,

    [Parameter(Mandatory = $true)]
    [string]$EnvironmentFile
)

$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath((Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)))
$EnvironmentFile = [IO.Path]::GetFullPath($EnvironmentFile)
if (-not (Test-Path -LiteralPath $EnvironmentFile -PathType Leaf)) {
    throw "服务环境文件不存在：$EnvironmentFile"
}

$Seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($Line in Get-Content -LiteralPath $EnvironmentFile) {
    $Text = $Line.Trim()
    if (-not $Text -or $Text.StartsWith('#')) { continue }
    if (-not $Text.Contains('=')) { throw '服务环境文件包含无效行。' }
    $Parts = $Text.Split('=', 2)
    $Name = $Parts[0].Trim()
    if ($Name -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { throw '服务环境文件包含无效变量名。' }
    if (-not $Seen.Add($Name)) { throw "服务环境文件包含重复变量：$Name" }
    $Value = $Parts[1].Trim()
    if (($Value.StartsWith('"') -and $Value.EndsWith('"')) -or ($Value.StartsWith("'") -and $Value.EndsWith("'"))) {
        $Value = $Value.Substring(1, $Value.Length - 2)
    }
    [Environment]::SetEnvironmentVariable($Name, $Value, 'Process')
}

[Environment]::SetEnvironmentVariable('GEO_AGENT_PLATFORM_ROOT', $Root, 'Process')
Set-Location -LiteralPath $Root

$Executable = Join-Path $Root 'packages\operations-supervisor\dist\cli.js'
$TokenFile = [Environment]::GetEnvironmentVariable('GEO_AGENT_PLATFORM_SUPERVISOR_TOKEN_FILE', 'Process')
if (-not $TokenFile) { throw '监督服务环境缺少 GEO_AGENT_PLATFORM_SUPERVISOR_TOKEN_FILE。' }
$TokenFile = if ([IO.Path]::IsPathRooted($TokenFile)) {
    [IO.Path]::GetFullPath($TokenFile)
} else {
    [IO.Path]::GetFullPath((Join-Path $Root $TokenFile))
}
if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) { throw 'TypeScript 监督器构建产物不存在；请先完成生产构建。' }
if (-not (Test-Path -LiteralPath $TokenFile -PathType Leaf)) { throw '监督令牌文件不存在。' }
$Node = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
& $Node $Executable daemon --root $Root --profile production --token-file $TokenFile
exit $LASTEXITCODE
