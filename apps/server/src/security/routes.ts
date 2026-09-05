// +-------------------------------------------------------------------------
//
//   地理智能平台 - 认证与 RBAC 管理路由
//
//   文件:       routes.ts
//
//   日期:       2026年07月02日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import {
adminMembershipCreateSchema,
adminUserPatchSchema,
adminWorkspaceCreateSchema,
} from '@geo-agent-platform/shared-types/platform'
import { BetterAuthService } from './authService.js'
import type { SecurityAdminService } from './adminService.js'
import { AuthorizationError,AuthorizationService } from './authorizationService.js'
import type { AuthContext } from './types.js'

export interface SecurityServices {
  auth: BetterAuthService
  authorization: AuthorizationService
  admin: SecurityAdminService
}

export function securityRoutes(services: SecurityServices) {
  const app = new Hono()

  app.get('/api/v1/auth/me', c => {
    const auth = getAuth(c)
    if (!auth) return c.json({ detail: '未登录' }, 401)
    return c.json(services.auth.toAuthMe(auth))
  })

  app.get('/api/v1/admin/users', async c => {
    const auth = requireAuth(c)
    await services.authorization.enforce(auth, 'admin', 'admin', { workspaceId: auth.defaultWorkspaceId })
    return c.json(await services.admin.listUsers())
  })

  app.patch('/api/v1/admin/users/:userId', zValidator('json', adminUserPatchSchema, (result, c) => {
    if (!result.success) return c.json({ detail: firstValidationMessage(result.error) }, 400)
  }), async c => {
    const auth = requireAuth(c)
    services.auth.requireCsrf(c.req.raw, auth)
    await services.authorization.enforce(auth, 'admin', 'admin', { workspaceId: auth.defaultWorkspaceId })
    const body = c.req.valid('json')
    const userId = c.req.param('userId')
    const updated = await services.admin.updateUser(userId, body)
    if (!updated) return c.json({ detail: '用户不存在' }, 404)
    if (body.status === 'disabled') await services.auth.revokeUserSessionsByPlatformUserId(userId)
    return c.json({ updated: true })
  })

  app.get('/api/v1/admin/workspaces', async c => {
    const auth = requireAuth(c)
    await services.authorization.enforce(auth, 'workspace', 'read', { workspaceId: auth.defaultWorkspaceId })
    const isPlatformAdmin = auth.roles.some(role => role.role === 'platform_admin')
    return c.json(await services.admin.listWorkspaces({ platformAdmin: isPlatformAdmin, userId: auth.userId }))
  })

  app.post('/api/v1/admin/workspaces', zValidator('json', adminWorkspaceCreateSchema, (result, c) => {
    if (!result.success) return c.json({ detail: firstValidationMessage(result.error) }, 400)
  }), async c => {
    const auth = requireAuth(c)
    services.auth.requireCsrf(c.req.raw, auth)
    await services.authorization.enforce(auth, 'admin', 'admin', { workspaceId: auth.defaultWorkspaceId })
    const body = c.req.valid('json')
    const workspace = await services.admin.createWorkspaceWithAdmin({
      ...body,
      createdByUserId: auth.userId,
    })
    return c.json(workspace, 201)
  })

  app.get('/api/v1/admin/memberships', async c => {
    const auth = requireAuth(c)
    await services.authorization.enforce(auth, 'workspace', 'admin', { workspaceId: auth.defaultWorkspaceId })
    const workspaceId = c.req.query('workspaceId') ?? auth.defaultWorkspaceId
    await services.authorization.enforce(auth, 'workspace', 'admin', { workspaceId })
    return c.json(await services.admin.listMemberships(workspaceId))
  })

  app.post('/api/v1/admin/memberships', zValidator('json', adminMembershipCreateSchema, (result, c) => {
    if (!result.success) return c.json({ detail: firstValidationMessage(result.error) }, 400)
  }), async c => {
    const auth = requireAuth(c)
    services.auth.requireCsrf(c.req.raw, auth)
    const body = c.req.valid('json')
    await services.authorization.enforce(auth, 'workspace', 'admin', { workspaceId: body.workspaceId })
    const created = await services.admin.addMembership(body)
    return created ? c.json({ created: true }, 201) : c.json({ created: false })
  })

  app.delete('/api/v1/admin/memberships/:membershipId', async c => {
    const auth = requireAuth(c)
    services.auth.requireCsrf(c.req.raw, auth)
    const membershipId = c.req.param('membershipId')
    const workspaceId = await services.admin.getMembershipWorkspace(membershipId)
    if (!workspaceId) return c.json({ detail: '成员关系不存在' }, 404)
    await services.authorization.enforce(auth, 'workspace', 'admin', { workspaceId })
    const deleted = await services.admin.deleteMembership(membershipId)
    if (!deleted) return c.json({ detail: '成员关系不存在' }, 404)
    return c.json({ deleted: true })
  })

  app.get('/api/v1/admin/roles', async c => {
    const auth = requireAuth(c)
    await services.authorization.enforce(auth, 'admin', 'admin', { workspaceId: auth.defaultWorkspaceId })
    return c.json(await services.admin.listRoles())
  })

  app.get('/api/v1/admin/audit-events', async c => {
    const auth = requireAuth(c)
    await services.authorization.enforce(auth, 'admin', 'admin', { workspaceId: auth.defaultWorkspaceId })
    return c.json(await services.admin.listAuditEvents())
  })

  return app
}

export async function requireHttpAuth(services: SecurityServices, c: { req: { raw: Request; path: string; method: string; header(name: string): string | undefined }; set(key: string, value: unknown): void; json(value: unknown, status?: number): Response }, next: () => Promise<void>) {
  const auth = await services.auth.authenticateRequest(c.req.raw)
  if (!auth) return c.json({ detail: '未登录' }, 401)
  c.set('auth', auth)
  if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(c.req.method.toUpperCase())) {
    try {
      services.auth.requireCsrf(c.req.raw, auth)
    } catch (error) {
      return c.json({ detail: formatError(error, 'CSRF 校验失败') }, 403)
    }
  }
  await next()
}

function getAuth(c: { get(key: string): unknown }): AuthContext | null {
  const value = c.get('auth')
  return isAuthContext(value) ? value : null
}

export function requireAuth(c: { get(key: string): unknown }): AuthContext {
  const auth = getAuth(c)
  if (!auth) throw new AuthorizationError('未登录。')
  return auth
}

function isAuthContext(value: unknown): value is AuthContext {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { userId?: unknown }).userId === 'string'
    && typeof (value as { authSessionId?: unknown }).authSessionId === 'string'
    && typeof (value as { defaultWorkspaceId?: unknown }).defaultWorkspaceId === 'string'
}

function formatError(error: unknown, prefix: string): string {
  return error instanceof Error && error.message ? `${prefix}: ${error.message}` : prefix
}

function firstValidationMessage(error: { issues: Array<{ message: string }> }): string {
  return error.issues[0]?.message ?? '请求参数无效'
}
