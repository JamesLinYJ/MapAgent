// +-------------------------------------------------------------------------
//
//   地理智能平台 - Electron 本机托管身份 Broker
//
//   文件:       localDesktopIdentityBroker.ts
//
//   日期:       2026年07月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { randomUUID } from 'node:crypto'
import path from 'node:path'

import {
  localDesktopAuthorizationSchema,
  localOperationsResponseSchema,
  type LocalDesktopAuthorization,
} from '@geo-agent-platform/shared-types/local-operations'

import type { DesktopRuntimeConfig } from './runtimeConfig.js'

export interface DesktopManagedIdentityPort {
  open(): Promise<LocalDesktopAuthorization>
  close(): Promise<void>
}

export interface DesktopBrokerProcess {
  readonly pid: number | undefined
  readonly stderr: NodeJS.ReadableStream | null
  postMessage(message: unknown): void
  kill(): boolean
  on(event: 'message', listener: (message: unknown) => void): this
  once(event: 'error', listener: (...details: unknown[]) => void): this
  once(event: 'exit', listener: (code: number) => void): this
}

export interface DesktopBrokerProcessFactory {
  fork(
    modulePath: string,
    args: string[],
    options: {
      cwd: string
      env: NodeJS.ProcessEnv
      stdio: ['ignore', 'ignore', 'pipe']
      serviceName: string
    },
  ): DesktopBrokerProcess
}

export interface LocalDesktopIdentityBrokerOptions {
  serviceEnvironmentFile?: string
  fetch?: typeof globalThis.fetch
  readinessTimeoutMs?: number
  readinessPollIntervalMs?: number
}

const DEFAULT_READINESS_TIMEOUT_MS = 90_000
const DEFAULT_READINESS_POLL_INTERVAL_MS = 250

/**
 * Electron Main 只持有 Broker 签发的短期 Cookie。根密钥、派生凭据和 Better Auth
 * Admin API 全部留在服务器子进程边界内，不进入 Renderer 或桌面配置页。
 */
export class LocalDesktopIdentityBroker implements DesktopManagedIdentityPort {
  private child: DesktopBrokerProcess | null = null
  private authorization: LocalDesktopAuthorization | null = null
  private opening: Promise<LocalDesktopAuthorization> | null = null
  private closeResponse: {
    id: string
    resolve(): void
    reject(error: Error): void
  } | null = null
  private stderr = ''

  constructor(
    private readonly runtime: DesktopRuntimeConfig,
    private readonly processes: DesktopBrokerProcessFactory,
    private readonly options: LocalDesktopIdentityBrokerOptions = {},
  ) {}

  open(): Promise<LocalDesktopAuthorization> {
    if (this.authorization) return Promise.resolve(this.authorization)
    if (this.opening) return this.opening
    this.opening = this.openWhenReady().finally(() => {
      this.opening = null
    })
    return this.opening
  }

  private async openWhenReady(): Promise<LocalDesktopAuthorization> {
    await this.waitForRuntimeReadiness()
    return this.spawnBroker()
  }

  /**
   * RPM 冷启动时 Supervisor、PostgreSQL、Worker 与 Renderer 会并行起动。
   * Broker 只有在完整本机运行时就绪后才能建立 DB 连接；授权超时不能
   * 包含后端冷启动时间，否则较慢的首次启动会被确定性误判为认证失败。
   */
  private async waitForRuntimeReadiness(): Promise<void> {
    const fetchApi = this.options.fetch ?? globalThis.fetch
    const timeoutMs = this.options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS
    const pollIntervalMs = this.options.readinessPollIntervalMs
      ?? DEFAULT_READINESS_POLL_INTERVAL_MS
    const deadline = Date.now() + timeoutMs
    const healthUrl = new URL('/health', `${this.runtime.apiBaseUrl}/`).toString()
    let lastFailure = '本机运行时尚未就绪。'

    while (Date.now() < deadline) {
      try {
        const remainingMs = Math.max(1, deadline - Date.now())
        const response = await fetchApi(healthUrl, {
          method: 'GET',
          headers: { accept: 'application/json' },
          redirect: 'error',
          signal: AbortSignal.timeout(Math.min(2_000, remainingMs)),
        })
        if (response.ok && await isHealthyRuntimeResponse(response)) return
        lastFailure = `本机运行时健康检查返回 HTTP ${response.status}。`
      } catch (error) {
        lastFailure = error instanceof Error && error.message.trim()
          ? error.message.trim()
          : '无法连接本机运行时。'
      }
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) break
      await delay(Math.min(pollIntervalMs, remainingMs))
    }
    throw new Error(`本机运行时启动超时：${lastFailure}`)
  }

  async close(): Promise<void> {
    const child = this.child
    if (!child) return
    const id = randomUUID()
    const completed = new Promise<void>((resolve, reject) => {
      this.closeResponse = { id, resolve, reject }
    })
    try {
      child.postMessage({
        id,
        operation: 'desktop.close',
        outcome: 'allowed',
      })
    } catch (error) {
      const closeResponse = this.closeResponse
      this.closeResponse = null
      closeResponse?.reject(error instanceof Error ? error : new Error(String(error)))
    }
    let closeTimeout: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        completed,
        new Promise<never>((_resolve, reject) => {
          closeTimeout = setTimeout(
            () => reject(new Error('本机 Desktop 身份 Broker 关闭超时。')),
            5_000,
          )
        }),
      ])
    } catch (error) {
      child.kill()
      this.reset()
      throw error
    } finally {
      if (closeTimeout) clearTimeout(closeTimeout)
    }
    if (this.child === child && child.pid !== undefined) {
      await new Promise<void>(resolve => child.once('exit', () => resolve()))
    }
    this.reset()
  }

  private spawnBroker(): Promise<LocalDesktopAuthorization> {
    const entry = path.join(
      this.runtime.projectRoot,
      'apps',
      'server',
      'dist',
      'operations',
      'localOperationsBrokerEntry.js',
    )
    const child = this.processes.fork(entry, ['desktop'], {
      cwd: this.runtime.projectRoot,
      env: createLocalDesktopBrokerEnvironment(
        this.runtime,
        this.options.serviceEnvironmentFile,
      ),
      stdio: ['ignore', 'ignore', 'pipe'],
      serviceName: 'Desktop Identity Broker',
    })
    this.child = child
    this.stderr = ''
    child.stderr?.on('data', chunk => {
      this.stderr = `${this.stderr}${String(chunk)}`.slice(-8_192)
    })

    const authorization = new Promise<LocalDesktopAuthorization>((resolve, reject) => {
      let settled = false
      const openingTimeout = setTimeout(() => {
        rejectOpening(new Error('本机 Desktop 身份 Broker 授权超时。'))
      }, 15_000)
      const rejectOpening = (error: Error) => {
        if (settled) return
        settled = true
        clearTimeout(openingTimeout)
        child.kill()
        reject(error)
      }
      child.once('error', (...details) => {
        rejectOpening(new Error(`本机 Desktop 身份 Broker 进程错误：${details.map(String).join('；')}`))
      })
      child.once('exit', code => {
        const error = new Error(
          `本机 Desktop 身份 Broker 已退出（${code}）`
          + `${this.stderr.trim() ? `：${this.stderr.trim()}` : ''}`,
        )
        this.closeResponse?.reject(error)
        this.closeResponse = null
        this.reset()
        rejectOpening(error)
      })
      child.on('message', input => {
        const parsedAuthorization = localDesktopAuthorizationSchema.safeParse(input)
        if (parsedAuthorization.success) {
          if (settled) return
          settled = true
          if (openingTimeout) clearTimeout(openingTimeout)
          this.authorization = parsedAuthorization.data
          resolve(parsedAuthorization.data)
          return
        }
        const response = localOperationsResponseSchema.safeParse(input)
        if (!response.success) {
          const error = new Error(
            `本机 Desktop 身份 Broker 返回了无效消息：${response.error.issues[0]?.message ?? '结构不匹配'}`,
          )
          const closeResponse = this.closeResponse
          if (closeResponse) {
            this.closeResponse = null
            closeResponse.reject(error)
            return
          }
          rejectOpening(error)
          return
        }
        if (response.data.id !== this.closeResponse?.id) return
        const closeResponse = this.closeResponse
        this.closeResponse = null
        if (response.data.ok) closeResponse.resolve()
        else closeResponse.reject(new Error(response.data.error ?? '本机 Desktop 身份关闭失败。'))
      })
    })
    return authorization
  }

  private reset(): void {
    this.child = null
    this.authorization = null
    this.opening = null
    this.closeResponse = null
  }
}

/**
 * Broker 只接收定位本机运行时所需的非敏感字段。开发模式由 Broker 自己加载
 * 仓库配置，安装模式只接收受保护配置文件的路径；Desktop 不枚举或转发宿主
 * 进程中的模型密钥、签名凭据、Cookie、令牌或登录信息。
 */
export function createLocalDesktopBrokerEnvironment(
  runtime: DesktopRuntimeConfig,
  serviceEnvironmentFile?: string,
): NodeJS.ProcessEnv {
  return {
    NODE_ENV: runtime.profile,
    GEO_AGENT_PLATFORM_ROOT: runtime.projectRoot,
    RUNTIME_ROOT: runtime.runtimeRoot,
    APP_BASE_URL: runtime.apiBaseUrl,
    ...(serviceEnvironmentFile
      ? { GEO_AGENT_PLATFORM_SERVICE_ENV_FILE: serviceEnvironmentFile }
      : {}),
  }
}

async function isHealthyRuntimeResponse(response: Response): Promise<boolean> {
  const body = await response.text()
  if (Buffer.byteLength(body, 'utf8') > 64 * 1024) return false
  try {
    const value = JSON.parse(body) as {
      status?: unknown
      checks?: Record<string, { ok?: unknown }>
    }
    return value.status === 'ok'
      && value.checks !== undefined
      && Object.values(value.checks).length > 0
      && Object.values(value.checks).every(check => check?.ok === true)
  } catch {
    return false
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}
