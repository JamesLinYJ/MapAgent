// +-------------------------------------------------------------------------
//
//   地理智能平台 - 线程压缩记录仓储
//
//   文件:       threadCompactionRepository.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { asc, eq } from 'drizzle-orm'

import type { Database } from '../../db/connection.js'
import {
  platformThreadCompactions,
  platformThreads,
} from '../../db/schema.js'
import {
  compactionRecordSchema,
  type CompactionRecord,
} from '../../schemas/types.js'
import { mapCompactionRow } from './conversationRowMappers.js'

/** 上下文压缩事实及线程压缩指针的原子写入边界。 */
export class PostgresThreadCompactionRepository {
  constructor(private readonly db: Database) {}

  async appendCompaction(record: CompactionRecord): Promise<void> {
    const parsed = compactionRecordSchema.parse(record)
    await this.db.transaction(async tx => {
      const existingRows = await tx.select().from(platformThreadCompactions)
        .where(eq(platformThreadCompactions.compactionId, parsed.compactionId)).limit(1)
      const existing = existingRows[0]
      if (existing) {
        const current = mapCompactionRow(existing)
        if (JSON.stringify(current) !== JSON.stringify(parsed)) {
          throw new Error(`压缩记录 '${parsed.compactionId}' 与首次写入不一致`)
        }
        return
      }
      await tx.insert(platformThreadCompactions).values({
        compactionId: parsed.compactionId,
        threadId: parsed.threadId,
        boundaryEntryId: parsed.boundaryEntryId,
        summaryEntryId: parsed.summaryEntryId,
        firstCompactedEntryId: parsed.firstCompactedEntryId,
        lastCompactedEntryId: parsed.lastCompactedEntryId,
        preservedFromEntryId: parsed.preservedFromEntryId,
        sourceDigest: parsed.sourceDigest,
        sourceEntryIdsJson: parsed.sourceEntryIds,
        sourceUnitIdsJson: parsed.sourceUnitIds,
        sourceObjectHashesJson: parsed.sourceObjectHashes,
        summary: parsed.summary,
        strategy: parsed.strategy,
        summaryProvider: parsed.summaryProvider,
        summaryModel: parsed.summaryModel,
        promptVersion: parsed.promptVersion,
        preTokens: parsed.preTokens,
        postTokens: parsed.postTokens,
        createdAt: new Date(parsed.createdAt),
      })
      const updated = await tx.update(platformThreads).set({
        latestCompactionId: parsed.compactionId,
        estimatedContextTokens: parsed.postTokens,
        updatedAt: new Date(parsed.createdAt),
      }).where(eq(platformThreads.threadId, parsed.threadId)).returning({ threadId: platformThreads.threadId })
      if (!updated[0]) throw new Error(`线程 '${parsed.threadId}' 不存在`)
    })
  }

  async listCompactions(threadId: string): Promise<CompactionRecord[]> {
    const rows = await this.db.select().from(platformThreadCompactions)
      .where(eq(platformThreadCompactions.threadId, threadId))
      .orderBy(asc(platformThreadCompactions.createdAt))
    return rows.map(mapCompactionRow)
  }
}
