# +-------------------------------------------------------------------------
#
#   地理智能平台 - Squirrel 固定构建工具准备器
#
#   文件:       prepare-squirrel-vendor.ps1
#
#   日期:       2026年07月29日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5.6 Sol
# --------------------------------------------------------------------------

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Squirrel 安装器只能在 Windows 构建主机上生成。' }

$Root = [IO.Path]::GetFullPath((Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)))
$DesktopRoot = [IO.Path]::GetFullPath((Join-Path $Root 'apps\desktop'))
$SourceVendor = [IO.Path]::GetFullPath((Join-Path $Root 'node_modules\electron-winstaller\vendor'))
$TargetVendor = [IO.Path]::GetFullPath((Join-Path $DesktopRoot '.squirrel-vendor'))
$ExpectedTarget = [IO.Path]::GetFullPath((Join-Path $DesktopRoot '.squirrel-vendor'))
if (-not $TargetVendor.Equals($ExpectedTarget, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Squirrel vendor 目标目录越出 Desktop 构建缓存边界。'
}
if (-not (Test-Path -LiteralPath $SourceVendor -PathType Container)) {
    throw '缺少 electron-winstaller vendor；请先执行 npm ci。'
}
$SourceVendorItem = Get-Item -LiteralPath $SourceVendor -Force
if (
    ($SourceVendorItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
    $SourceVendorItem.LinkType
) {
    throw 'electron-winstaller vendor 不能是链接或 reparse point。'
}

$NuGetVersion = '6.14.0'
$NuGetUrl = "https://dist.nuget.org/win-x86-commandline/v$NuGetVersion/nuget.exe"
$NuGetSha256 = '92DBED160DDEE0F64B901E907439E021211B428E57C089ECC12FC38DCC4BD9A5'

function Test-SquirrelVendorCache {
    if (-not (Test-Path -LiteralPath $TargetVendor -PathType Container)) { return $false }
    $TargetItem = Get-Item -LiteralPath $TargetVendor -Force
    if (
        ($TargetItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        $TargetItem.LinkType
    ) {
        return $false
    }

    $AllowedTransientFiles = @('Squirrel-Releasify.log', 'electron-windows-sign.log')
    $SourceFiles = @(Get-ChildItem -LiteralPath $SourceVendor -Recurse -File)
    $TargetFiles = @(Get-ChildItem -LiteralPath $TargetVendor -Recurse -File | Where-Object {
        $RelativePath = [IO.Path]::GetRelativePath($TargetVendor, $_.FullName)
        $RelativePath -notin $AllowedTransientFiles
    })
    if ($SourceFiles.Count -ne $TargetFiles.Count) { return $false }

    foreach ($SourceFile in $SourceFiles) {
        if ($SourceFile.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "electron-winstaller vendor 包含不受支持的链接：$($SourceFile.FullName)"
        }
        $RelativePath = [IO.Path]::GetRelativePath($SourceVendor, $SourceFile.FullName)
        $TargetPath = [IO.Path]::GetFullPath((Join-Path $TargetVendor $RelativePath))
        if (
            -not $TargetPath.StartsWith(
                "$TargetVendor$([IO.Path]::DirectorySeparatorChar)",
                [StringComparison]::OrdinalIgnoreCase
            ) -or
            -not (Test-Path -LiteralPath $TargetPath -PathType Leaf)
        ) {
            return $false
        }
        $ExpectedHash = if ($RelativePath.Equals('nuget.exe', [StringComparison]::OrdinalIgnoreCase)) {
            $NuGetSha256
        } else {
            (Get-FileHash -LiteralPath $SourceFile.FullName -Algorithm SHA256).Hash.ToUpperInvariant()
        }
        $ActualHash = (Get-FileHash -LiteralPath $TargetPath -Algorithm SHA256).Hash.ToUpperInvariant()
        if ($ActualHash -ne $ExpectedHash) { return $false }
    }
    return $true
}

if (Test-SquirrelVendorCache) {
    Write-Output "Squirrel vendor：$TargetVendor"
    Write-Output "NuGet：$NuGetVersion ($NuGetSha256)"
    return
}

$StagingVendor = [IO.Path]::GetFullPath((Join-Path $DesktopRoot ".squirrel-vendor.$([Guid]::NewGuid().ToString('N')).tmp"))
if (-not $StagingVendor.StartsWith("$DesktopRoot$([IO.Path]::DirectorySeparatorChar)", [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Squirrel vendor 临时目录越出 Desktop 构建缓存边界。'
}

try {
    Copy-Item -LiteralPath $SourceVendor -Destination $StagingVendor -Recurse
    $NuGetPath = Join-Path $StagingVendor 'nuget.exe'
    Invoke-WebRequest -Uri $NuGetUrl -OutFile $NuGetPath -UseBasicParsing
    $ActualSha256 = (Get-FileHash -LiteralPath $NuGetPath -Algorithm SHA256).Hash.ToUpperInvariant()
    if ($ActualSha256 -ne $NuGetSha256) {
        throw "NuGet $NuGetVersion SHA256 校验失败。"
    }

    if (Test-Path -LiteralPath $TargetVendor) {
        $ExistingTarget = Get-Item -LiteralPath $TargetVendor -Force
        if (
            ($ExistingTarget.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
            $ExistingTarget.LinkType
        ) {
            Remove-Item -LiteralPath $TargetVendor -Force
        } else {
            Remove-Item -LiteralPath $TargetVendor -Recurse -Force
        }
    }
    Move-Item -LiteralPath $StagingVendor -Destination $TargetVendor
} finally {
    if (Test-Path -LiteralPath $StagingVendor) {
        Remove-Item -LiteralPath $StagingVendor -Recurse -Force
    }
}

Write-Output "Squirrel vendor：$TargetVendor"
Write-Output "NuGet：$NuGetVersion ($NuGetSha256)"
