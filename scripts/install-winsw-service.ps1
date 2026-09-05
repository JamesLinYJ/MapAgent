# +-------------------------------------------------------------------------
#
#   地理智能平台 - WinSW 专用账户服务注册器
#
#   文件:       install-winsw-service.ps1
#
#   日期:       2026年07月21日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5.6 Sol
# --------------------------------------------------------------------------

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Supervisor')]
    [string]$Service,

    [Parameter(Mandatory = $true)]
    [switch]$CredentialPrompt,

    [string]$ServiceRoot = (Join-Path $env:ProgramData 'GeoAgentPlatform\services')
)

$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'WinSW 服务只能在 Windows 上注册。' }
$Principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw '注册 Windows 服务需要管理员权限。'
}
if (-not $CredentialPrompt) { throw '必须显式使用 -CredentialPrompt，以专用非管理员账户注册服务。' }

$BaseName = "GeoAgentPlatform$Service"
$Executable = [IO.Path]::GetFullPath((Join-Path $ServiceRoot "$BaseName\$BaseName.exe"))
$Configuration = [IO.Path]::ChangeExtension($Executable, '.xml')
if (-not (Test-Path -LiteralPath $Executable -PathType Leaf) -or -not (Test-Path -LiteralPath $Configuration -PathType Leaf)) {
    throw 'WinSW 同名 exe/xml 服务包不存在；请先运行 prepare-winsw-services.ps1。'
}
if (Get-Service -Name $BaseName -ErrorAction SilentlyContinue) { throw "服务 $BaseName 已存在。" }

& $Executable install /p
if ($LASTEXITCODE -ne 0) { throw "WinSW 注册 $BaseName 失败。" }
$Installed = Get-CimInstance Win32_Service -Filter "Name='$BaseName'"
if (-not $Installed -or $Installed.StartName -in @('LocalSystem', 'NT AUTHORITY\LocalService', 'NT AUTHORITY\NetworkService')) {
    throw '服务未注册到专用账户；请卸载后重新使用正确账户。'
}
Write-Output "已注册 $BaseName，登录账户：$($Installed.StartName)。验证 ACL 后再手动启动。"
