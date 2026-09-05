// +-------------------------------------------------------------------------
//
//   地理智能平台 - Electron Better Auth 网关
//
//   文件:       authGateway.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { authMeSchema } from '@geo-agent-platform/shared-types'
import type { PlatformRole } from '@geo-agent-platform/shared-types'
import { PLATFORM_DESKTOP_APP_ORIGIN } from '@geo-agent-platform/shared-types/product-identity'
import { net } from 'electron'

import {
  desktopAuthBootstrapResultSchema,
  desktopAuthCommandSchema,
  desktopAuthProjectionSchema,
  type DesktopAuthBootstrapResult,
  type DesktopAuthProjection,
  type DesktopControlRequest,
  type DesktopControlResponse,
} from '../contracts/desktopIpc.js'
import {
  InMemoryDesktopAuthClient,
  type DesktopAuthClientPort,
  type DesktopAuthFetch,
  type DesktopAuthOperationResult,
} from './desktopAuthClient.js'
import type { DesktopAutoAuthConfig } from './runtimeConfig.js'
import type { DesktopManagedIdentityPort } from './localDesktopIdentityBroker.js'

export class DesktopAuthGateway {
  private readonly client: DesktopAuthClientPort
  private readonly autoAuth: DesktopAutoAuthConfig | null
  private readonly managedIdentity: DesktopManagedIdentityPort | null
  private readonly fetchApi: DesktopAuthFetch
  private managedCookie = ''
  private authorization: DesktopAuthenticatedIdentity | null = null
  private authorizationRevision = 0
  private readonly authorizationListeners = new Set<() => void>()

  constructor(apiBaseUrl: string, options: DesktopAuthGatewayOptions = {}) {
    this.fetchApi = options.fetchApi ?? ((url, init) => net.fetch(url, init))
    this.client = options.client ?? new InMemoryDesktopAuthClient(apiBaseUrl, this.fetchApi)
    this.autoAuth = options.autoAuth ?? null
    this.managedIdentity = options.managedIdentity ?? null
    this.apiBaseUrl = apiBaseUrl
  }

  private readonly apiBaseUrl: string

  cookieHeader(): string {
    return this.managedCookie || this.client.getCookie()
  }

  requireAuthorizationContext(): DesktopAuthenticatedIdentity {
    if (!this.authorization) {
      throw new Error('请先完成桌面认证，再执行受保护操作。')
    }
    return cloneAuthenticatedIdentity(this.authorization)
  }

  currentAuthorizationContext(): DesktopAuthenticatedIdentity | null {
    return this.authorization ? cloneAuthenticatedIdentity(this.authorization) : null
  }

  invalidateAuthorizationContext(): void {
    this.setAuthorizationContext(null)
  }

  onAuthorizationChanged(listener: () => void): () => void {
    this.authorizationListeners.add(listener)
    return () => this.authorizationListeners.delete(listener)
  }

  async handle(request: DesktopControlRequest): Promise<DesktopControlResponse> {
    let clearAuthorizationOnFailure = false
    try {
      const command = desktopAuthCommandSchema.parse({
        command: request.command,
        payload: request.payload,
      })
      let data: unknown
      if (command.command === 'bootstrap') {
        data = await this.bootstrap()
      } else if (command.command === 'projection') {
        clearAuthorizationOnFailure = true
        data = await this.refreshProjection()
      } else if (command.command === 'sign-in-email') {
        await requireAuthSuccess(
          this.client.signIn.email(command.payload),
          '登录失败。',
        )
        this.invalidateAuthorizationContext()
        await this.refreshProjection()
        data = null
      } else if (command.command === 'sign-up-email') {
        await requireAuthSuccess(
          this.client.signUp.email(command.payload),
          '注册失败。',
        )
        this.invalidateAuthorizationContext()
        await this.refreshProjection()
        data = null
      } else if (command.command === 'sign-out') {
        if (this.managedCookie) {
          await this.managedIdentity?.close()
          this.managedCookie = ''
        } else {
          await requireAuthSuccess(this.client.signOut(), '退出登录失败。')
        }
        this.invalidateAuthorizationContext()
        data = null
      } else {
        command satisfies never
        throw new Error('不支持的桌面认证操作。')
      }
      return successResponse(request, data)
    } catch (error) {
      if (clearAuthorizationOnFailure) this.invalidateAuthorizationContext()
      return failureResponse(request, 'desktop_auth_failed', safeMessage(error))
    }
  }

  private async bootstrap(): Promise<DesktopAuthBootstrapResult> {
    if (!this.autoAuth) {
      return desktopAuthBootstrapResultSchema.parse({
        mode: 'interactive',
        status: 'ready',
        message: null,
      })
    }
    try {
      if (!this.managedIdentity) {
        throw new Error('本机托管身份 Broker 未装配。')
      }
      const authorization = await this.managedIdentity.open()
      this.managedCookie = authorization.cookie
      return desktopAuthBootstrapResultSchema.parse({
        mode: 'local_auto',
        status: 'authenticated',
        message: null,
      })
    } catch (error) {
      return desktopAuthBootstrapResultSchema.parse({
        mode: 'local_auto',
        status: 'failed',
        message: safeMessage(error),
      })
    }
  }

  async close(): Promise<void> {
    await this.managedIdentity?.close()
    this.managedCookie = ''
    this.invalidateAuthorizationContext()
  }

  private async refreshProjection(): Promise<DesktopAuthProjection> {
    const headers = new Headers({
      accept: 'application/json',
      origin: PLATFORM_DESKTOP_APP_ORIGIN,
    })
    const cookie = this.cookieHeader()
    if (cookie) headers.set('cookie', cookie)
    const response = await this.fetchApi(
      new URL('/api/v1/auth/me', `${this.apiBaseUrl}/`).toString(),
      { headers },
    )
    if (response.status === 401) {
      this.invalidateAuthorizationContext()
      throw new Error('当前桌面会话未登录或已经过期。')
    }
    if (!response.ok) {
      throw new Error(`读取桌面身份投影失败（HTTP ${response.status}）。`)
    }
    const body = await response.text()
    if (Buffer.byteLength(body, 'utf8') > 1024 * 1024) {
      throw new Error('桌面身份投影超过 1 MiB 安全上限。')
    }
    let raw: unknown
    try {
      raw = JSON.parse(body)
    } catch {
      throw new Error('桌面身份投影不是有效 JSON。')
    }
    const auth = authMeSchema.parse(raw)
    const projection = desktopAuthProjectionSchema.parse({
      user: auth.user,
      defaultWorkspace: auth.defaultWorkspace,
      memberships: auth.memberships,
      platformRoles: auth.platformRoles,
      permissions: auth.permissions,
      requestProtection: 'main_managed',
    })
    this.setAuthorizationContext({
      userId: auth.user.userId,
      csrfToken: auth.csrfToken,
      platformRoles: auth.platformRoles,
      permissions: auth.permissions,
      revision: this.authorizationRevision,
    })
    return projection
  }

  private setAuthorizationContext(
    next: Omit<DesktopAuthenticatedIdentity, 'revision'> & { revision?: number } | null,
  ): void {
    const changed = this.authorization?.userId !== next?.userId
      || this.authorization?.csrfToken !== next?.csrfToken
      || !sameStringValues(this.authorization?.platformRoles, next?.platformRoles)
      || !sameStringValues(this.authorization?.permissions, next?.permissions)
    if (!changed) return
    this.authorizationRevision += 1
    this.authorization = next
      ? {
          userId: next.userId,
          csrfToken: next.csrfToken,
          platformRoles: [...next.platformRoles],
          permissions: [...next.permissions],
          revision: this.authorizationRevision,
        }
      : null
    for (const listener of this.authorizationListeners) listener()
  }
}

export interface DesktopAuthGatewayOptions {
  autoAuth?: DesktopAutoAuthConfig | null
  managedIdentity?: DesktopManagedIdentityPort | null
  client?: DesktopAuthClientPort
  fetchApi?: DesktopAuthFetch
}

export interface DesktopAuthorizationContext {
  userId: string
  csrfToken: string
  revision: number
}

export interface DesktopAuthenticatedIdentity extends DesktopAuthorizationContext {
  platformRoles: readonly PlatformRole[]
  permissions: readonly string[]
}

async function requireAuthSuccess(
  operation: Promise<DesktopAuthOperationResult>,
  fallback: string,
): Promise<unknown> {
  const result = await operation
  if (result.error) throw new Error(result.error.message?.trim() || result.error.statusText || fallback)
  return result.data
}

function successResponse(request: DesktopControlRequest, data: unknown): DesktopControlResponse {
  return {
    version: request.version,
    requestId: request.requestId,
    ok: true,
    data,
  }
}

function failureResponse(
  request: DesktopControlRequest,
  code: string,
  message: string,
): DesktopControlResponse {
  return {
    version: request.version,
    requestId: request.requestId,
    ok: false,
    error: { code, message },
  }
}

function safeMessage(error: unknown): string {
  return error instanceof Error
    ? error.message.replace(/[\r\n]+/gu, ' ').slice(0, 500)
    : '认证操作失败。'
}

function cloneAuthenticatedIdentity(
  identity: DesktopAuthenticatedIdentity,
): DesktopAuthenticatedIdentity {
  return {
    ...identity,
    platformRoles: [...identity.platformRoles],
    permissions: [...identity.permissions],
  }
}

function sameStringValues(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  if (left === right) return true
  if (!left || !right || left.length !== right.length) return false
  return left.every((value, index) => value === right[index])
}
