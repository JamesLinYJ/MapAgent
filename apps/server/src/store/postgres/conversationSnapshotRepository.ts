// +-------------------------------------------------------------------------
//
//   地理智能平台 - 会话快照持久化
//
//   文件:       conversationSnapshotRepository.ts
//
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { Database } from '../../db/connection.js'
import { runDomainSnapshotSchema } from '../../schemas/types.js'
import {
  platformRuns,
  platformRunSnapshots,
  platformSessions,
  platformThreads,
} from '../../db/schema.js'
import type {
  ConversationSnapshot,
  ConversationSnapshotRepository,
} from './conversationPersistencePorts.js'
import {
  mapAnalysisRunRow,
  mapDeletedThreadRow,
  mapSessionRow,
  mapThreadRow,
} from './conversationRowMappers.js'

export class PostgresConversationSnapshotRepository implements ConversationSnapshotRepository {
  constructor(private readonly db: Database) {}

  async loadSnapshot(): Promise<ConversationSnapshot> {
    return this.db.transaction(async tx => {
      // 三类行必须来自同一个 PostgreSQL snapshot。transaction client 上顺序
      // 查询同时兼容 pg 9，不能用 Promise.all 并发复用同一连接。
      const sessionRows = await tx.select().from(platformSessions)
      const threadRows = await tx.select().from(platformThreads)
      const runRows = await tx.select().from(platformRuns)
      const runSnapshotRows = await tx.select().from(platformRunSnapshots)
      const activeThreadRows = threadRows.filter(row => row.status !== 'deleted')
      const activeThreadIds = new Set(activeThreadRows.map(row => row.threadId))
      const authoritativeRuns = mapAuthoritativeRunRows(runRows, runSnapshotRows)
      return {
        sessions: sessionRows.map(mapSessionRow),
        threads: activeThreadRows.map(mapThreadRow),
        deletedThreads: threadRows
          .filter(row => row.status === 'deleted')
          .map(mapDeletedThreadRow),
        runs: authoritativeRuns
          .filter(run => run.threadId === null || activeThreadIds.has(run.threadId)),
      }
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
  }
}

export function mapAuthoritativeRunRows(
  runRows: readonly (typeof platformRuns.$inferSelect)[],
  snapshotRows: readonly (typeof platformRunSnapshots.$inferSelect)[],
): ConversationSnapshot['runs'] {
  const snapshots = new Map(snapshotRows.map(row => [row.runId, runDomainSnapshotSchema.parse(row.stateJson)]))
  return runRows.map(row => {
    const snapshot = snapshots.get(row.runId)
    if (!snapshot) {
      throw new Error(`运行 '${row.runId}' 缺少权威 platform_run_snapshots 记录`)
    }
    return mapAnalysisRunRow(row, snapshot)
  })
}
