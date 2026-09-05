// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面生产运行时清单边界
//
//   文件:       runtimeManifest.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  type Stats,
} from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

const DESKTOP_RUNTIME_MANIFEST_KIND = 'geo-agent-platform.desktop-runtime'
const DESKTOP_RUNTIME_MANIFEST_VERSION = 1
export const DESKTOP_RUNTIME_MANIFEST_FILENAME = 'runtime-manifest.v1.json'

const controlledEnvironmentNames = [
  'GEO_AGENT_PLATFORM_ROOT',
  'RUNTIME_ROOT',
  'APP_BASE_URL',
  'GEO_AGENT_PLATFORM_SUPERVISOR_TOKEN_FILE',
] as const

const absoluteLocalPathSchema = z.string()
  .trim()
  .min(1)
  .max(4_096)
  .refine(value => !value.includes('\0'), '路径不能包含空字节。')
  .refine(value => path.isAbsolute(value), '路径必须是绝对路径。')
  .refine(value => process.platform !== 'win32' || !value.startsWith('\\\\'), '路径必须位于本机磁盘。')
  .transform(value => path.normalize(value))

const directoryPathSchema = absoluteLocalPathSchema.refine(
  value => path.parse(value).root !== value,
  '目录不能是文件系统根目录。',
)

const httpBaseUrlSchema = z.string()
  .trim()
  .url()
  .superRefine((value, context) => {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      context.addIssue({ code: 'custom', message: 'API 地址只允许 HTTP 或 HTTPS。' })
    }
    if (url.username || url.password || url.search || url.hash) {
      context.addIssue({ code: 'custom', message: 'API 地址不能包含凭据、查询参数或片段。' })
    }
    if (url.pathname !== '/' && url.pathname !== '') {
      context.addIssue({ code: 'custom', message: 'API 地址必须是源站根地址，不能包含路径。' })
    }
  })
  .transform(value => new URL(value).origin)

const runtimeFieldsShape = {
  projectRoot: directoryPathSchema,
  runtimeRoot: directoryPathSchema,
  apiBaseUrl: httpBaseUrlSchema,
  supervisorTokenFile: absoluteLocalPathSchema,
}

const desktopRuntimeValuesSchema = z.object(runtimeFieldsShape)
  .strict()
  .superRefine(validateRuntimePathRelationships)

const desktopRuntimeManifestSchema = z.object({
  kind: z.literal(DESKTOP_RUNTIME_MANIFEST_KIND),
  schemaVersion: z.literal(DESKTOP_RUNTIME_MANIFEST_VERSION),
  ...runtimeFieldsShape,
  allowedEnvironmentOverrides: z.array(z.enum(controlledEnvironmentNames)).max(controlledEnvironmentNames.length),
})
  .strict()
  .superRefine((manifest, context) => {
    validateRuntimePathRelationships(manifest, context)
    if (new Set(manifest.allowedEnvironmentOverrides).size !== manifest.allowedEnvironmentOverrides.length) {
      context.addIssue({
        code: 'custom',
        path: ['allowedEnvironmentOverrides'],
        message: '受控环境变量覆盖列表不能包含重复项。',
      })
    }
  })

export type DesktopRuntimeManifest = z.infer<typeof desktopRuntimeManifestSchema>
export type DesktopRuntimeValues = z.infer<typeof desktopRuntimeValuesSchema>

export interface RuntimeManifestProtectionOptions {
  platform?: NodeJS.Platform
  expectedOwnerUid?: number
}

export function parseDesktopRuntimeManifest(input: unknown): DesktopRuntimeManifest {
  return desktopRuntimeManifestSchema.parse(input)
}

/**
 * 清单是生产 Desktop 的配置事实源。这里拒绝链接、超大载荷和 POSIX 下可被
 * 非所有者改写的文件；Windows ACL 由安装脚本创建并由固定 ProgramData 路径承载。
 */
export function loadDesktopRuntimeManifest(
  manifestPath: string,
  protection: RuntimeManifestProtectionOptions = {},
): DesktopRuntimeManifest {
  const resolvedPath = absoluteLocalPathSchema.parse(manifestPath)
  const pathStat = lstatSync(resolvedPath)
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
    throw new Error(`桌面 runtime manifest 必须是普通文件且不能是符号链接：${resolvedPath}`)
  }
  const platform = protection.platform ?? process.platform
  if (!pathsAreEquivalent(resolvedPath, realpathSync.native(resolvedPath), platform)) {
    throw new Error('桌面 runtime manifest 路径不能经过符号链接或 Windows reparse point。')
  }

  const descriptor = openSync(resolvedPath, 'r')
  let source: string
  try {
    const openedStat = fstatSync(descriptor)
    if (!sameFile(pathStat, openedStat)) {
      throw new Error('桌面 runtime manifest 在打开前被替换。')
    }
    validateManifestFileProtection(openedStat, platform, protection.expectedOwnerUid)
    source = readFileSync(descriptor, 'utf8')
  } finally {
    closeSync(descriptor)
  }

  let input: unknown
  try {
    input = JSON.parse(source) as unknown
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`桌面 runtime manifest 不是有效 JSON：${reason}`)
  }
  const manifest = parseDesktopRuntimeManifest(input)
  validateDesktopRuntimeFilesystemTargets(manifest, platform)
  return manifest
}

/**
 * 生产环境变量只有在受保护清单逐项授权时才可覆盖对应值。未授权但已设置的
 * 变量直接硬失败，避免运维人员误以为覆盖生效，也避免环境继承悄悄改变事实源。
 */
export function applyControlledRuntimeEnvironment(
  manifest: DesktopRuntimeManifest,
  environment: NodeJS.ProcessEnv,
): DesktopRuntimeValues {
  const values: Record<keyof DesktopRuntimeValues, string> = {
    projectRoot: manifest.projectRoot,
    runtimeRoot: manifest.runtimeRoot,
    apiBaseUrl: manifest.apiBaseUrl,
    supervisorTokenFile: manifest.supervisorTokenFile,
  }
  const fieldsByEnvironment = {
    GEO_AGENT_PLATFORM_ROOT: 'projectRoot',
    RUNTIME_ROOT: 'runtimeRoot',
    APP_BASE_URL: 'apiBaseUrl',
    GEO_AGENT_PLATFORM_SUPERVISOR_TOKEN_FILE: 'supervisorTokenFile',
  } as const satisfies Record<typeof controlledEnvironmentNames[number], keyof DesktopRuntimeValues>

  for (const environmentName of controlledEnvironmentNames) {
    const configured = environment[environmentName]?.trim()
    if (!configured) continue
    if (!manifest.allowedEnvironmentOverrides.includes(environmentName)) {
      throw new Error(
        `生产桌面 runtime manifest 未授权环境变量 ${environmentName} 覆盖；请修改受保护清单或移除该变量。`,
      )
    }
    values[fieldsByEnvironment[environmentName]] = configured
  }
  return desktopRuntimeValuesSchema.parse(values)
}

function validateRuntimePathRelationships(
  values: Pick<DesktopRuntimeValues, 'runtimeRoot' | 'supervisorTokenFile'>,
  context: z.RefinementCtx,
): void {
  const relativeTokenPath = path.relative(values.runtimeRoot, values.supervisorTokenFile)
  const tokenIsInsideRuntime = relativeTokenPath.length > 0
    && !path.isAbsolute(relativeTokenPath)
    && relativeTokenPath !== '..'
    && !relativeTokenPath.startsWith(`..${path.sep}`)
  if (!tokenIsInsideRuntime) {
    context.addIssue({
      code: 'custom',
      path: ['supervisorTokenFile'],
      message: 'Supervisor 令牌文件必须位于 runtimeRoot 内部。',
    })
  }
}

function validateManifestFileProtection(
  stat: Stats,
  platform: NodeJS.Platform,
  configuredOwnerUid: number | undefined,
): void {
  if (stat.size <= 0 || stat.size > 64 * 1_024) {
    throw new Error('桌面 runtime manifest 大小必须在 1 字节到 64 KiB 之间。')
  }
  if (stat.nlink !== 1) {
    throw new Error('桌面 runtime manifest 不能是 hard link。')
  }
  if (platform === 'win32') return

  const expectedOwnerUid = configuredOwnerUid ?? 0
  if (stat.uid !== expectedOwnerUid) {
    throw new Error(`桌面 runtime manifest 必须由 uid ${expectedOwnerUid} 所有。`)
  }
  if ((stat.mode & 0o022) !== 0) {
    throw new Error('桌面 runtime manifest 不能允许 group/other 写入。')
  }
}

export function validateDesktopRuntimeFilesystemTargets(
  manifest: DesktopRuntimeValues,
  platform: NodeJS.Platform,
): void {
  validateFilesystemTarget(manifest.projectRoot, 'projectRoot', 'directory', platform)
  validateFilesystemTarget(manifest.runtimeRoot, 'runtimeRoot', 'directory', platform)
  validateFilesystemTarget(manifest.supervisorTokenFile, 'supervisorTokenFile', 'file', platform)

  const runtimeRoot = realpathSync.native(manifest.runtimeRoot)
  const tokenFile = realpathSync.native(manifest.supervisorTokenFile)
  const relativeTokenPath = path.relative(runtimeRoot, tokenFile)
  if (
    !relativeTokenPath
    || path.isAbsolute(relativeTokenPath)
    || relativeTokenPath === '..'
    || relativeTokenPath.startsWith(`..${path.sep}`)
  ) {
    throw new Error('Supervisor 令牌文件解析真实路径后必须仍位于 runtimeRoot 内部。')
  }
}

function validateFilesystemTarget(
  targetPath: string,
  field: 'projectRoot' | 'runtimeRoot' | 'supervisorTokenFile',
  expectedType: 'directory' | 'file',
  platform: NodeJS.Platform,
): void {
  let stat: Stats
  let canonicalPath: string
  try {
    stat = lstatSync(targetPath)
    canonicalPath = realpathSync.native(targetPath)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`桌面 runtime manifest 引用的 ${field} 无法访问：${reason}`)
  }
  const hasExpectedType = expectedType === 'directory' ? stat.isDirectory() : stat.isFile()
  if (!hasExpectedType || stat.isSymbolicLink()) {
    throw new Error(`桌面 runtime manifest 引用的 ${field} 必须是普通${expectedType === 'directory' ? '目录' : '文件'}。`)
  }
  if (expectedType === 'file' && stat.nlink !== 1) {
    throw new Error(`桌面 runtime manifest 引用的 ${field} 不能是 hard link。`)
  }
  if (!pathsAreEquivalent(targetPath, canonicalPath, platform)) {
    throw new Error(`桌面 runtime manifest 引用的 ${field} 不能经过符号链接或 Windows reparse point。`)
  }
}

function pathsAreEquivalent(
  configuredPath: string,
  canonicalPath: string,
  platform: NodeJS.Platform,
): boolean {
  const normalize = (value: string): string => {
    const normalized = path.normalize(value)
    return platform === 'win32' ? normalized.toLowerCase() : normalized
  }
  return normalize(configuredPath) === normalize(canonicalPath)
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
}
