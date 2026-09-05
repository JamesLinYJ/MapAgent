// +-------------------------------------------------------------------------
//
//   地理智能平台 - 本地账户管理查询仓储
//
//   文件:       localAccountRepository.ts
//
//   日期:       2026年07月21日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { and, asc, eq, ilike, inArray, not, sql } from 'drizzle-orm'
import type { LocalManagedAccount } from '@geo-agent-platform/shared-types/local-operations'

import type { Database } from '../../db/connection.js'
import { authUser, platformMemberships, platformUsers } from '../../db/schema.js'
import { LOCAL_AGENT_EMAIL_DOMAIN } from '../../security/localAgentPrincipal.js'
import { LOCAL_CONSOLE_EMAIL_DOMAIN } from '../../security/localConsolePrincipal.js'

export type { LocalManagedAccount } from '@geo-agent-platform/shared-types/local-operations'

/** 汇总 Better Auth 身份与 平台 权限投影；只读，不成为新的账户事实源。 */
export class LocalAccountRepository {
  constructor(private readonly db: Database) {}

  async list(): Promise<LocalManagedAccount[]> {
    const users = await this.db.select({
      authUserId: authUser.id,
      email: authUser.email,
      displayName: authUser.name,
      authRole: authUser.role,
      banned: authUser.banned,
      platformUserId: platformUsers.userId,
      platformStatus: platformUsers.status,
    }).from(authUser)
      .leftJoin(platformUsers, eq(platformUsers.subject, authUser.id))
      .where(and(
        not(ilike(authUser.email, `%@${LOCAL_CONSOLE_EMAIL_DOMAIN}`)),
        not(ilike(authUser.email, `%@${LOCAL_AGENT_EMAIL_DOMAIN}`)),
      ))
      .orderBy(asc(authUser.email))
      .limit(500)
    return this.attachRoles(users)
  }

  async getByEmail(email: string): Promise<LocalManagedAccount | null> {
    const normalized = email.trim().toLowerCase()
    const users = await this.db.select({
      authUserId: authUser.id,
      email: authUser.email,
      displayName: authUser.name,
      authRole: authUser.role,
      banned: authUser.banned,
      platformUserId: platformUsers.userId,
      platformStatus: platformUsers.status,
    }).from(authUser)
      .leftJoin(platformUsers, eq(platformUsers.subject, authUser.id))
      .where(and(
        ilike(authUser.email, normalized),
        not(ilike(authUser.email, `%@${LOCAL_CONSOLE_EMAIL_DOMAIN}`)),
        not(ilike(authUser.email, `%@${LOCAL_AGENT_EMAIL_DOMAIN}`)),
      ))
      .limit(1)
    const account = (await this.attachRoles(users))[0]
    return account ?? null
  }

  async countActivePlatformAdmins(): Promise<number> {
    const rows = await this.db.select({ userId: platformUsers.userId })
      .from(platformMemberships)
      .innerJoin(platformUsers, eq(platformUsers.userId, platformMemberships.userId))
      .innerJoin(authUser, eq(authUser.id, platformUsers.subject))
      .where(and(
        eq(platformMemberships.role, 'platform_admin'),
        eq(platformUsers.status, 'active'),
        eq(authUser.banned, false),
        not(ilike(authUser.email, `%@${LOCAL_CONSOLE_EMAIL_DOMAIN}`)),
        not(ilike(authUser.email, `%@${LOCAL_AGENT_EMAIL_DOMAIN}`)),
        sql<boolean>`(',' || regexp_replace(lower(${authUser.role}), '[[:space:]]', '', 'g') || ',') LIKE '%,admin,%'`,
      ))
      .groupBy(platformUsers.userId)
    return rows.length
  }

  private async attachRoles(users: Array<{
    authUserId: string
    email: string
    displayName: string
    authRole: string
    banned: boolean
    platformUserId: string | null
    platformStatus: string | null
  }>): Promise<LocalManagedAccount[]> {
    const platformUserIds = users
      .map(user => user.platformUserId)
      .filter((userId): userId is string => Boolean(userId))
    const bindings = platformUserIds.length
      ? await this.db.select({
        userId: platformMemberships.userId,
        workspaceId: platformMemberships.workspaceId,
        role: platformMemberships.role,
      }).from(platformMemberships)
        .where(inArray(platformMemberships.userId, platformUserIds))
        .orderBy(asc(platformMemberships.role), asc(platformMemberships.workspaceId))
      : []
    return users.map(user => ({
      authUserId: user.authUserId,
      email: user.email.toLowerCase(),
      displayName: user.displayName,
      authRole: user.authRole,
      banned: user.banned,
      platformUserId: user.platformUserId,
      platformStatus: parsePlatformStatus(user.platformStatus),
      platformRoles: bindings
        .filter(binding => binding.userId === user.platformUserId)
        .map(binding => ({ workspaceId: binding.workspaceId, role: binding.role })),
    }))
  }
}

function parsePlatformStatus(value: string | null): 'active' | 'disabled' | null {
  if (value === null || value === 'active' || value === 'disabled') return value
  throw new Error(`平台账户包含不受支持的状态 '${value}'。`)
}
