// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工作区仓储
//
//   文件:       workspaceRepository.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
//   来源:       adminWorkspaceRepository.ts 与 platformIdentityStore.ts 的工作区资源边界
// --------------------------------------------------------------------------

import {
  platformWorkspaceSchema,
  type AdminWorkspaceCreate,
  type PlatformWorkspace,
} from '@geo-agent-platform/shared-types/platform'
import { desc, eq } from 'drizzle-orm'

import type { Database, DatabaseTransaction } from '../../db/connection.js'
import { platformMemberships, platformWorkspaces } from '../../db/schema.js'

export interface CreateWorkspaceRecord extends AdminWorkspaceCreate {
  workspaceId: string
  createdByUserId: string
  createdAt: Date
}

export interface PersonalWorkspaceRecord {
  workspaceId: string
  userId: string
  displayName: string
}

/** 工作区记录的唯一读写边界；跨资源事务由应用服务持有。 */
export class WorkspaceRepository {
  constructor(private readonly db: Database) {}

  async listVisible(input: { platformAdmin: boolean; userId: string }): Promise<PlatformWorkspace[]> {
    const rows = input.platformAdmin
      ? await this.db.select().from(platformWorkspaces)
        .orderBy(desc(platformWorkspaces.updatedAt)).limit(200)
      : await this.db.select({
        workspaceId: platformWorkspaces.workspaceId,
        name: platformWorkspaces.name,
        description: platformWorkspaces.description,
        status: platformWorkspaces.status,
        createdByUserId: platformWorkspaces.createdByUserId,
        createdAt: platformWorkspaces.createdAt,
        updatedAt: platformWorkspaces.updatedAt,
      }).from(platformWorkspaces)
        .innerJoin(platformMemberships, eq(platformMemberships.workspaceId, platformWorkspaces.workspaceId))
        .where(eq(platformMemberships.userId, input.userId))
        .orderBy(desc(platformWorkspaces.updatedAt))
    return rows.map(mapWorkspaceRow)
  }

  async insert(tx: DatabaseTransaction, input: CreateWorkspaceRecord): Promise<PlatformWorkspace> {
    const rows = await tx.insert(platformWorkspaces).values({
      workspaceId: input.workspaceId,
      name: input.name,
      description: input.description,
      status: 'active',
      createdByUserId: input.createdByUserId,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    }).returning()
    const row = rows[0]
    if (!row) throw new Error(`工作区 '${input.workspaceId}' 创建失败`)
    return mapWorkspaceRow(row)
  }

  async ensurePersonal(
    input: PersonalWorkspaceRecord,
    executor: Database | DatabaseTransaction = this.db,
  ): Promise<void> {
    const now = new Date()
    const inserted = await executor.insert(platformWorkspaces).values({
      workspaceId: input.workspaceId,
      name: `${input.displayName} 的工作区`,
      description: '首次注册自动创建的个人工作区',
      status: 'active',
      createdByUserId: input.userId,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing({ target: platformWorkspaces.workspaceId }).returning({
      createdByUserId: platformWorkspaces.createdByUserId,
    })
    if (inserted[0]) return

    const existing = await executor.select({ createdByUserId: platformWorkspaces.createdByUserId })
      .from(platformWorkspaces)
      .where(eq(platformWorkspaces.workspaceId, input.workspaceId))
      .limit(1)
    if (existing[0]?.createdByUserId !== input.userId) {
      throw new Error(`个人工作区 '${input.workspaceId}' 的所有权不一致。`)
    }
  }
}

function mapWorkspaceRow(row: typeof platformWorkspaces.$inferSelect): PlatformWorkspace {
  return platformWorkspaceSchema.parse({
    workspaceId: row.workspaceId,
    name: row.name,
    description: row.description,
    status: row.status,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  })
}
