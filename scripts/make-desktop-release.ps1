# +-------------------------------------------------------------------------
#
#   地理智能平台 - Windows Desktop 签名发布构建
#
#   文件:       make-desktop-release.ps1
#
#   日期:       2026年07月29日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5.6 Sol
# --------------------------------------------------------------------------

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Windows 签名发布只能在 Windows 构建主机上执行。' }

$Root = [IO.Path]::GetFullPath((Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)))
$CertificateFile = [Environment]::GetEnvironmentVariable('WINDOWS_CERTIFICATE_FILE', 'Process')
$CertificatePassword = [Environment]::GetEnvironmentVariable('WINDOWS_CERTIFICATE_PASSWORD', 'Process')
if (-not $CertificateFile -or -not [IO.Path]::IsPathFullyQualified($CertificateFile)) {
    throw 'WINDOWS_CERTIFICATE_FILE 必须是绝对 PFX 文件路径。'
}
$CertificateFile = [IO.Path]::GetFullPath($CertificateFile)
if (-not (Test-Path -LiteralPath $CertificateFile -PathType Leaf)) {
    throw 'WINDOWS_CERTIFICATE_FILE 指向的 PFX 文件不存在。'
}
if (-not $CertificatePassword) {
    throw 'WINDOWS_CERTIFICATE_PASSWORD 不能为空。'
}

$PreviousReleaseBuild = [Environment]::GetEnvironmentVariable('GEO_AGENT_PLATFORM_RELEASE_BUILD', 'Process')
try {
    [Environment]::SetEnvironmentVariable('GEO_AGENT_PLATFORM_RELEASE_BUILD', '1', 'Process')
    Push-Location -LiteralPath $Root
    try {
        & npm.cmd run make --workspace '@geo-agent-platform/desktop'
        if ($LASTEXITCODE -ne 0) { throw 'Desktop 签名 make 失败。' }
    } finally {
        Pop-Location
    }
} finally {
    [Environment]::SetEnvironmentVariable('GEO_AGENT_PLATFORM_RELEASE_BUILD', $PreviousReleaseBuild, 'Process')
}

$DesktopReleaseRoot = Join-Path $Root 'apps\desktop\release'
$IdentityModule = Join-Path $Root 'packages\shared-types\dist\productIdentity.js'
if (-not (Test-Path -LiteralPath $IdentityModule -PathType Leaf)) {
    throw '产品身份模块尚未构建。'
}
$IdentityJson = & node.exe --input-type=module -e @'
import { pathToFileURL } from "node:url";
const identity = await import(pathToFileURL(process.argv[1]).href);
process.stdout.write(JSON.stringify({
  executableBaseName: identity.PRODUCT_EXECUTABLE_BASENAME,
}));
'@ $IdentityModule
if ($LASTEXITCODE -ne 0) { throw '无法读取产品身份事实源。' }
$Identity = $IdentityJson | ConvertFrom-Json
$ExecutableBaseName = [string]$Identity.executableBaseName
if (-not $ExecutableBaseName) { throw '产品身份事实源缺少 executableBaseName。' }
$DesktopVersion = [string](
    Get-Content -LiteralPath (Join-Path $Root 'apps\desktop\package.json') -Raw |
        ConvertFrom-Json
).version
$ApplicationDirectoryName = "$ExecutableBaseName-win32-x64"
$SetupPath = Join-Path $DesktopReleaseRoot "make\squirrel.windows\x64\$ExecutableBaseName-$DesktopVersion-Setup.exe"
$ApplicationPath = Join-Path $DesktopReleaseRoot "$ApplicationDirectoryName\$ExecutableBaseName.exe"
$ZipPath = Join-Path $DesktopReleaseRoot "make\zip\win32\x64\$ApplicationDirectoryName-$DesktopVersion.zip"
$RequiredSignedFiles = @($SetupPath, $ApplicationPath)
foreach ($File in $RequiredSignedFiles) {
    if (-not (Test-Path -LiteralPath $File -PathType Leaf)) {
        throw "签名发布缺少预期产物：$File"
    }
    $Signature = Get-AuthenticodeSignature -LiteralPath $File
    if ($Signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
        throw "Authenticode 签名验证失败：$File ($($Signature.Status))"
    }
}

$UnsignedMarker = Join-Path $DesktopReleaseRoot "$ApplicationDirectoryName\UNSIGNED-TEST-BUILD.txt"
if (Test-Path -LiteralPath $UnsignedMarker) {
    throw '签名发布目录仍包含 UNSIGNED TEST 标记。'
}
if (-not (Test-Path -LiteralPath $ZipPath -PathType Leaf)) {
    throw "签名发布缺少预期 ZIP：$ZipPath"
}

$ZipInspectionRoot = Join-Path ([IO.Path]::GetTempPath()) "geo-agent-platform-release-$([Guid]::NewGuid().ToString('N'))"
try {
    [IO.Compression.ZipFile]::ExtractToDirectory($ZipPath, $ZipInspectionRoot)
    if (Test-Path -LiteralPath (Join-Path $ZipInspectionRoot 'UNSIGNED-TEST-BUILD.txt')) {
        throw '签名发布 ZIP 仍包含 UNSIGNED TEST 标记。'
    }
    $ZipApplication = Join-Path $ZipInspectionRoot "$ExecutableBaseName.exe"
    $ZipSignature = Get-AuthenticodeSignature -LiteralPath $ZipApplication
    if ($ZipSignature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
        throw "ZIP 内应用 Authenticode 签名验证失败：$($ZipSignature.Status)"
    }
} finally {
    if (Test-Path -LiteralPath $ZipInspectionRoot) {
        Remove-Item -LiteralPath $ZipInspectionRoot -Recurse -Force
    }
}

Write-Output "签名安装器：$SetupPath"
Write-Output "签名应用：$ApplicationPath"
Write-Output "签名应用 ZIP：$ZipPath"
