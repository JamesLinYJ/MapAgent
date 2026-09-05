// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运行记录序列追加器
//
//   文件:       runRecordAppender.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { eq, sql } from 'drizzle-orm'
import type { Database } from '../../db/connection.js'
import { platformRunRecords, platformRuns } from '../../db/schema.js'
import { makeId } from '../../utils/ids.js'

export type DatabaseTransaction = Parameters<Parameters<Database['transaction']>[0]>[0]

export interface RunRecordDraft {
  recordType: string
  payloadJson: Record<string, unknown>
}

/** 在已持有 run 行锁的事务中分配严格递增的运行记录序号。 */
export class RunRecordAppender {
  async append(
    tx: DatabaseTransaction,
    runId: string,
    threadId: string | null,
    records: RunRecordDraft[],
    traceId: string | null,
  ): Promise<void> {
    if (!records.length) return
    const sequenceRows = await tx.update(platformRuns)
      .set({ nextRecordSequence: sql`${platformRuns.nextRecordSequence} + ${records.length}` })
      .where(eq(platformRuns.runId, runId))
      .returning({ nextRecordSequence: platformRuns.nextRecordSequence })
    const sequenceRow = sequenceRows[0]
    if (!sequenceRow) throw new Error(`运行 '${runId}' 不存在`)
    const firstSequence = sequenceRow.nextRecordSequence - records.length
    await tx.insert(platformRunRecords).values(records.map((record, index) => ({
      recordId: makeId('record'),
      runId,
      threadId,
      sequence: firstSequence + index,
      recordType: record.recordType,
      payloadJson: record.payloadJson,
      traceId,
    })))
  }
}
