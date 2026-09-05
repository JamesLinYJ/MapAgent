# +-------------------------------------------------------------------------
#
#   地理智能平台 - Windows 一键桌面启动器
#
#   文件:       desktop.ps1
#
#   日期:       2026年07月29日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5.6 Sol
#
#   维护记录 (2026-07-30):
#     作者: JamesLinYJ
#     协助: OpenAI Codex:GPT-5.6 Sol
#     说明: 一键入口接受所有 Node 24 及以上版本，Node 24 仅作为推荐开发版本。
#
#   维护记录 (2026-07-31):
#     作者: JamesLinYJ
#     协助: OpenAI Codex:GPT-5.6 Sol
#     说明: 依据实际依赖引擎范围接纳 Node 22 LTS，并排除依赖未声明支持的 Node 23。
# --------------------------------------------------------------------------

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new()
$Root = [IO.Path]::GetFullPath($PSScriptRoot)

function Test-PlatformNode {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)

    if (-not (Test-Path -LiteralPath $LiteralPath -PathType Leaf)) { return $false }
    try {
        $Version = (& $LiteralPath --version 2>$null).Trim()
        if ($Version -notmatch '^v(?<Major>\d+)\.(?<Minor>\d+)\.') { return $false }
        $Major = [int]$Matches.Major
        $Minor = [int]$Matches.Minor
        return ($Major -eq 22 -and $Minor -ge 13) -or $Major -ge 24
    } catch {
        return $false
    }
}

function Add-PlatformVersionManagerCandidates {
    param(
        [Parameter(Mandatory = $true)]
        [Collections.Generic.List[string]]$Candidates,
        [string]$VersionsRoot,
        [Parameter(Mandatory = $true)]
        [string]$ExecutableRelativePath
    )

    if (-not $VersionsRoot -or -not (Test-Path -LiteralPath $VersionsRoot -PathType Container)) {
        return
    }
    foreach ($VersionDirectory in @(
        Get-ChildItem -LiteralPath $VersionsRoot -Directory -ErrorAction SilentlyContinue |
            Sort-Object -Property Name -Descending
    )) {
        $Candidates.Add((Join-Path $VersionDirectory.FullName $ExecutableRelativePath))
    }
}

function Resolve-PlatformNode {
    $Candidates = [Collections.Generic.List[string]]::new()
    $Configured = [Environment]::GetEnvironmentVariable('GEO_AGENT_PLATFORM_NODE_EXECUTABLE', 'Process')
    if ($Configured) {
        $ConfiguredPath = if ([IO.Path]::IsPathRooted($Configured)) {
            [IO.Path]::GetFullPath($Configured)
        } else {
            [IO.Path]::GetFullPath((Join-Path $Root $Configured))
        }
        $Candidates.Add($ConfiguredPath)
    }

    foreach ($Command in @(Get-Command node.exe -CommandType Application -All -ErrorAction SilentlyContinue)) {
        $Candidates.Add($Command.Source)
    }

    $UserProfile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
    $VoltaRoot = if ($env:VOLTA_HOME) { $env:VOLTA_HOME } else { Join-Path $UserProfile '.volta' }
    $NvmRoot = if ($env:NVM_HOME) { $env:NVM_HOME } else { Join-Path $env:APPDATA 'nvm' }
    $FnmVersionsRoot = if ($env:FNM_DIR) {
        Join-Path $env:FNM_DIR 'node-versions'
    } else {
        Join-Path $env:LOCALAPPDATA 'fnm\node-versions'
    }
    Add-PlatformVersionManagerCandidates `
        -Candidates $Candidates `
        -VersionsRoot (Join-Path $VoltaRoot 'tools\image\node') `
        -ExecutableRelativePath 'node.exe'
    Add-PlatformVersionManagerCandidates `
        -Candidates $Candidates `
        -VersionsRoot $NvmRoot `
        -ExecutableRelativePath 'node.exe'
    Add-PlatformVersionManagerCandidates `
        -Candidates $Candidates `
        -VersionsRoot $FnmVersionsRoot `
        -ExecutableRelativePath 'installation\node.exe'

    $KnownLocations = @(
        (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
        (Join-Path $UserProfile '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe')
    )
    foreach ($Location in $KnownLocations) {
        if ($Location) { $Candidates.Add($Location) }
    }

    foreach ($Candidate in @($Candidates | Select-Object -Unique)) {
        if (Test-PlatformNode -LiteralPath $Candidate) {
            return [IO.Path]::GetFullPath($Candidate)
        }
    }

    throw @'
未找到受支持的 Node.js（22.13 以上的 Node 22 LTS，或 Node 24 及以上版本）。可安装 .node-version 推荐的版本，或将
GEO_AGENT_PLATFORM_NODE_EXECUTABLE 设置为 node.exe 的绝对路径后重新运行 desktop.ps1。
'@
}

$Node = Resolve-PlatformNode
$NodeDirectory = Split-Path -Parent $Node
$env:Path = "$NodeDirectory$([IO.Path]::PathSeparator)$($env:Path)"
$env:GEO_AGENT_PLATFORM_NODE_EXECUTABLE = $Node

& (Join-Path $Root 'dev.ps1') desktop
if ($LASTEXITCODE -ne 0) {
    throw "桌面应用异常退出（exit $LASTEXITCODE）。"
}
