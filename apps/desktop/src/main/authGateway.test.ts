// +-------------------------------------------------------------------------
//
//   地理智能平台 - Electron 自动认证网关测试
//
//   文件:       authGateway.test.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'

import {
  desktopAuthBootstrapResultSchema,
  desktopAuthProjectionSchema,
} from '../contracts/desktopIpc.js'
import {
  DesktopAuthGateway,
} from './authGateway.js'
import type { DesktopAuthClientPort } from './desktopAuthClient.js'
import type { DesktopAutoAuthConfig } from './runtimeConfig.js'

describe('DesktopAuthGateway auto auth', () => {
  it('keeps interactive mode free of implicit account mutations', async () => {
    const client = fakeClient()
    const gateway = new DesktopAuthGateway('http://127.0.0.1:8000', { client })

    const result = desktopAuthBootstrapResultSchema.parse(
      (await gateway.handle(request())).data,
    )

    expect(result).toEqual({ mode: 'interactive', status: 'ready', message: null })
    expect(client.signIn.email).not.toHaveBeenCalled()
    expect(client.signUp.email).not.toHaveBeenCalled()
  })

  it('opens the protected local identity Broker without public account mutations', async () => {
    const client = fakeClient()
    const managedIdentity = fakeManagedIdentity()
    const gateway = new DesktopAuthGateway('http://127.0.0.1:8000', {
      client,
      autoAuth: autoAuth(),
      managedIdentity,
    })

    const result = desktopAuthBootstrapResultSchema.parse(
      (await gateway.handle(request())).data,
    )

    expect(result).toEqual({ mode: 'local_auto', status: 'authenticated', message: null })
    expect(managedIdentity.open).toHaveBeenCalledOnce()
    expect(gateway.cookieHeader()).toBe('better-auth.session_token=managed-cookie')
    expect(client.signIn.email).not.toHaveBeenCalled()
    expect(client.signUp.email).not.toHaveBeenCalled()
  })

  it('returns a stable bootstrap failure when the local identity Broker is unavailable', async () => {
    const client = fakeClient()
    const managedIdentity = fakeManagedIdentity()
    managedIdentity.open.mockRejectedValue(new Error('本机根密钥不可用'))
    const gateway = new DesktopAuthGateway('http://127.0.0.1:8000', {
      client,
      autoAuth: autoAuth(),
      managedIdentity,
    })

    const response = await gateway.handle(request())
    const result = desktopAuthBootstrapResultSchema.parse(response.data)

    expect(result.mode).toBe('local_auto')
    expect(result.status).toBe('failed')
    expect(result.message).toContain('本机根密钥不可用')
    expect(client.signIn.email).not.toHaveBeenCalled()
    expect(client.signUp.email).not.toHaveBeenCalled()
  })

  it('keeps CSRF and session cookies in Main while returning only the identity projection', async () => {
    const client = fakeClient()
    vi.mocked(client.getCookie).mockReturnValue('better-auth.session_token=main-only-cookie')
    let capturedInit: RequestInit | undefined
    const fetchApi = vi.fn(async (_url: string, init: RequestInit) => {
      capturedInit = init
      return jsonResponse(authMe('main-only-csrf'))
    })
    const gateway = new DesktopAuthGateway('http://127.0.0.1:8000', {
      client,
      fetchApi,
    })

    const response = await gateway.handle(authRequest('projection'))
    const projection = desktopAuthProjectionSchema.parse(response.data)

    expect(projection.user.email).toBe('admin@example.com')
    expect(projection.requestProtection).toBe('main_managed')
    expect(JSON.stringify(response)).not.toContain('main-only-csrf')
    expect(JSON.stringify(response)).not.toContain('main-only-cookie')
    expect(gateway.requireAuthorizationContext()).toMatchObject({
      userId: 'user_1',
      csrfToken: 'main-only-csrf',
      platformRoles: ['platform_admin'],
      permissions: ['workspace:read'],
    })
    const requestHeaders = new Headers(capturedInit?.headers)
    expect(requestHeaders.get('cookie')).toBe('better-auth.session_token=main-only-cookie')
  })

  it('does not return Better Auth sign-in data and refreshes the Main-owned authorization', async () => {
    const client = fakeClient()
    vi.mocked(client.signIn.email).mockResolvedValue(ok({
      token: 'better-auth-result-token',
      session: { id: 'private-session-id' },
    }))
    const gateway = new DesktopAuthGateway('http://127.0.0.1:8000', {
      client,
      fetchApi: async () => jsonResponse(authMe('main-only-csrf')),
    })

    const response = await gateway.handle({
      version: 1,
      requestId: crypto.randomUUID(),
      command: 'sign-in-email',
      payload: { email: 'admin@example.com', password: 'manual-password' },
    })

    expect(response.ok).toBe(true)
    expect(response.data).toBeNull()
    expect(JSON.stringify(response)).not.toContain('better-auth-result-token')
    expect(JSON.stringify(response)).not.toContain('private-session-id')
    expect(gateway.requireAuthorizationContext().csrfToken).toBe('main-only-csrf')
  })

  it('clears Main authorization and notifies subscribers after sign-out', async () => {
    const gateway = new DesktopAuthGateway('http://127.0.0.1:8000', {
      client: fakeClient(),
      fetchApi: async () => jsonResponse(authMe('main-only-csrf')),
    })
    await gateway.handle(authRequest('projection'))
    const changed = vi.fn()
    gateway.onAuthorizationChanged(changed)

    const response = await gateway.handle(authRequest('sign-out'))

    expect(response.ok).toBe(true)
    expect(response.data).toBeNull()
    expect(changed).toHaveBeenCalledOnce()
    expect(() => gateway.requireAuthorizationContext()).toThrow('请先完成桌面认证')
  })

  it('notifies Main subscribers when server-validated roles change in the same session', async () => {
    const fetchApi = vi.fn()
      .mockResolvedValueOnce(jsonResponse(authMe('same-csrf')))
      .mockResolvedValueOnce(jsonResponse(authMe('same-csrf', [])))
    const gateway = new DesktopAuthGateway('http://127.0.0.1:8000', {
      client: fakeClient(),
      fetchApi,
    })
    await gateway.handle(authRequest('projection'))
    const initial = gateway.requireAuthorizationContext()
    const changed = vi.fn()
    gateway.onAuthorizationChanged(changed)

    await gateway.handle(authRequest('projection'))

    expect(changed).toHaveBeenCalledOnce()
    expect(gateway.currentAuthorizationContext()).toMatchObject({
      userId: initial.userId,
      csrfToken: initial.csrfToken,
      platformRoles: [],
      permissions: ['workspace:read'],
      revision: initial.revision + 1,
    })
  })

  it('clears the last menu identity when a refreshed server projection is invalid', async () => {
    const fetchApi = vi.fn()
      .mockResolvedValueOnce(jsonResponse(authMe('same-csrf')))
      .mockResolvedValueOnce(jsonResponse({
        ...authMe('same-csrf'),
        platformRoles: ['forged-role'],
      }))
    const gateway = new DesktopAuthGateway('http://127.0.0.1:8000', {
      client: fakeClient(),
      fetchApi,
    })
    await gateway.handle(authRequest('projection'))
    const changed = vi.fn()
    gateway.onAuthorizationChanged(changed)

    const response = await gateway.handle(authRequest('projection'))

    expect(response.ok).toBe(false)
    expect(changed).toHaveBeenCalledOnce()
    expect(gateway.currentAuthorizationContext()).toBeNull()
  })
})

function request() {
  return {
    version: 1 as const,
    requestId: crypto.randomUUID(),
    command: 'bootstrap',
    payload: {},
  }
}

function authRequest(command: 'projection' | 'sign-out') {
  return {
    version: 1 as const,
    requestId: crypto.randomUUID(),
    command,
    payload: {},
  }
}

function autoAuth(): DesktopAutoAuthConfig {
  return { mode: 'local_managed' }
}

function fakeClient(): DesktopAuthClientPort {
  return {
    getCookie: vi.fn(() => ''),
    signIn: { email: vi.fn(async () => ok(null)) },
    signUp: { email: vi.fn(async () => ok(null)) },
    signOut: vi.fn(async () => ok(null)),
  }
}

function fakeManagedIdentity() {
  return {
    open: vi.fn(async () => ({
      type: 'desktop.authorization' as const,
      appBaseUrl: 'http://127.0.0.1:8000',
      origin: 'http://127.0.0.1:8000',
      cookie: 'better-auth.session_token=managed-cookie',
      csrfToken: 'managed-csrf',
      actor: {
        osUser: 'tester',
        hostname: 'localhost',
        processId: 100,
        keyVersion: 'key-v1',
      },
    })),
    close: vi.fn(async () => undefined),
  }
}

function ok(data: unknown) {
  return { data, error: null }
}

function authMe(
  csrfToken: string,
  platformRoles: Array<'platform_admin' | 'workspace_admin' | 'analyst' | 'viewer'> = [
    'platform_admin',
  ],
) {
  const now = '2026-07-29T00:00:00.000Z'
  return {
    user: {
      userId: 'user_1',
      subject: 'auth_1',
      email: 'admin@example.com',
      displayName: '管理员',
      status: 'active',
      lastLoginAt: now,
      createdAt: now,
      updatedAt: now,
    },
    defaultWorkspace: null,
    memberships: [],
    platformRoles,
    csrfToken,
    permissions: ['workspace:read'],
  }
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}
