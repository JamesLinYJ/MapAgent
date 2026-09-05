// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工作区成员关系仓储
//
//   文件:       membershipRepository.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
//   来源:       adminMembershipRepository.ts 与 platformIdentityStore.ts 的成员资源边界
// --------------------------------------------------------------------------

import {
  adminMembershipSchema,
  platformRoleSchema,
  type AdminMembership,
  type PlatformRole,
} from '@geo-agent-platform/shared-types/platform'
import { and, asc, eq } from 'drizzle-orm'

import type { Database, DatabaseTransaction } from '../../db/connection.js'
import { platformMemberships, platformUsers } from '../../db/schema.js'
import type { AuthRoleBinding } from '../../security/types.js'
import { makeId } from '../../utils/ids.js'

/** 工作区成员关系的唯一读写边界，统一服务身份投影和安全后台。 */
export class MembershipRepository {
  constructor(private readonly db: Database) {}

  async listForWorkspace(workspaceId: string): Promise<AdminMembership[]> {
    const rows = await this.db.select({
      membershipId: platformMemberships.membershipId,
      workspaceId: platformMemberships.workspaceId,
      userId: platformMemberships.userId,
      role: platformMemberships.role,
      createdAt: platformMemberships.createdAt,
      email: platformUsers.email,
      displayName: platformUsers.displayName,
    }).from(platformMemberships)
      .innerJoin(platformUsers, eq(platformUsers.userId, platformMemberships.userId))
      .where(eq(platformMemberships.workspaceId, workspaceId))
      .orderBy(asc(platformUsers.email), asc(platformMemberships.role))
    return rows.map(row => adminMembershipSchema.parse({
      ...row,
      createdAt: row.createdAt.toISOString(),
    }))
  }

  async insert(
    input: { workspaceId: string; userId: string; role: PlatformRole },
    executor: Database | DatabaseTransaction = this.db,
  ): Promise<boolean> {
    const rows = await executor.insert(platformMemberships).values({
      membershipId: makeId('membership'),
      workspaceId: input.workspaceId,
      userId: input.userId,
      role: input.role,
      createdAt: new Date(),
    }).onConflictDoNothing({
      target: [platformMemberships.workspaceId, platformMemberships.userId, platformMemberships.role],
    }).returning({ membershipId: platformMemberships.membershipId })
    return rows.length === 1
  }

  async listRoleBindings(
    userId: string,
    executor: Database | DatabaseTransaction = this.db,
  ): Promise<AuthRoleBinding[]> {
    const rows = await executor.select({
      workspaceId: platformMemberships.workspaceId,
      role: platformMemberships.role,
    }).from(platformMemberships)
      .where(eq(platformMemberships.userId, userId))
      .orderBy(asc(platformMemberships.role), asc(platformMemberships.workspaceId))
    return rows.map(row => ({
      workspaceId: row.workspaceId,
      role: parseRole(row.role),
    }))
  }

  async getWorkspaceId(membershipId: string): Promise<string | null> {
    const rows = await this.db.select({ workspaceId: platformMemberships.workspaceId })
      .from(platformMemberships)
      .where(eq(platformMemberships.membershipId, membershipId))
      .limit(1)
    return rows[0]?.workspaceId ?? null
  }

  async deleteRoleForUser(
    userId: string,
    role: PlatformRole,
    executor: Database | DatabaseTransaction = this.db,
  ): Promise<Array<{ membershipId: string; workspaceId: string }>> {
    return executor.delete(platformMemberships)
      .where(and(eq(platformMemberships.userId, userId), eq(platformMemberships.role, role)))
      .returning({
        membershipId: platformMemberships.membershipId,
        workspaceId: platformMemberships.workspaceId,
      })
  }

  async deleteRoleBinding(
    input: { workspaceId: string; userId: string; role: PlatformRole },
    executor: Database | DatabaseTransaction = this.db,
  ): Promise<boolean> {
    const rows = await executor.delete(platformMemberships)
      .where(and(
        eq(platformMemberships.workspaceId, input.workspaceId),
        eq(platformMemberships.userId, input.userId),
        eq(platformMemberships.role, input.role),
      ))
      .returning({ membershipId: platformMemberships.membershipId })
    return rows.length === 1
  }

  async delete(membershipId: string): Promise<boolean> {
    const rows = await this.db.delete(platformMemberships)
      .where(eq(platformMemberships.membershipId, membershipId))
      .returning({ membershipId: platformMemberships.membershipId })
    return rows.length === 1
  }
}

function parseRole(value: string): PlatformRole {
  const parsed = platformRoleSchema.safeParse(value)
  if (!parsed.success) throw new Error(`成员关系包含不受支持的角色 '${value}'。`)
  return parsed.data
}
