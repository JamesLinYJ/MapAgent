// +-------------------------------------------------------------------------
//
//   地理智能平台 - 平台用户仓储
//
//   文件:       platformUserRepository.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
//   来源:       adminUserRepository.ts 与 platformIdentityStore.ts 的用户资源边界
// --------------------------------------------------------------------------

import {
  platformUserSchema,
  type AdminUserPatch,
  type PlatformUser,
} from '@geo-agent-platform/shared-types/platform'
import { desc, eq } from 'drizzle-orm'

import type { Database, DatabaseTransaction } from '../../db/connection.js'
import { platformUsers } from '../../db/schema.js'

export interface IdentityProjectionInput {
  platformUserId: string
  subject: string
  email: string
  displayName: string
}

/** 平台用户记录的唯一读写边界，供身份投影和安全后台共同使用。 */
export class PlatformUserRepository {
  constructor(private readonly db: Database) {}

  async list(): Promise<PlatformUser[]> {
    const rows = await this.db.select().from(platformUsers)
      .orderBy(desc(platformUsers.updatedAt))
      .limit(200)
    return rows.map(mapUserRow)
  }

  async update(userId: string, fields: AdminUserPatch): Promise<boolean> {
    const values: { displayName?: string; status?: 'active' | 'disabled'; updatedAt: Date } = {
      updatedAt: new Date(),
    }
    if (fields.displayName !== undefined) values.displayName = fields.displayName
    if (fields.status !== undefined) values.status = fields.status
    const rows = await this.db.update(platformUsers).set(values)
      .where(eq(platformUsers.userId, userId))
      .returning({ userId: platformUsers.userId })
    return rows.length === 1
  }

  async getById(
    userId: string,
    executor: Database | DatabaseTransaction = this.db,
  ): Promise<PlatformUser | null> {
    const rows = await executor.select().from(platformUsers)
      .where(eq(platformUsers.userId, userId))
      .limit(1)
    return rows[0] ? mapUserRow(rows[0]) : null
  }

  async getBySubject(
    subject: string,
    executor: Database | DatabaseTransaction = this.db,
  ): Promise<PlatformUser | null> {
    const rows = await executor.select().from(platformUsers)
      .where(eq(platformUsers.subject, subject))
      .limit(1)
    return rows[0] ? mapUserRow(rows[0]) : null
  }

  async upsertIdentityProjection(
    input: IdentityProjectionInput,
    executor: Database | DatabaseTransaction = this.db,
  ): Promise<{ created: boolean; user: PlatformUser }> {
    const now = new Date()
    const inserted = await executor.insert(platformUsers).values({
      userId: input.platformUserId,
      subject: input.subject,
      email: input.email,
      displayName: input.displayName,
      status: 'active',
      lastLoginAt: now,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing({ target: platformUsers.subject }).returning()
    const insertedUser = inserted[0]
    if (insertedUser) return { created: true, user: mapUserRow(insertedUser) }

    const updated = await executor.update(platformUsers).set({
      email: input.email,
      displayName: input.displayName,
      lastLoginAt: now,
      updatedAt: now,
    }).where(eq(platformUsers.subject, input.subject)).returning()
    const updatedUser = updated[0]
    if (!updatedUser) throw new Error('平台用户投影写入后无法读取。')
    return { created: false, user: mapUserRow(updatedUser) }
  }
}

function mapUserRow(row: typeof platformUsers.$inferSelect): PlatformUser {
  return platformUserSchema.parse({
    userId: row.userId,
    subject: row.subject,
    email: row.email,
    displayName: row.displayName,
    status: row.status,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  })
}
