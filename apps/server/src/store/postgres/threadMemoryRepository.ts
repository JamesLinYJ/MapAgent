// +-------------------------------------------------------------------------
//
//   地理智能平台 - 线程记忆版本仓储
//
//   文件:       threadMemoryRepository.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { and, desc, eq, ne } from 'drizzle-orm'

import type { Database } from '../../db/connection.js'
import {
  platformThreadMemoryVersions,
  platformThreads,
} from '../../db/schema.js'
import type { ThreadMemoryDocument } from '../../schemas/types.js'
import { MemoryVersionConflictError } from '../storeErrors.js'
import type { ThreadMemoryVersionReference } from './conversationPersistencePorts.js'
import { mapThreadMemoryVersionRow } from './conversationRowMappers.js'

/** 线程长期上下文的乐观版本写入与读取边界。 */
export class PostgresThreadMemoryRepository {
  constructor(private readonly db: Database) {}

  async saveThreadMemoryVersion(input: {
    threadId: string
    expectedVersion: number
    version: number
    contentHash: string
    source: ThreadMemoryDocument['source']
    basedOnEntryId: string | null
    estimatedTokens: number
    createdAt: string
  }): Promise<ThreadMemoryVersionReference> {
    return this.db.transaction(async tx => {
      const rows = await tx.select().from(platformThreads)
        .where(eq(platformThreads.threadId, input.threadId)).for('update').limit(1)
      const thread = rows[0]
      if (!thread || thread.status === 'deleted') throw new Error(`线程 '${input.threadId}' 不存在`)
      if (thread.memoryVersion !== input.expectedVersion) {
        throw new MemoryVersionConflictError(input.expectedVersion, thread.memoryVersion)
      }
      if (input.version !== thread.memoryVersion + 1) {
        throw new Error(`线程记忆版本必须从 ${thread.memoryVersion} 递增到 ${thread.memoryVersion + 1}`)
      }
      const createdAt = new Date(input.createdAt)
      await tx.insert(platformThreadMemoryVersions).values({
        threadId: input.threadId,
        version: input.version,
        contentHash: input.contentHash,
        source: input.source,
        basedOnEntryId: input.basedOnEntryId,
        estimatedTokens: input.estimatedTokens,
        createdAt,
      })
      await tx.update(platformThreads).set({
        memoryVersion: input.version,
        memoryBasedOnTokens: thread.estimatedContextTokens,
        updatedAt: createdAt,
      }).where(eq(platformThreads.threadId, input.threadId))
      return mapThreadMemoryVersionRow({
        threadId: input.threadId,
        version: input.version,
        contentHash: input.contentHash,
        source: input.source,
        basedOnEntryId: input.basedOnEntryId,
        estimatedTokens: input.estimatedTokens,
        createdAt,
      })
    })
  }

  async getLatestThreadMemoryVersion(threadId: string): Promise<ThreadMemoryVersionReference | null> {
    const threadRows = await this.db.select({ threadId: platformThreads.threadId })
      .from(platformThreads).where(and(
        eq(platformThreads.threadId, threadId),
        ne(platformThreads.status, 'deleted'),
      )).limit(1)
    if (!threadRows[0]) throw new Error(`线程 '${threadId}' 不存在`)
    const rows = await this.db.select().from(platformThreadMemoryVersions)
      .where(eq(platformThreadMemoryVersions.threadId, threadId))
      .orderBy(desc(platformThreadMemoryVersions.version)).limit(1)
    return rows[0] ? mapThreadMemoryVersionRow(rows[0]) : null
  }
}
