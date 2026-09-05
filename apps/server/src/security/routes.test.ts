// +-------------------------------------------------------------------------
//
//   地理智能平台 - 安全后台路由契约测试
//
//   文件:       routes.test.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'

import type { SecurityAdminService } from './adminService.js'
import type { BetterAuthService } from './authService.js'
import type { AuthorizationService } from './authorizationService.js'
import { securityRoutes, type SecurityServices } from './routes.js'
import type { AuthContext } from './types.js'

describe('security admin routes', () => {
  it('rejects malformed user updates before invoking the application service', async () => {
    const updateUser = vi.fn()
    const app = createTestApp({ updateUser })

    const response = await app.request('/api/v1/admin/users/user_1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'unknown-status' }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ detail: expect.any(String) })
    expect(updateUser).not.toHaveBeenCalled()
  })

  it('reports an existing membership without pretending a new row was created', async () => {
    const addMembership = vi.fn().mockResolvedValue(false)
    const app = createTestApp({ addMembership })

    const response = await app.request('/api/v1/admin/memberships', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: 'workspace_1',
        userId: 'user_2',
        role: 'analyst',
      }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ created: false })
    expect(addMembership).toHaveBeenCalledWith({
      workspaceId: 'workspace_1',
      userId: 'user_2',
      role: 'analyst',
    })
  })

  it('rejects platform_admin elevation through the workspace membership route', async () => {
    const addMembership = vi.fn()
    const app = createTestApp({ addMembership })

    const response = await app.request('/api/v1/admin/memberships', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: 'workspace_1',
        userId: 'user_2',
        role: 'platform_admin',
      }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ detail: expect.any(String) })
    expect(addMembership).not.toHaveBeenCalled()
  })
})

function createTestApp(adminOverrides: Partial<SecurityAdminService>): Hono {
  const app = new Hono()
  const authContext: AuthContext = {
    userId: 'user_1',
    subject: 'auth_user_1',
    email: 'admin@example.com',
    displayName: '管理员',
    authSessionId: 'auth_session_1',
    authSessionExpiresAt: null,
    csrfToken: 'csrf_1',
    defaultWorkspaceId: 'workspace_1',
    roles: [{ workspaceId: 'workspace_1', role: 'platform_admin' }],
  }
  app.use('*', async (c, next) => {
    c.set('auth', authContext)
    await next()
  })
  const admin = {
    listUsers: vi.fn().mockResolvedValue([]),
    updateUser: vi.fn().mockResolvedValue(true),
    listWorkspaces: vi.fn().mockResolvedValue([]),
    createWorkspaceWithAdmin: vi.fn(),
    listMemberships: vi.fn().mockResolvedValue([]),
    addMembership: vi.fn().mockResolvedValue(true),
    getMembershipWorkspace: vi.fn(),
    deleteMembership: vi.fn(),
    listRoles: vi.fn().mockResolvedValue([]),
    listAuditEvents: vi.fn().mockResolvedValue([]),
    ...adminOverrides,
  } as unknown as SecurityAdminService
  const services: SecurityServices = {
    auth: {
      requireCsrf: vi.fn(),
      toAuthMe: vi.fn(),
      revokeUserSessionsByPlatformUserId: vi.fn(),
    } as unknown as BetterAuthService,
    authorization: {
      enforce: vi.fn().mockResolvedValue(undefined),
    } as unknown as AuthorizationService,
    admin,
  }
  app.route('/', securityRoutes(services))
  return app
}
