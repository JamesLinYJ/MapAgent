// +-------------------------------------------------------------------------
//
//   地理智能平台 - Desktop 发布签名策略
//
//   文件:       desktopSigningPolicy.mjs
//
//   日期:       2026年09月03日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { existsSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { resolveMacApplication } from './desktopPackageOutput.mjs'

/** 只有明确的 Windows 生产构建才读取 CI 注入的签名输入。 */
export function resolveWindowsSigningOptions(
  environment,
  isReleaseBuild,
  hostPlatform = process.platform,
) {
  if (!isReleaseBuild || hostPlatform !== 'win32') return undefined
  const certificateFile = environment.WINDOWS_CERTIFICATE_FILE?.trim()
  const certificatePassword = environment.WINDOWS_CERTIFICATE_PASSWORD
  if (!certificateFile && !certificatePassword) {
    throw new Error('Windows 生产发布必须配置签名证书。')
  }
  if (!certificateFile || !certificatePassword) {
    throw new Error('Windows 签名证书文件与密码必须同时设置。')
  }
  if (!path.win32.isAbsolute(certificateFile) || !existsSync(certificateFile)) {
    throw new Error('WINDOWS_CERTIFICATE_FILE 必须指向存在的绝对 PFX 文件。')
  }

  const timestampServer = environment.WINDOWS_TIMESTAMP_SERVER?.trim()
    || 'https://timestamp.digicert.com'
  const timestampUrl = new URL(timestampServer)
  if (
    timestampUrl.protocol !== 'https:'
    || timestampUrl.username
    || timestampUrl.password
    || timestampUrl.search
    || timestampUrl.hash
  ) {
    throw new Error('WINDOWS_TIMESTAMP_SERVER 必须是无凭据、查询参数或片段的 HTTPS URL。')
  }
  return {
    automaticallySelectCertificate: true,
    certificateFile,
    certificatePassword,
    hashes: ['sha256'],
    timestampServer: timestampUrl.toString(),
  }
}

/**
 * 只有明确的 macOS 生产构建才读取发布流水线注入的签名输入；
 * 本策略不探测系统钥匙串。
 */
export function resolveMacosPackagingOptions(
  environment,
  isReleaseBuild,
  hostPlatform = process.platform,
) {
  if (!isReleaseBuild || hostPlatform !== 'darwin') {
    return { sign: undefined, notarize: undefined }
  }
  const identity = environment.MACOS_SIGNING_IDENTITY?.trim()
  const appleApiKey = environment.APPLE_API_KEY?.trim()
  const appleApiIssuer = environment.APPLE_API_ISSUER?.trim()
  const values = [identity, appleApiKey, appleApiIssuer]
  const configured = values.filter(Boolean).length
  if (configured === 0) {
    throw new Error('macOS 生产发布必须配置签名与公证凭据。')
  }
  if (configured !== values.length) {
    throw new Error('macOS 签名身份与 App Store Connect API 凭据必须同时设置。')
  }
  if (!path.isAbsolute(appleApiKey) || !existsSync(appleApiKey)) {
    throw new Error('APPLE_API_KEY 必须指向存在的绝对 P8 文件。')
  }
  return {
    sign: {
      identity,
      hardenedRuntime: true,
    },
    notarize: {
      appleApiKey,
      appleApiIssuer,
    },
  }
}

/** 在对应发布凭据已显式配置时验证 Forge 应用产物。 */
export async function verifySignedPackageOutputs({
  environment,
  executableFilename,
  outputPaths,
  platform,
}) {
  if (platform === 'darwin' && hasMacosSigningCredentials(environment)) {
    await Promise.all(outputPaths.map(verifySignedMacApplication))
  } else if (platform === 'win32' && hasWindowsSigningCredentials(environment)) {
    await Promise.all(outputPaths.map(outputPath => verifySignedWindowsApplication(
      outputPath,
      executableFilename,
    )))
  }
}

/** macOS 测试包写入可见标记后重新执行临时签名并验证。 */
export function signAdhocMacApplication(applicationPath) {
  runRequired('codesign', ['--force', '--deep', '--sign', '-', applicationPath])
  runRequired('codesign', [
    '--verify',
    '--deep',
    '--strict',
    '--verbose=4',
    applicationPath,
  ])
}

function hasWindowsSigningCredentials(environment) {
  return Boolean(environment.WINDOWS_CERTIFICATE_FILE?.trim())
    && Boolean(environment.WINDOWS_CERTIFICATE_PASSWORD)
}

function hasMacosSigningCredentials(environment) {
  return Boolean(environment.MACOS_SIGNING_IDENTITY?.trim())
    && Boolean(environment.APPLE_API_KEY?.trim())
    && Boolean(environment.APPLE_API_ISSUER?.trim())
}

function verifySignedWindowsApplication(outputPath, executableFilename) {
  const application = path.join(outputPath, executableFilename)
  const command = [
    "$ErrorActionPreference = 'Stop'",
    '$signature = Get-AuthenticodeSignature -LiteralPath $args[0]',
    'if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) { throw "Authenticode signature is $($signature.Status)" }',
  ].join('; ')
  runRequired('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command, application])
}

async function verifySignedMacApplication(outputPath) {
  const applicationPath = await resolveMacApplication(outputPath)
  runRequired('codesign', [
    '--verify',
    '--deep',
    '--strict',
    '--verbose=4',
    applicationPath,
  ])
  runRequired('spctl', ['--assess', '--type', 'execute', '--verbose=4', applicationPath])
}

function runRequired(file, arguments_) {
  const result = spawnSync(file, arguments_, { stdio: 'inherit' })
  if (result.error || result.status !== 0) {
    throw new Error(`发布签名验证命令失败：${file} ${arguments_.join(' ')}`)
  }
}
