// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面运行时配置
//
//   文件:       runtimeConfig.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { app } from 'electron'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import {
  PLATFORM_TECHNICAL_ID,
} from '@geo-agent-platform/shared-types/product-identity'

import {
  applyControlledRuntimeEnvironment,
  DESKTOP_RUNTIME_MANIFEST_FILENAME,
  loadDesktopRuntimeManifest,
  type RuntimeManifestProtectionOptions,
  validateDesktopRuntimeFilesystemTargets,
} from './runtimeManifest.js'

const absolutePathSchema = z.string().trim().min(1).refine(path.isAbsolute, '路径必须是绝对路径。')
const httpBaseUrlSchema = z.string().url().superRefine((value, context) => {
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    context.addIssue({ code: 'custom', message: 'API 地址只允许 HTTP 或 HTTPS。' })
  }
  if (url.username || url.password || url.search || url.hash) {
    context.addIssue({ code: 'custom', message: 'API 地址不能包含凭据、查询参数或片段。' })
  }
})

export interface DesktopRuntimeConfig {
  projectRoot: string
  runtimeRoot: string
  supervisorTokenFile: string
  apiBaseUrl: string
  profile: 'development' | 'production'
  runtimeManifestPath: string | null
  autoAuth: DesktopAutoAuthConfig | null
}

export interface DesktopAutoAuthConfig {
  mode: 'local_managed'
}

export interface DesktopRuntimeResolutionContext {
  profile?: DesktopRuntimeConfig['profile']
  applicationPath?: string
  platform?: NodeJS.Platform
  runtimeManifestPath?: string
  manifestProtection?: RuntimeManifestProtectionOptions
}

export function resolveDesktopRuntimeConfig(
  environment: NodeJS.ProcessEnv,
  context: DesktopRuntimeResolutionContext = {},
): DesktopRuntimeConfig {
  const profile = context.profile ?? (app.isPackaged ? 'production' : 'development')
  const productionValues = profile === 'production'
    ? resolveProductionRuntimeValues(environment, context)
    : null
  const projectRoot = productionValues?.projectRoot
    ?? resolveDevelopmentProjectRoot(environment, context.applicationPath ?? app.getAppPath())
  const runtimeRoot = productionValues?.runtimeRoot ?? resolveProjectPath(
    projectRoot,
    environment.RUNTIME_ROOT,
    path.join(projectRoot, 'runtime'),
  )
  const apiBaseUrl = productionValues?.apiBaseUrl ?? httpBaseUrlSchema.parse(
    (environment.APP_BASE_URL?.trim() || `http://127.0.0.1:${parsePort(environment.API_PORT) ?? 8000}`)
      .replace(/\/+$/u, ''),
  )
  const autoAuth = resolveDesktopAutoAuthConfig({
    environment,
    profile,
    runtimeRoot,
    apiBaseUrl,
  })
  const supervisorTokenFile = productionValues?.supervisorTokenFile ?? resolveProjectPath(
    projectRoot,
    environment.GEO_AGENT_PLATFORM_SUPERVISOR_TOKEN_FILE,
    path.join(runtimeRoot, 'ops', 'supervisor.token'),
  )
  return {
    projectRoot,
    runtimeRoot,
    supervisorTokenFile,
    apiBaseUrl,
    profile,
    runtimeManifestPath: productionValues?.manifestPath ?? null,
    autoAuth,
  }
}

export function resolveDesktopAutoAuthConfig(input: {
  environment: NodeJS.ProcessEnv
  profile: DesktopRuntimeConfig['profile']
  runtimeRoot: string
  apiBaseUrl: string
}): DesktopAutoAuthConfig | null {
  const enabled = parseBoolean(
    input.environment.GEO_AGENT_PLATFORM_DESKTOP_AUTO_AUTH,
    'GEO_AGENT_PLATFORM_DESKTOP_AUTO_AUTH',
    true,
  )
  if (!enabled) return null

  if (!isLoopbackUrl(input.apiBaseUrl)) {
    throw new Error('本机托管身份只允许连接本机回环 API；远程部署请启用扩展账号模式。')
  }
  return { mode: 'local_managed' }
}

function resolveDevelopmentProjectRoot(
  environment: NodeJS.ProcessEnv,
  applicationPath: string,
): string {
  const configured = environment.GEO_AGENT_PLATFORM_ROOT?.trim()
  if (configured) return absolutePathSchema.parse(configured)

  let candidate = path.resolve(applicationPath)
  while (true) {
    if (isWorkspaceRoot(candidate)) return absolutePathSchema.parse(candidate)
    const parent = path.dirname(candidate)
    if (parent === candidate) break
    candidate = parent
  }
  throw new Error(
    '无法从 Desktop 应用目录定位开发工作区；请通过 GEO_AGENT_PLATFORM_ROOT 显式指定项目根目录。',
  )
}

function resolveProjectPath(projectRoot: string, configured: string | undefined, fallback: string): string {
  const value = configured?.trim()
  return absolutePathSchema.parse(value ? path.resolve(projectRoot, value) : fallback)
}

function isWorkspaceRoot(candidate: string): boolean {
  try {
    const manifest: unknown = JSON.parse(readFileSync(path.join(candidate, 'package.json'), 'utf8'))
    if (!manifest || typeof manifest !== 'object' || !('workspaces' in manifest)) return false
    return Array.isArray(manifest.workspaces)
      && manifest.workspaces.every(workspace => typeof workspace === 'string')
      && manifest.workspaces.length > 0
  } catch {
    return false
  }
}

function resolveProductionRuntimeValues(
  environment: NodeJS.ProcessEnv,
  context: DesktopRuntimeResolutionContext,
): {
  projectRoot: string
  runtimeRoot: string
  supervisorTokenFile: string
  apiBaseUrl: string
  manifestPath: string
} {
  const platform = context.platform ?? process.platform
  const manifestPath = context.runtimeManifestPath
    ?? defaultDesktopRuntimeManifestPath(platform, environment)
  const manifest = loadDesktopRuntimeManifest(manifestPath, {
    platform,
    ...context.manifestProtection,
  })
  const values = applyControlledRuntimeEnvironment(manifest, environment)
  validateDesktopRuntimeFilesystemTargets(values, platform)
  return {
    ...values,
    manifestPath,
  }
}

export function defaultDesktopRuntimeManifestPath(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv = {},
): string {
  if (platform === 'win32') {
    const programData = environment.ProgramData?.trim()
    if (!programData || !path.win32.isAbsolute(programData)) {
      throw new Error('生产桌面环境缺少有效的 Windows ProgramData 系统目录。')
    }
    return path.win32.join(programData, PLATFORM_TECHNICAL_ID, DESKTOP_RUNTIME_MANIFEST_FILENAME)
  }
  if (platform === 'linux') {
    return path.posix.join('/etc/geo-agent-platform', DESKTOP_RUNTIME_MANIFEST_FILENAME)
  }
  if (platform === 'darwin') {
    return path.posix.join(
      '/Library/Application Support',
      PLATFORM_TECHNICAL_ID,
      DESKTOP_RUNTIME_MANIFEST_FILENAME,
    )
  }
  throw new Error(`Desktop 不支持当前生产平台：${platform}`)
}

function parsePort(value: string | undefined): number | null {
  if (!value?.trim()) return null
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : null
}

function parseBoolean(value: string | undefined, name: string, fallback: boolean): boolean {
  if (value === undefined || !value.trim()) return fallback
  const normalized = value.trim().toLowerCase()
  if (normalized === 'true' || normalized === '1') return true
  if (normalized === 'false' || normalized === '0') return false
  throw new Error(`${name} 必须是 true/false 或 1/0。`)
}

function isLoopbackUrl(value: string): boolean {
  const hostname = new URL(value).hostname.toLowerCase()
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}
