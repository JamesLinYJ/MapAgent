// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面首次设置与部署选择
//
//   文件:       productSetup.ts
//
//   说明:       本机受管运行时优先；普通安装包在没有系统清单时改为连接
//               用户指定的服务端。显示名称保存到产品设置；本机地图 Key 仅交给
//               受保护的 runtime.env 管理，不进入产品设置 JSON。
// --------------------------------------------------------------------------

import { randomUUID } from 'node:crypto'
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import {
  API_PROTOCOL_VERSION,
  DESKTOP_PROTOCOL_VERSION,
  runtimeCapabilitiesSchema,
} from '@geo-agent-platform/shared-types/release'
import { PRODUCT_CODENAME } from '@geo-agent-platform/shared-types/product-identity'

import type {
  DesktopProductSetupConnection,
  DesktopProductSetupStatus,
  DesktopProductSetupTestResult,
} from '../contracts/desktopIpc.js'
import { readBoundedResponseText } from './boundedResponseBody.js'
import {
  defaultDesktopRuntimeManifestPath,
  resolveDesktopRuntimeConfig,
  type DesktopRuntimeConfig,
} from './runtimeConfig.js'
import type { RuntimeManifestProtectionOptions } from './runtimeManifest.js'

const USER_SETUP_KIND = 'geo-agent-platform.desktop-setup' as const
const USER_SETUP_SCHEMA_VERSION = 2 as const
const SETUP_RESPONSE_MAX_BYTES = 64 * 1024
const SETUP_REQUEST_TIMEOUT_MS = 8_000
const DEFAULT_LOCAL_API_BASE_URL = 'http://127.0.0.1:8000'

const desktopProductNameSchema = z.string().trim().min(1).max(80)
const desktopUserSetupConfigSchema = z.discriminatedUnion('mode', [
  z.object({
    kind: z.literal(USER_SETUP_KIND),
    schemaVersion: z.literal(USER_SETUP_SCHEMA_VERSION),
    mode: z.literal('local_managed'),
    productName: desktopProductNameSchema,
  }).strict(),
  z.object({
    kind: z.literal(USER_SETUP_KIND),
    schemaVersion: z.literal(USER_SETUP_SCHEMA_VERSION),
    mode: z.literal('remote'),
    productName: desktopProductNameSchema,
    apiBaseUrl: z.string().url(),
  }).strict(),
])
const legacyDesktopUserSetupConfigSchema = z.object({
  kind: z.literal(USER_SETUP_KIND),
  schemaVersion: z.literal(1),
  mode: z.literal('remote'),
  apiBaseUrl: z.string().url(),
}).strict()

type DesktopUserSetupConfig = z.infer<typeof desktopUserSetupConfigSchema>

export type DesktopProductSetupResolution =
  | {
      state: 'required'
      deploymentMode: 'local_managed' | 'remote'
      suggestedApiBaseUrl: string
      suggestedProductName: string
      canConfigureMapService: boolean
      runtime: DesktopRuntimeConfig | null
    }
  | {
      state: 'configured'
      deploymentMode: 'local_managed'
      apiBaseUrl: string
      productName: string
      canReset: false
      canConfigureMapService: boolean
      runtime: DesktopRuntimeConfig
    }
  | {
      state: 'configured'
      deploymentMode: 'remote'
      apiBaseUrl: string
      productName: string
      canReset: boolean
      canConfigureMapService: false
      runtime: null
    }

export interface DesktopProductSetupOptions {
  profile: DesktopRuntimeConfig['profile']
  environment: NodeJS.ProcessEnv
  applicationPath: string
  platform: NodeJS.Platform
  userSetupPath: string
  runtimeManifestPath?: string
  manifestProtection?: RuntimeManifestProtectionOptions
  fetch: (input: string, init?: RequestInit) => Promise<Response>
  localRuntimeSettings?: {
    read(): Promise<{ tiandituConfigured: boolean }>
    update(input: { tiandituApiKey?: string; clearTiandituApiKey?: boolean }): Promise<void>
  }
  now?: () => number
}

export class DesktopProductSetupService {
  constructor(private readonly options: DesktopProductSetupOptions) {}

  async resolve(): Promise<DesktopProductSetupResolution> {
    const configured = await this.readUserSetup()
    if (this.options.profile === 'development') {
      const runtime = resolveDesktopRuntimeConfig(this.options.environment, {
        profile: 'development',
        applicationPath: this.options.applicationPath,
        platform: this.options.platform,
      })
      return localResolution(
        runtime,
        configured?.productName ?? PRODUCT_CODENAME,
        Boolean(this.options.localRuntimeSettings),
      )
    }

    const runtimeManifestPath = this.options.runtimeManifestPath
      ?? defaultDesktopRuntimeManifestPath(this.options.platform, this.options.environment)
    if (await pathExists(runtimeManifestPath)) {
      const runtime = resolveDesktopRuntimeConfig(this.options.environment, {
        profile: 'production',
        applicationPath: this.options.applicationPath,
        platform: this.options.platform,
        runtimeManifestPath,
        manifestProtection: this.options.manifestProtection,
      })
      return localResolution(
        runtime,
        configured?.productName ?? PRODUCT_CODENAME,
        Boolean(this.options.localRuntimeSettings),
      )
    }

    if (configured?.mode === 'remote') {
      return {
        state: 'configured',
        deploymentMode: 'remote',
        apiBaseUrl: configured.apiBaseUrl,
        productName: configured.productName,
        canReset: true,
        canConfigureMapService: false,
        runtime: null,
      }
    }
    // macOS/Windows 当前是本地桌面客户端：没有受管运行清单时直接采用
    // 回环服务约定，避免把开发/本机部署细节暴露成首次启动必填项。
    // 用户之后仍可从“服务与模型”显式切换到 HTTPS 团队部署。
    return {
      state: 'configured',
      deploymentMode: 'remote',
      apiBaseUrl: DEFAULT_LOCAL_API_BASE_URL,
      productName: configured?.productName ?? PRODUCT_CODENAME,
      canReset: configured !== null,
      canConfigureMapService: false,
      runtime: null,
    }
  }

  async status(): Promise<DesktopProductSetupStatus> {
    const resolution = await this.resolve()
    return publicStatus(resolution, await this.readTiandituConfigured(resolution))
  }

  async test(input: DesktopProductSetupConnection): Promise<DesktopProductSetupTestResult> {
    const apiBaseUrl = parseDesktopApiBaseUrl(input.apiBaseUrl)
    const startedAt = (this.options.now ?? Date.now)()
    try {
      const request = (pathname: '/health' | '/health/capabilities') => this.options.fetch(
        new URL(pathname, `${apiBaseUrl}/`).toString(),
        {
          method: 'GET',
          headers: { accept: 'application/json' },
          redirect: 'error',
          signal: AbortSignal.timeout(SETUP_REQUEST_TIMEOUT_MS),
        },
      )
      const [healthResponse, capabilitiesResponse] = await Promise.all([
        request('/health'),
        request('/health/capabilities'),
      ])
      if (!healthResponse.ok) {
        throw new Error(`服务健康检查返回 HTTP ${healthResponse.status}。`)
      }
      if (!capabilitiesResponse.ok) {
        throw new Error(`服务能力检查返回 HTTP ${capabilitiesResponse.status}。`)
      }
      await readBoundedResponseText(healthResponse, SETUP_RESPONSE_MAX_BYTES, '服务健康响应')
      const capabilities = runtimeCapabilitiesSchema.parse(JSON.parse(
        await readBoundedResponseText(
          capabilitiesResponse,
          SETUP_RESPONSE_MAX_BYTES,
          '服务能力响应',
        ),
      ))
      assertRuntimeCompatibility(capabilities)
      return {
        ok: true,
        apiBaseUrl,
        latencyMs: elapsedMilliseconds(startedAt, (this.options.now ?? Date.now)()),
        releaseId: capabilities.releaseId,
        databaseSchemaVersion: capabilities.databaseSchemaVersion,
        message: '连接成功，服务端与当前桌面版本兼容。',
      }
    } catch (error) {
      return {
        ok: false,
        apiBaseUrl,
        latencyMs: elapsedMilliseconds(startedAt, (this.options.now ?? Date.now)()),
        releaseId: null,
        databaseSchemaVersion: null,
        message: safeConnectionMessage(error),
      }
    }
  }

  async save(input: DesktopProductSetupConnection): Promise<DesktopProductSetupStatus> {
    const productName = desktopProductNameSchema.parse(input.productName)
    const current = await this.resolve()
    if (current.deploymentMode === 'local_managed') {
      const tiandituApiKey = input.tiandituApiKey?.trim()
      if (tiandituApiKey) {
        if (!this.options.localRuntimeSettings) {
          throw new Error('当前本机部署不允许由桌面应用修改地图服务配置。')
        }
        await this.validateTiandituApiKey(tiandituApiKey)
        await this.options.localRuntimeSettings.update({ tiandituApiKey })
      } else if (input.clearTiandituApiKey) {
        if (!this.options.localRuntimeSettings) {
          throw new Error('当前本机部署不允许由桌面应用修改地图服务配置。')
        }
        await this.options.localRuntimeSettings.update({ clearTiandituApiKey: true })
      }
      await this.writeUserSetup({
        kind: USER_SETUP_KIND,
        schemaVersion: USER_SETUP_SCHEMA_VERSION,
        mode: 'local_managed',
        productName,
      })
      return this.status()
    }
    if (input.tiandituApiKey || input.clearTiandituApiKey) {
      throw new Error('远程部署的地图服务配置由服务器管理员管理。')
    }
    const apiBaseUrl = parseDesktopApiBaseUrl(input.apiBaseUrl)
    if (
      current.state !== 'configured'
      || current.deploymentMode !== 'remote'
      || current.apiBaseUrl !== apiBaseUrl
    ) {
      const result = await this.test(input)
      if (!result.ok) throw new Error(result.message)
    }
    await this.writeUserSetup({
      kind: USER_SETUP_KIND,
      schemaVersion: USER_SETUP_SCHEMA_VERSION,
      mode: 'remote',
      productName,
      apiBaseUrl,
    })
    return this.status()
  }

  async reset(): Promise<DesktopProductSetupStatus> {
    await rm(this.options.userSetupPath, { force: true })
    return this.status()
  }

  private async readTiandituConfigured(
    resolution: DesktopProductSetupResolution,
  ): Promise<boolean | null> {
    if (
      resolution.deploymentMode !== 'local_managed'
      || !resolution.canConfigureMapService
      || !this.options.localRuntimeSettings
    ) return null
    return (await this.options.localRuntimeSettings.read()).tiandituConfigured
  }

  private async readUserSetup(): Promise<DesktopUserSetupConfig | null> {
    try {
      const file = await stat(this.options.userSetupPath)
      if (!file.isFile() || file.size > 16 * 1024) {
        throw new Error('桌面设置文件不是有效的小型常规文件。')
      }
      const raw = JSON.parse(await readFile(this.options.userSetupPath, 'utf8'))
      const current = desktopUserSetupConfigSchema.safeParse(raw)
      if (current.success) {
        return current.data.mode === 'remote'
          ? { ...current.data, apiBaseUrl: parseDesktopApiBaseUrl(current.data.apiBaseUrl) }
          : current.data
      }
      const legacy = legacyDesktopUserSetupConfigSchema.parse(raw)
      return {
        kind: USER_SETUP_KIND,
        schemaVersion: USER_SETUP_SCHEMA_VERSION,
        mode: 'remote',
        productName: PRODUCT_CODENAME,
        apiBaseUrl: parseDesktopApiBaseUrl(legacy.apiBaseUrl),
      }
    } catch (error) {
      if (isMissingPathError(error)) return null
      throw new Error(`无法读取桌面设置：${safeConnectionMessage(error)}`)
    }
  }

  private async writeUserSetup(input: DesktopUserSetupConfig): Promise<void> {
    const config = desktopUserSetupConfigSchema.parse(input)
    const directory = path.dirname(this.options.userSetupPath)
    const temporaryPath = path.join(directory, `.product-setup-${randomUUID()}.tmp`)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const handle = await open(temporaryPath, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await rename(temporaryPath, this.options.userSetupPath)
      if (this.options.platform !== 'win32') {
        const directoryHandle = await open(directory, 'r')
        try {
          await directoryHandle.sync()
        } finally {
          await directoryHandle.close()
        }
      }
    } finally {
      await rm(temporaryPath, { force: true })
    }
  }

  private async validateTiandituApiKey(apiKey: string): Promise<void> {
    const url = new URL('https://t0.tianditu.gov.cn/DataServer')
    url.searchParams.set('T', 'vec_w')
    url.searchParams.set('x', '6')
    url.searchParams.set('y', '3')
    url.searchParams.set('l', '3')
    url.searchParams.set('tk', apiKey)
    let response: Response
    try {
      response = await this.options.fetch(url.toString(), {
        method: 'GET',
        headers: {
          accept: 'image/png,image/*;q=0.8',
          'user-agent': 'GeoAgentPlatform-Server/1',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(SETUP_REQUEST_TIMEOUT_MS),
      })
    } catch {
      throw new Error('无法连接天地图，请检查当前网络后重试。')
    }
    try {
      const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
      if (!response.ok || !contentType.startsWith('image/')) {
        throw new Error(
          response.status === 403
            ? '天地图拒绝了该 Key。请填写服务端 API KEY，并检查其来源限制。'
            : `天地图 Key 校验失败（HTTP ${response.status}）。`,
        )
      }
    } finally {
      await response.body?.cancel().catch(() => undefined)
    }
  }
}

export function parseDesktopApiBaseUrl(input: string): string {
  const trimmed = input.trim()
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error('请输入完整的服务地址，例如 https://geo.example.com。')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('服务地址只支持 HTTP 或 HTTPS。')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('服务地址不能包含账号、密码、查询参数或片段。')
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error('服务地址只能填写站点根地址，不能包含 API 路径。')
  }
  if (url.protocol === 'http:' && !isLoopbackHostname(url.hostname)) {
    throw new Error('非本机服务必须使用 HTTPS，避免登录信息在网络中明文传输。')
  }
  return url.origin
}

function localResolution(
  runtime: DesktopRuntimeConfig,
  productName: string,
  canConfigureMapService: boolean,
): DesktopProductSetupResolution {
  return {
    state: 'configured',
    deploymentMode: 'local_managed',
    apiBaseUrl: runtime.apiBaseUrl,
    productName: desktopProductNameSchema.parse(productName),
    canReset: false,
    canConfigureMapService,
    runtime,
  }
}

function publicStatus(
  resolution: DesktopProductSetupResolution,
  tiandituConfigured: boolean | null,
): DesktopProductSetupStatus {
  if (resolution.state === 'required') {
    return {
      state: 'required',
      deploymentMode: resolution.deploymentMode,
      suggestedApiBaseUrl: resolution.suggestedApiBaseUrl,
      suggestedProductName: resolution.suggestedProductName,
      canConfigureMapService: resolution.canConfigureMapService,
      tiandituConfigured,
    }
  }
  return {
    state: 'configured',
    deploymentMode: resolution.deploymentMode,
    apiBaseUrl: resolution.apiBaseUrl,
    productName: resolution.productName,
    canReset: resolution.canReset,
    canConfigureMapService: resolution.canConfigureMapService,
    tiandituConfigured,
  }
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate)
    return true
  } catch (error) {
    if (isMissingPathError(error)) return false
    throw error
  }
}

function assertRuntimeCompatibility(capabilities: {
  apiProtocolVersion: number
  minDesktopProtocol: number
  maxDesktopProtocol: number
}): void {
  if (capabilities.apiProtocolVersion !== API_PROTOCOL_VERSION) {
    throw new Error(
      `服务端 API 协议为 ${capabilities.apiProtocolVersion}，当前桌面需要 ${API_PROTOCOL_VERSION}。`,
    )
  }
  if (
    DESKTOP_PROTOCOL_VERSION < capabilities.minDesktopProtocol
    || DESKTOP_PROTOCOL_VERSION > capabilities.maxDesktopProtocol
  ) {
    throw new Error(
      `当前桌面协议为 ${DESKTOP_PROTOCOL_VERSION}，服务端要求 ${capabilities.minDesktopProtocol}–${capabilities.maxDesktopProtocol}。`,
    )
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '[::1]'
}

function elapsedMilliseconds(startedAt: number, completedAt: number): number {
  return Math.max(0, Math.round(completedAt - startedAt))
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function safeConnectionMessage(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues[0]?.message ?? '服务返回了不兼容的数据。'
  }
  if (error instanceof Error && error.message.trim()) {
    return error.message.replace(/[\r\n]+/gu, ' ').slice(0, 800)
  }
  return '无法连接服务端，请检查地址和网络后重试。'
}
