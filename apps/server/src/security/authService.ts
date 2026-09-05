// +-------------------------------------------------------------------------
//
//   地理智能平台 - Better Auth 认证服务
//
//   文件:       authService.ts
//
//   日期:       2026年07月02日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { betterAuth } from 'better-auth'
import { electron } from '@better-auth/electron'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { admin } from 'better-auth/plugins'
import { eq } from 'drizzle-orm'
import { createHmac } from 'node:crypto'
import { z } from 'zod'
import {
  PLATFORM_DESKTOP_APP_ORIGIN,
  PLATFORM_DESKTOP_AUTH_ORIGIN,
  PRODUCT_CODENAME,
} from '@geo-agent-platform/shared-types/product-identity'
import type { Database } from '../db/connection.js'
import { authAccount, authSession, authUser, authVerification } from '../db/schema.js'
import type { Env } from '../framework/env.js'
import { logger } from '../observability/logger.js'
import type { AuthContext, AuthRoleBinding } from './types.js'
import type { AuthMe } from '../schemas/types.js'
import type { PlatformIdentityService } from './platformIdentityService.js'
import { personalWorkspaceIdFor, platformUserIdFor } from './platformIdentityIds.js'
import { deriveLocalConsoleCredential, isLocalConsoleEmail } from './localConsolePrincipal.js'
import {
  deriveLocalAgentCredential,
  isLocalAgentEmail,
  LOCAL_AGENT_EMAIL,
  LOCAL_AGENT_EMAIL_DOMAIN,
} from './localAgentPrincipal.js'
import {
  deriveLocalDesktopCredential,
  isLocalDesktopEmail,
  LOCAL_DESKTOP_EMAIL,
  LOCAL_DESKTOP_EMAIL_DOMAIN,
} from './localDesktopPrincipal.js'

const betterAuthSessionProjectionSchema = z.object({
  session: z.object({
    id: z.string().min(1),
    userId: z.string().min(1),
    expiresAt: z.union([z.string(), z.date()]).nullable().optional(),
  }),
  user: z.object({
    id: z.string().min(1),
    email: z.string().email(),
    name: z.string().min(1),
    image: z.string().nullable().optional(),
    emailVerified: z.boolean().optional(),
    role: z.string().nullable().optional(),
    banned: z.boolean().optional(),
  }),
})

const localAuthUserSchema = z.object({
  id: z.string().min(1),
  email: z.string().email(),
  emailVerified: z.boolean(),
  name: z.string().min(1),
  role: z.string().nullable().optional(),
  banned: z.boolean().optional(),
})

const localCreatedUserSchema = z.object({ user: localAuthUserSchema })
const localListedUsersSchema = z.object({
  users: z.array(localAuthUserSchema),
  total: z.number().int().nonnegative(),
})

type BetterAuthSessionProjection = z.infer<typeof betterAuthSessionProjectionSchema>

function createBetterAuthRuntime(db: Database, env: Env, trustedOrigins: string[]) {
  return betterAuth({
      appName: PRODUCT_CODENAME,
      baseURL: env.BETTER_AUTH_URL,
      basePath: '/api/auth',
      secret: env.BETTER_AUTH_SECRET,
      trustedOrigins,
      database: drizzleAdapter(db, {
        provider: 'pg',
        schema: {
          user: authUser,
          session: authSession,
          account: authAccount,
          verification: authVerification,
        },
      }),
      emailAndPassword: {
        enabled: true,
        disableSignUp: !env.BETTER_AUTH_ALLOW_SIGN_UP,
        requireEmailVerification: env.BETTER_AUTH_REQUIRE_EMAIL_VERIFICATION,
        minPasswordLength: env.BETTER_AUTH_MIN_PASSWORD_LENGTH,
        autoSignIn: true,
      },
      session: {
        expiresIn: 60 * 60 * 12,
        updateAge: 60 * 60,
      },
      plugins: [
        admin(),
        electron({
          clientID: 'geo-agent-platform-desktop',
        }),
      ],
    })
}

type BetterAuthRuntime = ReturnType<typeof createBetterAuthRuntime>

export interface LocalConsoleAuthorization {
  readonly authUserId: string
  readonly email: string
  readonly keyVersion: string
  readonly headers: Headers
}

export interface LocalAgentAuthorization {
  readonly authUserId: string
  readonly keyVersion: string
  readonly headers: Headers
  readonly authContext: AuthContext
}

export interface LocalDesktopAuthorization {
  readonly authUserId: string
  readonly keyVersion: string
  readonly headers: Headers
  readonly authContext: AuthContext
}

export interface LocalAuthUser {
  id: string
  email: string
  name: string
  role: string | null
  banned: boolean
}

export type LocalAuthRole = 'admin' | 'user'

export class BetterAuthService {
  readonly auth: BetterAuthRuntime
  private readonly db: Database
  private readonly env: Env
  private readonly identity: PlatformIdentityService

  constructor(input: { db: Database; env: Env; identity: PlatformIdentityService }) {
    this.db = input.db
    this.env = input.env
    this.identity = input.identity
    this.auth = createBetterAuthRuntime(input.db, input.env, [...this.trustedOrigins()])
  }

  async handler(request: Request): Promise<Response> {
    if (new URL(request.url).pathname.startsWith('/api/auth/admin/')) {
      return Promise.resolve(Response.json({ detail: '该认证管理接口仅允许通过服务器本地 Console 使用。' }, { status: 404 }))
    }
    if (request.method !== 'GET' && await requestContainsReservedLocalEmail(request)) {
      return Response.json({ detail: '该保留身份不能通过公共认证入口使用。' }, { status: 403 })
    }
    return this.auth.handler(request)
  }

  /** 每次本机账户写操作都建立独立的短期服务主体会话，完成后立即登出。 */
  async withLocalConsoleAuthorization<T>(
    rootSecret: string,
    action: (authorization: LocalConsoleAuthorization) => Promise<T>,
  ): Promise<T> {
    const credential = deriveLocalConsoleCredential(rootSecret)
    let authorization: LocalConsoleAuthorization | null = null
    try {
      const existing = await this.findReservedAuthUser(credential.email)
      if (existing) {
        await this.markReservedAuthUserVerified(existing.id, existing.emailVerified)
      } else {
        // 保留邮箱被公共认证入口硬拒绝，因此本地 Broker 是唯一能引导
        // 机器主体的边界。机器主体没有邮箱收件人，创建时必须直接记为已验证。
        await this.auth.api.createUser({
          body: {
            email: credential.email,
            password: credential.password,
            name: `${PRODUCT_CODENAME} Local Console`,
            role: 'admin',
            data: { emailVerified: true },
          },
        })
      }
      authorization = await this.signInLocalConsole(credential)
      await this.removeRotatedConsolePrincipals(authorization)
      return await action(authorization)
    } finally {
      if (authorization) await this.auth.api.signOut({ headers: authorization.headers }).catch(() => undefined)
    }
  }

  /**
   * 为本机 Agent 建立一次不需要人工登录的短期会话。账户管理 Console 只负责
   * 通过 Better Auth Admin API 校准认证身份；Agent 使用独立、隐藏的平台投影。
   */
  async withLocalAgentAuthorization<T>(
    rootSecret: string,
    action: (authorization: LocalAgentAuthorization) => Promise<T>,
  ): Promise<T> {
    const credential = deriveLocalAgentCredential(rootSecret)
    await this.withLocalConsoleAuthorization(rootSecret, async consoleAuthorization => {
      const existing = await this.findLocalAgentUser(consoleAuthorization)
      const authUser = existing ?? localCreatedUserSchema.parse(await this.auth.api.createUser({
        headers: consoleAuthorization.headers,
        body: {
          email: credential.email,
          password: credential.password,
          name: `${PRODUCT_CODENAME} Local Agent`,
          role: 'user',
          data: { emailVerified: true },
        },
      })).user
      if (existing && !existing.emailVerified) {
        await this.auth.api.adminUpdateUser({
          headers: consoleAuthorization.headers,
          body: { userId: authUser.id, data: { emailVerified: true } },
        })
      }
      await this.auth.api.setRole({
        headers: consoleAuthorization.headers,
        body: { userId: authUser.id, role: 'user' },
      })
      if (authUser.banned) {
        await this.auth.api.unbanUser({
          headers: consoleAuthorization.headers,
          body: { userId: authUser.id },
        })
      }
      await this.auth.api.setUserPassword({
        headers: consoleAuthorization.headers,
        body: { userId: authUser.id, newPassword: credential.password },
      })
      await this.auth.api.revokeUserSessions({
        headers: consoleAuthorization.headers,
        body: { userId: authUser.id },
      })
      await this.identity.ensureProjection({
        platformUserId: platformUserIdFor(authUser.id),
        authUserId: authUser.id,
        email: credential.email,
        displayName: `${PRODUCT_CODENAME} Local Agent`,
        personalWorkspaceId: personalWorkspaceIdFor(credential.email),
        bootstrapAdmin: true,
      })
    })

    const authorization = await this.signInLocalAgent(credential)
    try {
      return await action(authorization)
    } finally {
      await this.auth.api.signOut({ headers: authorization.headers }).catch(() => undefined)
    }
  }

  /**
   * Desktop 使用独立的最小权限本机主体承载工作台会话。该主体只获得个人
   * 工作区 analyst 角色；平台管理仍由可选的人类账号显式承担。
   */
  async withLocalDesktopAuthorization<T>(
    rootSecret: string,
    action: (authorization: LocalDesktopAuthorization) => Promise<T>,
  ): Promise<T> {
    const credential = deriveLocalDesktopCredential(rootSecret)
    await this.withLocalConsoleAuthorization(rootSecret, async consoleAuthorization => {
      const existing = await this.findLocalDesktopUser(consoleAuthorization)
      const authUser = existing ?? localCreatedUserSchema.parse(await this.auth.api.createUser({
        headers: consoleAuthorization.headers,
        body: {
          email: credential.email,
          password: credential.password,
          name: `${PRODUCT_CODENAME} Local Desktop`,
          role: 'user',
          data: { emailVerified: true },
        },
      })).user
      if (existing && !existing.emailVerified) {
        await this.auth.api.adminUpdateUser({
          headers: consoleAuthorization.headers,
          body: { userId: authUser.id, data: { emailVerified: true } },
        })
      }
      await this.auth.api.setRole({
        headers: consoleAuthorization.headers,
        body: { userId: authUser.id, role: 'user' },
      })
      if (authUser.banned) {
        await this.auth.api.unbanUser({
          headers: consoleAuthorization.headers,
          body: { userId: authUser.id },
        })
      }
      await this.auth.api.setUserPassword({
        headers: consoleAuthorization.headers,
        body: { userId: authUser.id, newPassword: credential.password },
      })
      await this.auth.api.revokeUserSessions({
        headers: consoleAuthorization.headers,
        body: { userId: authUser.id },
      })
      await this.identity.ensureProjection({
        platformUserId: platformUserIdFor(authUser.id),
        authUserId: authUser.id,
        email: credential.email,
        displayName: `${PRODUCT_CODENAME} Local Desktop`,
        personalWorkspaceId: personalWorkspaceIdFor(credential.email),
        bootstrapAdmin: false,
      })
    })

    const authorization = await this.signInLocalDesktop(credential)
    try {
      return await action(authorization)
    } finally {
      await this.auth.api.signOut({ headers: authorization.headers }).catch(() => undefined)
    }
  }

  /** 使用已认证的 Console 主体通过 Admin Plugin 官方 API 创建认证管理员。 */
  async createLocalAdminUser(
    authorization: LocalConsoleAuthorization,
    input: { email: string; password: string; name: string },
  ): Promise<LocalAuthUser> {
    const result = await this.auth.api.createUser({
      headers: authorization.headers,
      body: {
        email: input.email.trim().toLowerCase(),
        password: input.password,
        name: input.name.trim(),
        role: 'admin',
      },
    })
    const user = localCreatedUserSchema.parse(result).user
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role ?? null,
      banned: user.banned ?? false,
    }
  }

  private async signInLocalConsole(
    credential: ReturnType<typeof deriveLocalConsoleCredential>,
  ): Promise<LocalConsoleAuthorization> {
    const response = await this.auth.api.signInEmail({
      body: {
        email: credential.email,
        password: credential.password,
        rememberMe: false,
      },
      asResponse: true,
    })
    if (!response.ok) throw new Error('Better Auth 未能认证本机 Console 服务主体。')
    const headers = cookieRequestHeaders(response.headers)
    const sessionValue = await this.auth.api.getSession({
      headers,
      query: { disableCookieCache: true },
    })
    if (!sessionValue) throw new Error('Better Auth 未签发可验证的 Console 会话。')
    const session = betterAuthSessionProjectionSchema.parse(sessionValue)
    const emailMatches = session.user.email.toLowerCase() === credential.email.toLowerCase()
    const roles = splitAuthRoles(session.user.role)
    if (!emailMatches || session.user.banned || !roles.includes('admin')) {
      logger.warn({ emailMatches, banned: session.user.banned ?? false, roles }, 'local Console session validation failed')
      await this.auth.api.signOut({ headers })
      throw new Error('Console 服务主体身份或 Better Auth 管理角色无效。')
    }
    return {
      authUserId: session.user.id,
      email: credential.email,
      keyVersion: credential.keyVersion,
      headers,
    }
  }

  private async removeRotatedConsolePrincipals(current: LocalConsoleAuthorization): Promise<void> {
    const result = localListedUsersSchema.parse(await this.auth.api.listUsers({
      headers: current.headers,
      query: {
        searchValue: '@console.geo-agent-platform.invalid',
        searchField: 'email',
        searchOperator: 'ends_with',
        limit: 100,
      },
    }))
    for (const user of result.users) {
      if (user.id === current.authUserId || !isLocalConsoleEmail(user.email)) continue
      await this.auth.api.removeUser({ headers: current.headers, body: { userId: user.id } })
    }
  }

  private async findReservedAuthUser(email: string): Promise<{
    id: string
    emailVerified: boolean
  } | null> {
    const [user] = await this.db
      .select({ id: authUser.id, emailVerified: authUser.emailVerified })
      .from(authUser)
      .where(eq(authUser.email, email.trim().toLowerCase()))
      .limit(1)
    return user ?? null
  }

  private async markReservedAuthUserVerified(
    userId: string,
    alreadyVerified: boolean,
  ): Promise<void> {
    if (alreadyVerified) return
    await this.db
      .update(authUser)
      .set({ emailVerified: true, updatedAt: new Date() })
      .where(eq(authUser.id, userId))
  }

  private async findLocalAgentUser(
    authorization: LocalConsoleAuthorization,
  ): Promise<z.infer<typeof localAuthUserSchema> | null> {
    const result = localListedUsersSchema.parse(await this.auth.api.listUsers({
      headers: authorization.headers,
      query: {
        searchValue: `@${LOCAL_AGENT_EMAIL_DOMAIN}`,
        searchField: 'email',
        searchOperator: 'ends_with',
        limit: 100,
      },
    }))
    return result.users.find(user => user.email.trim().toLowerCase() === LOCAL_AGENT_EMAIL) ?? null
  }

  private async findLocalDesktopUser(
    authorization: LocalConsoleAuthorization,
  ): Promise<z.infer<typeof localAuthUserSchema> | null> {
    const result = localListedUsersSchema.parse(await this.auth.api.listUsers({
      headers: authorization.headers,
      query: {
        searchValue: `@${LOCAL_DESKTOP_EMAIL_DOMAIN}`,
        searchField: 'email',
        searchOperator: 'ends_with',
        limit: 100,
      },
    }))
    return result.users.find(user => user.email.trim().toLowerCase() === LOCAL_DESKTOP_EMAIL) ?? null
  }

  private async signInLocalAgent(
    credential: ReturnType<typeof deriveLocalAgentCredential>,
  ): Promise<LocalAgentAuthorization> {
    const response = await this.auth.api.signInEmail({
      body: {
        email: credential.email,
        password: credential.password,
        rememberMe: false,
      },
      asResponse: true,
    })
    if (!response.ok) throw new Error('Better Auth 未能认证本机 Agent 服务主体。')
    const headers = cookieRequestHeaders(response.headers)
    const sessionValue = await this.auth.api.getSession({
      headers,
      query: { disableCookieCache: true },
    })
    if (!sessionValue) throw new Error('Better Auth 未签发可验证的本机 Agent 会话。')
    const session = betterAuthSessionProjectionSchema.parse(sessionValue)
    const roles = splitAuthRoles(session.user.role)
    if (
      session.user.email.toLowerCase() !== credential.email
      || session.user.banned
      || !roles.includes('user')
      || roles.includes('admin')
    ) {
      await this.auth.api.signOut({ headers }).catch(() => undefined)
      throw new Error('本机 Agent 服务主体身份或 Better Auth 角色无效。')
    }
    const authContext = await this.authenticateLocalAgentHeaders(headers)
    if (!authContext || !authContext.roles.some(role => role.role === 'platform_admin')) {
      await this.auth.api.signOut({ headers }).catch(() => undefined)
      throw new Error('本机 Agent 最高平台权限投影无效。')
    }
    return {
      authUserId: session.user.id,
      keyVersion: credential.keyVersion,
      headers,
      authContext,
    }
  }

  private async signInLocalDesktop(
    credential: ReturnType<typeof deriveLocalDesktopCredential>,
  ): Promise<LocalDesktopAuthorization> {
    const response = await this.auth.api.signInEmail({
      body: {
        email: credential.email,
        password: credential.password,
        rememberMe: false,
      },
      asResponse: true,
    })
    if (!response.ok) throw new Error('Better Auth 未能认证本机 Desktop 服务主体。')
    const headers = cookieRequestHeaders(response.headers)
    const sessionValue = await this.auth.api.getSession({
      headers,
      query: { disableCookieCache: true },
    })
    if (!sessionValue) throw new Error('Better Auth 未签发可验证的本机 Desktop 会话。')
    const session = betterAuthSessionProjectionSchema.parse(sessionValue)
    const roles = splitAuthRoles(session.user.role)
    if (
      session.user.email.toLowerCase() !== credential.email
      || session.user.banned
      || !roles.includes('user')
      || roles.includes('admin')
    ) {
      await this.auth.api.signOut({ headers }).catch(() => undefined)
      throw new Error('本机 Desktop 服务主体身份或 Better Auth 角色无效。')
    }
    const authContext = await this.authenticateHeaders(headers)
    if (!authContext || !authContext.roles.some(role => role.role === 'analyst')) {
      await this.auth.api.signOut({ headers }).catch(() => undefined)
      throw new Error('本机 Desktop 个人工作区权限投影无效。')
    }
    return {
      authUserId: session.user.id,
      keyVersion: credential.keyVersion,
      headers,
      authContext,
    }
  }

  async setLocalAuthRole(
    authorization: LocalConsoleAuthorization,
    authUserId: string,
    role: LocalAuthRole | LocalAuthRole[],
  ): Promise<void> {
    if (Array.isArray(role) && role.length === 0) {
      throw new Error('Better Auth 角色集合不能为空。')
    }
    await this.auth.api.setRole({
      headers: authorization.headers,
      body: { userId: authUserId, role },
    })
  }

  async setLocalUserPassword(
    authorization: LocalConsoleAuthorization,
    authUserId: string,
    newPassword: string,
  ): Promise<void> {
    await this.auth.api.setUserPassword({
      headers: authorization.headers,
      body: { userId: authUserId, newPassword },
    })
  }

  async setLocalUserBanned(
    authorization: LocalConsoleAuthorization,
    authUserId: string,
    banned: boolean,
  ): Promise<void> {
    if (banned) {
      await this.auth.api.banUser({
        headers: authorization.headers,
        body: { userId: authUserId, banReason: '由服务器本地 Console 禁用' },
      })
      return
    }
    await this.auth.api.unbanUser({ headers: authorization.headers, body: { userId: authUserId } })
  }

  async revokeLocalUserSessions(
    authorization: LocalConsoleAuthorization,
    authUserId: string,
  ): Promise<void> {
    await this.auth.api.revokeUserSessions({ headers: authorization.headers, body: { userId: authUserId } })
  }

  async authenticateRequest(request: Request): Promise<AuthContext | null> {
    return this.authenticateHeaders(request.headers)
  }

  async authenticateHeaders(headers: Headers): Promise<AuthContext | null> {
    const session = await this.auth.api.getSession({
      headers,
      query: { disableCookieCache: true },
    })
    if (!session) return null
    const projection = betterAuthSessionProjectionSchema.parse(session)
    if (isLocalConsoleEmail(projection.user.email) || isLocalAgentEmail(projection.user.email)) return null
    return this.ensurePlatformProjection(projection, false)
  }

  /** 仅供已经证明来自本机 loopback 的 Agent 传输调用。 */
  async authenticateLocalAgentHeaders(headers: Headers): Promise<AuthContext | null> {
    const session = await this.auth.api.getSession({
      headers,
      query: { disableCookieCache: true },
    })
    if (!session) return null
    const projection = betterAuthSessionProjectionSchema.parse(session)
    if (!isLocalAgentEmail(projection.user.email) || projection.user.banned) return null
    const roles = splitAuthRoles(projection.user.role)
    if (!roles.includes('user') || roles.includes('admin')) return null
    return this.ensurePlatformProjection(projection, true)
  }

  requireCsrf(request: Request, auth: AuthContext): void {
    const configured = this.env.CSRF_HEADER_NAME
    const headerValue = request.headers.get(configured) ?? request.headers.get(configured.toLowerCase())
    if (!headerValue || headerValue !== auth.csrfToken) {
      throw new Error('CSRF 校验失败。')
    }
  }

  isTrustedOrigin(origin?: string | null): boolean {
    if (!origin) return false
    return this.trustedOrigins().has(normalizeTrustedOrigin(origin))
  }

  trustedOrigins(): Set<string> {
    const origins = [
      ...this.env.TRUSTED_ORIGINS.split(','),
      this.env.APP_BASE_URL,
      this.env.BETTER_AUTH_URL,
      PLATFORM_DESKTOP_APP_ORIGIN,
      PLATFORM_DESKTOP_AUTH_ORIGIN,
    ]
    return new Set(origins.map(normalizeTrustedOrigin).filter(Boolean))
  }

  toAuthMe(auth: AuthContext): AuthMe {
    return {
      user: {
        userId: auth.userId,
        subject: auth.subject,
        email: auth.email,
        displayName: auth.displayName,
        status: 'active',
        lastLoginAt: null,
        createdAt: '',
        updatedAt: '',
      },
      defaultWorkspace: null,
      memberships: auth.roles.map(role => ({
        membershipId: `${role.workspaceId}:${role.role}`,
        workspaceId: role.workspaceId,
        userId: auth.userId,
        role: role.role,
        createdAt: '',
      })),
      platformRoles: [...new Set(auth.roles.map(role => role.role))],
      csrfToken: auth.csrfToken,
      permissions: [],
    }
  }

  async revokeUserSessionsByPlatformUserId(platformUserId: string): Promise<void> {
    await this.identity.revokePlatformUserSessions(platformUserId)
  }

  private async ensurePlatformProjection(
    session: BetterAuthSessionProjection,
    localAgent: boolean,
  ): Promise<AuthContext | null> {
    const authUserId = requireString(session.user.id, 'Better Auth user id')
    const email = requireString(session.user.email, 'Better Auth email').toLowerCase()
    const displayName = requireString(session.user.name || email, 'Better Auth user name')
    const platformUserId = platformUserIdFor(authUserId)
    const { user: platformUser, roles } = await this.identity.ensureProjection({
      platformUserId,
      authUserId,
      email,
      displayName,
      personalWorkspaceId: personalWorkspaceIdFor(email),
      bootstrapAdmin: localAgent || this.env.BOOTSTRAP_ADMIN_EMAIL?.toLowerCase() === email,
    })
    if (platformUser.status !== 'active') {
      await this.identity.revokeAuthUserSessions(authUserId)
      return null
    }
    if (!roles.length) return null
    return {
      userId: platformUser.userId,
      subject: authUserId,
      email,
      displayName,
      authSessionId: session.session.id,
      authSessionExpiresAt: normalizeDateString(session.session.expiresAt),
      csrfToken: this.csrfForSession(session.session.id),
      defaultWorkspaceId: pickDefaultWorkspace(roles),
      roles,
    }
  }

  async isAuthContextActive(auth: AuthContext): Promise<boolean> {
    return this.identity.isAuthSessionActive(auth.authSessionId)
  }

  async listUserRoles(userId: string): Promise<AuthRoleBinding[]> {
    return this.identity.listUserRoles(userId)
  }

  async buildServiceAuthContext(platformUserId: string, workspaceId: string): Promise<AuthContext> {
    const user = await this.identity.getUser(platformUserId)
    if (!user || user.status !== 'active') {
      throw new Error('Automation 创建者已禁用或不存在，任务不会执行。')
    }
    const roles = await this.listUserRoles(platformUserId)
    const hasWorkspaceRole = roles.some(role => role.role === 'platform_admin' || role.workspaceId === workspaceId)
    if (!hasWorkspaceRole) {
      throw new Error('Automation 创建者已失去当前工作区权限，任务不会执行。')
    }
    return {
      userId: user.userId,
      subject: user.subject,
      email: user.email.toLowerCase(),
      displayName: user.displayName,
      authSessionId: `automation:${user.userId}`,
      authSessionExpiresAt: null,
      csrfToken: '',
      defaultWorkspaceId: workspaceId,
      roles,
    }
  }

  private csrfForSession(sessionId: string): string {
    return createHmac('sha256', this.env.BETTER_AUTH_SECRET).update(`csrf:${sessionId}`).digest('base64url')
  }
}

function pickDefaultWorkspace(roles: AuthRoleBinding[]): string {
  const workspaceRole = roles.find(item => item.role === 'workspace_admin')
    ?? roles.find(item => item.role === 'analyst')
    ?? roles.find(item => item.role === 'viewer')
    ?? roles[0]
  if (!workspaceRole) throw new Error('用户没有任何工作区成员关系。')
  return workspaceRole.workspaceId
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} 缺失。`)
  return value.trim()
}

function normalizeDateString(value: string | Date | null | undefined): string | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function normalizeTrustedOrigin(value: string): string {
  const trimmed = value.trim()
  if (/^[a-z][a-z0-9+.-]*:\/$/iu.test(trimmed)) return trimmed
  return trimmed.replace(/\/+$/u, '')
}

function splitAuthRoles(value: string | null | undefined): string[] {
  return value?.split(',').map(role => role.trim()).filter(Boolean) ?? []
}

function cookieRequestHeaders(responseHeaders: Headers): Headers {
  const setCookies = responseHeaders.getSetCookie()
  const cookie = setCookies
    .map(value => value.split(';', 1)[0])
    .filter((value): value is string => Boolean(value))
    .join('; ')
  if (!cookie) throw new Error('Better Auth 登录成功但没有返回会话 Cookie。')
  return new Headers({ cookie })
}

async function requestContainsReservedLocalEmail(request: Request): Promise<boolean> {
  const contentType = request.headers.get('content-type')?.toLowerCase() ?? ''
  try {
    if (contentType.includes('application/json')) {
      const value: unknown = await request.clone().json()
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false
      return Object.entries(value).some(([name, field]) =>
        name.toLowerCase().includes('email')
        && typeof field === 'string'
        && (
          isLocalConsoleEmail(field)
          || isLocalAgentEmail(field)
          || isLocalDesktopEmail(field)
        ))
    }
    if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data')) {
      const form = await request.clone().formData()
      return [...form.entries()].some(([name, field]) =>
        name.toLowerCase().includes('email')
        && typeof field === 'string'
        && (
          isLocalConsoleEmail(field)
          || isLocalAgentEmail(field)
          || isLocalDesktopEmail(field)
        ))
    }
  } catch {
    return false
  }
  return false
}
