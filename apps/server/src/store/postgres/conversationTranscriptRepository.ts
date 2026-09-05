// +-------------------------------------------------------------------------
//
//   地理智能平台 - 对话树仓储
//
//   文件:       conversationTranscriptRepository.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { and, asc, desc, eq, lt } from 'drizzle-orm'

import type { Database, DatabaseTransaction } from '../../db/connection.js'
import {
  platformConversationEntries,
  platformEventOutbox,
  platformRuns,
  platformThreads,
} from '../../db/schema.js'
import { currentLogContext } from '../../observability/logger.js'
import type { TranscriptEntry } from '../../schemas/types.js'
import { makeId } from '../../utils/ids.js'
import { decodeHistoryCursor, encodeHistoryCursor, estimateTokens } from '../conversationEncoding.js'
import type { RunMutationQueue } from '../runMutationQueue.js'
import type {
  AppendConversationEntryInput,
  ThreadHistoryPage,
} from './conversationPersistencePorts.js'
import { mapTranscriptEntryRow } from './conversationRowMappers.js'

/** 分支对话条目、父链和事件 outbox 的唯一写入边界。 */
export class PostgresConversationTranscriptRepository {
  constructor(
    private readonly db: Database,
    private readonly runMutations: RunMutationQueue,
  ) {}

  async appendConversationEntry(input: AppendConversationEntryInput): Promise<TranscriptEntry> {
    const traceId = stringContextValue('traceId')
    const append = () => this.db.transaction(async tx => {
      const existingId = input.entryId
      if (existingId) {
        const existing = await tx.select().from(platformConversationEntries)
          .where(eq(platformConversationEntries.entryId, existingId)).limit(1)
        const row = existing[0]
        if (row) return mapTranscriptEntryRow(row)
      }

      if (input.runId) {
        const runRows = await tx.select({ threadId: platformRuns.threadId }).from(platformRuns)
          .where(eq(platformRuns.runId, input.runId)).for('update').limit(1)
        const run = runRows[0]
        if (!run) throw new Error(`运行 '${input.runId}' 不存在`)
        if (run.threadId !== input.threadId) {
          throw new Error(`运行 '${input.runId}' 不属于线程 '${input.threadId}'`)
        }
      }

      const threadRows = await tx.select().from(platformThreads)
        .where(eq(platformThreads.threadId, input.threadId)).for('update').limit(1)
      const thread = threadRows[0]
      if (!thread) throw new Error(`线程 '${input.threadId}' 不存在`)
      if (thread.status === 'deleted') throw new Error(`线程 '${input.threadId}' 已删除`)
      if (thread.quarantined) throw new Error(`线程已隔离：${thread.quarantineReason ?? '存储损坏'}`)

      const entryId = input.entryId ?? makeId('entry')
      const parentEntryId = input.parentEntryId === undefined
        ? thread.activeLeafEntryId
        : input.parentEntryId
      await assertEntryBelongsToThread(tx, parentEntryId, input.threadId)
      await assertEntryBelongsToThread(tx, input.logicalParentEntryId ?? null, input.threadId)
      const createdAt = new Date()
      const payloadJson = input.payload ?? {}
      const sequence = thread.nextEntrySequence
      const row = {
        entryId,
        sessionId: thread.sessionId,
        threadId: input.threadId,
        runId: input.runId ?? null,
        turnId: input.turnId ?? null,
        sequence,
        parentEntryId,
        logicalParentEntryId: input.logicalParentEntryId ?? null,
        kind: input.kind,
        payloadJson,
        traceId,
        createdAt,
      }
      await tx.insert(platformConversationEntries).values(row)
      await tx.update(platformThreads).set({
        nextEntrySequence: sequence + 1,
        activeLeafEntryId: entryId,
        transcriptEntryCount: thread.transcriptEntryCount + 1,
        estimatedContextTokens: thread.estimatedContextTokens + estimateTokens(JSON.stringify(payloadJson)),
        updatedAt: createdAt,
      }).where(eq(platformThreads.threadId, input.threadId))
      await tx.insert(platformEventOutbox).values({
        outboxId: makeId('outbox'),
        aggregateType: 'thread',
        aggregateId: input.threadId,
        eventType: 'thread.entry.appended',
        payloadJson: { entryId, runId: input.runId ?? null, kind: input.kind },
        traceId,
      })
      return mapTranscriptEntryRow(row)
    })
    return input.runId ? this.runMutations.run(input.runId, append) : append()
  }

  async readThreadHistory(threadId: string, cursor?: string | null, limit = 100): Promise<ThreadHistoryPage> {
    const before = cursor ? decodeHistoryCursor(cursor) : null
    const pageSize = Math.min(200, Math.max(1, Math.trunc(limit)))
    const condition = before === null
      ? eq(platformConversationEntries.threadId, threadId)
      : and(
          eq(platformConversationEntries.threadId, threadId),
          lt(platformConversationEntries.sequence, before),
        )
    const rows = await this.db.select().from(platformConversationEntries)
      .where(condition)
      .orderBy(desc(platformConversationEntries.sequence))
      .limit(pageSize + 1)
    const hasMore = rows.length > pageSize
    const selected = hasMore ? rows.slice(0, pageSize) : rows
    const oldest = selected.at(-1)
    return {
      entries: selected.map(mapTranscriptEntryRow).reverse(),
      nextCursor: hasMore && oldest ? encodeHistoryCursor(oldest.sequence) : null,
    }
  }

  async readActiveConversation(threadId: string, leafEntryId?: string | null): Promise<TranscriptEntry[]> {
    const rows = await this.db.select({
      activeLeafEntryId: platformThreads.activeLeafEntryId,
      entry: platformConversationEntries,
    }).from(platformThreads)
      .leftJoin(
        platformConversationEntries,
        eq(platformConversationEntries.threadId, platformThreads.threadId),
      )
      .where(eq(platformThreads.threadId, threadId))
      .orderBy(asc(platformConversationEntries.sequence))
    const thread = rows[0]
    if (!thread) throw new Error(`线程 '${threadId}' 不存在`)
    const leafId = leafEntryId ?? thread.activeLeafEntryId
    if (!leafId) return []
    const byId = new Map(rows.flatMap(row => row.entry
      ? [[row.entry.entryId, mapTranscriptEntryRow(row.entry)] as const]
      : []))
    const chain: TranscriptEntry[] = []
    const seen = new Set<string>()
    let current = byId.get(leafId)
    if (!current) throw new Error(`线程 '${threadId}' 的活动叶子 '${leafId}' 不存在`)
    while (current) {
      if (seen.has(current.entryId)) throw new Error(`线程 '${threadId}' 的对话父链存在循环`)
      seen.add(current.entryId)
      chain.push(current)
      current = current.parentEntryId ? byId.get(current.parentEntryId) : undefined
      if (chain.at(-1)?.parentEntryId && !current) {
        throw new Error(`线程 '${threadId}' 的对话父链引用了不存在的父条目`)
      }
    }
    return chain.reverse()
  }

  async forkConversation(
    sourceThreadId: string,
    targetThreadId: string,
    sourceEntryId: string,
    lastNTurns?: number | null,
  ): Promise<Map<string, string>> {
    if (lastNTurns !== undefined && lastNTurns !== null
      && (!Number.isInteger(lastNTurns) || lastNTurns <= 0)) {
      throw new Error('lastNTurns 必须是正整数')
    }
    const completeSource = await this.readActiveConversation(sourceThreadId, sourceEntryId)
    const source = lastNTurns ? lastTurns(completeSource, lastNTurns) : completeSource
    return this.db.transaction(async tx => {
      const targetRows = await tx.select().from(platformThreads)
        .where(eq(platformThreads.threadId, targetThreadId)).for('update').limit(1)
      const target = targetRows[0]
      if (!target) throw new Error(`目标线程 '${targetThreadId}' 不存在`)
      if (target.transcriptEntryCount !== 0) throw new Error(`目标线程 '${targetThreadId}' 已包含对话记录`)

      const idMap = new Map<string, string>()
      const createdRows: Array<typeof platformConversationEntries.$inferInsert> = []
      for (const [index, entry] of source.entries()) {
        const entryId = makeId('entry')
        idMap.set(entry.entryId, entryId)
        createdRows.push({
          entryId,
          sessionId: target.sessionId,
          threadId: targetThreadId,
          runId: null,
          turnId: entry.turnId,
          sequence: target.nextEntrySequence + index,
          parentEntryId: entry.parentEntryId ? idMap.get(entry.parentEntryId) ?? null : null,
          logicalParentEntryId: entry.logicalParentEntryId ? idMap.get(entry.logicalParentEntryId) ?? null : null,
          kind: entry.kind,
          payloadJson: { ...entry.payload, forkedFromEntryId: entry.entryId },
          traceId: stringContextValue('traceId'),
          createdAt: new Date(entry.timestamp),
        })
      }
      if (createdRows.length) await tx.insert(platformConversationEntries).values(createdRows)
      const activeLeafEntryId = createdRows.at(-1)?.entryId ?? null
      await tx.update(platformThreads).set({
        nextEntrySequence: target.nextEntrySequence + createdRows.length,
        activeLeafEntryId,
        transcriptEntryCount: createdRows.length,
        estimatedContextTokens: source.reduce(
          (total, entry) => total + estimateTokens(JSON.stringify(entry.payload)),
          0,
        ),
        forkedFromThreadId: sourceThreadId,
        forkedFromEntryId: sourceEntryId,
        updatedAt: new Date(),
      }).where(eq(platformThreads.threadId, targetThreadId))
      await tx.insert(platformEventOutbox).values({
        outboxId: makeId('outbox'),
        aggregateType: 'thread',
        aggregateId: targetThreadId,
        eventType: 'thread.forked',
        payloadJson: {
          sourceThreadId,
          sourceEntryId,
          entryCount: createdRows.length,
          forkMode: lastNTurns ? 'last_n_turns' : 'full_history',
          forkTurnCount: lastNTurns ?? null,
        },
        traceId: stringContextValue('traceId'),
      })
      return idMap
    })
  }
}

function lastTurns(entries: TranscriptEntry[], count: number): TranscriptEntry[] {
  const turnIds: string[] = []
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const turnId = entries[index]?.turnId
    if (!turnId || turnIds.includes(turnId)) continue
    turnIds.unshift(turnId)
    if (turnIds.length === count) break
  }
  if (!turnIds.length) throw new Error('源对话没有可供 last_n_turns fork 的 turn 身份')
  const selected = new Set(turnIds)
  const first = entries.findIndex(entry => entry.turnId !== null && selected.has(entry.turnId))
  if (first < 0) throw new Error('无法定位 last_n_turns fork 边界')
  return entries.slice(first)
}

function stringContextValue(key: string): string | null {
  const value = currentLogContext()[key]
  return typeof value === 'string' && value.length ? value : null
}

async function assertEntryBelongsToThread(
  tx: DatabaseTransaction,
  entryId: string | null,
  threadId: string,
): Promise<void> {
  if (!entryId) return
  const rows = await tx.select({ threadId: platformConversationEntries.threadId })
    .from(platformConversationEntries)
    .where(eq(platformConversationEntries.entryId, entryId))
    .limit(1)
  const row = rows[0]
  if (!row) throw new Error(`父对话条目 '${entryId}' 不存在`)
  if (row.threadId !== threadId) throw new Error(`父对话条目 '${entryId}' 不属于线程 '${threadId}'`)
}
