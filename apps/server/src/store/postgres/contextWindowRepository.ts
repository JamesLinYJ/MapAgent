// +-------------------------------------------------------------------------
//
//   地理智能平台 - PostgreSQL 持久上下文窗口仓库
//
//   文件:       contextWindowRepository.ts
//
//   日期:       2026年08月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { and, desc, eq, isNull } from 'drizzle-orm'
import {
  CONTEXT_WINDOW_SCHEMA_VERSION,
  contextWindowCompactionSchema,
  contextWindowSchema,
  contextWindowSourceSummarySchema,
  type ContextWindow,
} from '@geo-agent-platform/shared-types/context-window'

import type { Database } from '../../db/connection.js'
import { platformContextWindows, platformRuns } from '../../db/schema.js'
import type {
  ContextWindowStore,
  EnsureContextWindowInput,
  RolloverContextWindowInput,
} from '../../agent-runtime/context/ContextWindowStore.js'
import { agentContextDigest } from '../../agent-runtime/step/agentContextDigest.js'
import { makeId, nowUtc } from '../../utils/ids.js'
import {
  assertRunDomainProjection,
  buildContextCompactedEvent,
  buildContextRolloverEvent,
  buildContextWindowStartedEvent,
} from '../runDomainProjection.js'
import { mapAnalysisRunRow } from './conversationRowMappers.js'
import type { PostgresRunDomainJournalRepository } from './runDomainJournalRepository.js'

/**
 * context window 行与相应领域事件在同一数据库事务中提交。锁定 run 行后，
 * partial unique index 只是最后防线，不承担应用层并发调度职责。
 */
export class PostgresContextWindowRepository implements ContextWindowStore {
  constructor(
    private readonly db: Database,
    private readonly domainJournal: PostgresRunDomainJournalRepository,
  ) {}

  async ensureActive(input: EnsureContextWindowInput): Promise<ContextWindow> {
    const sourceSummary = contextWindowSourceSummarySchema.parse(input.sourceSummary)
    assertSourceDigest(input.sourceDigest, sourceSummary, input.runId)
    return this.db.transaction(async tx => {
      const runRows = await tx.select().from(platformRuns)
        .where(eq(platformRuns.runId, input.runId)).for('update').limit(1)
      const runRow = runRows[0]
      if (!runRow) throw new Error(`运行 '${input.runId}' 不存在`)

      const activeRows = await tx.select().from(platformContextWindows).where(
        eq(platformContextWindows.runId, input.runId),
      ).orderBy(desc(platformContextWindows.generation)).for('update')
      const active = activeRows.find(row => row.closedAt === null)
      if (active) {
        if (active.promptProtocolVersion !== input.promptProtocolVersion) {
          throw new Error(
            `运行 '${input.runId}' 的上下文窗口提示协议已变化，必须显式换窗`,
          )
        }
        return mapContextWindowRow(active)
      }

      const snapshot = await this.domainJournal.requireSnapshotInTransaction(tx, input.runId)
      if (snapshot.contextWindowId !== null || snapshot.contextWindowGeneration !== 0) {
        throw new Error(`运行 '${input.runId}' 的领域快照与活动上下文窗口不一致`)
      }
      const startedAt = nowUtc()
      const created = contextWindowSchema.parse({
        schemaVersion: CONTEXT_WINDOW_SCHEMA_VERSION,
        contextWindowId: makeId('context_window'),
        runId: input.runId,
        generation: 1,
        promptProtocolVersion: input.promptProtocolVersion,
        sourceDigest: input.sourceDigest,
        sourceSummary,
        compaction: null,
        startedAt,
        closedAt: null,
      })
      await tx.insert(platformContextWindows).values(toContextWindowRow(created))

      const run = mapAnalysisRunRow(runRow, snapshot)
      const nextSnapshot = await this.domainJournal.appendInTransaction(tx, {
        runId: input.runId,
        expectedSequence: snapshot.sequence,
        events: [buildContextWindowStartedEvent({
          run,
          expectedSequence: snapshot.sequence,
          contextWindowId: created.contextWindowId,
          generation: created.generation,
          promptProtocolVersion: created.promptProtocolVersion,
          sourceDigest: created.sourceDigest,
        })],
      })
      assertRunDomainProjection(nextSnapshot, run)
      return created
    })
  }

  async getActive(runId: string): Promise<ContextWindow | null> {
    const rows = await this.db.select().from(platformContextWindows).where(and(
      eq(platformContextWindows.runId, runId),
      isNull(platformContextWindows.closedAt),
    )).limit(1)
    return rows[0] ? mapContextWindowRow(rows[0]) : null
  }

  async rollover(input: RolloverContextWindowInput): Promise<ContextWindow> {
    const sourceSummary = contextWindowSourceSummarySchema.parse(input.sourceSummary)
    assertSourceDigest(input.sourceDigest, sourceSummary, input.runId)
    const compaction = contextWindowCompactionSchema.parse(input.compaction)
    return this.db.transaction(async tx => {
      const runRows = await tx.select().from(platformRuns)
        .where(eq(platformRuns.runId, input.runId)).for('update').limit(1)
      const runRow = runRows[0]
      if (!runRow) throw new Error(`运行 '${input.runId}' 不存在`)
      const activeRows = await tx.select().from(platformContextWindows).where(
        eq(platformContextWindows.runId, input.runId),
      ).orderBy(desc(platformContextWindows.generation)).for('update')
      const currentRow = activeRows.find(row => row.closedAt === null)
      if (!currentRow) throw new Error(`运行 '${input.runId}' 没有活动上下文窗口`)
      if (currentRow.contextWindowId !== input.expectedContextWindowId) {
        throw new Error(
          `运行 '${input.runId}' 的活动上下文窗口已经变化，拒绝覆盖新窗口`,
        )
      }

      const snapshot = await this.domainJournal.requireSnapshotInTransaction(tx, input.runId)
      if (
        snapshot.contextWindowId !== currentRow.contextWindowId
        || snapshot.contextWindowGeneration !== currentRow.generation
      ) {
        throw new Error(`运行 '${input.runId}' 的领域快照与活动上下文窗口不一致`)
      }
      const closedAt = nowUtc()
      await tx.update(platformContextWindows).set({
        compactionJson: compaction,
        closedAt: new Date(closedAt),
      }).where(eq(platformContextWindows.contextWindowId, currentRow.contextWindowId))

      const created = contextWindowSchema.parse({
        schemaVersion: CONTEXT_WINDOW_SCHEMA_VERSION,
        contextWindowId: makeId('context_window'),
        runId: input.runId,
        generation: currentRow.generation + 1,
        promptProtocolVersion: input.promptProtocolVersion,
        sourceDigest: input.sourceDigest,
        sourceSummary,
        compaction: null,
        startedAt: closedAt,
        closedAt: null,
      })
      await tx.insert(platformContextWindows).values(toContextWindowRow(created))

      const run = mapAnalysisRunRow(runRow, snapshot)
      const compacted = buildContextCompactedEvent({
        run,
        expectedSequence: snapshot.sequence,
        contextWindowId: currentRow.contextWindowId,
        generation: currentRow.generation,
        sourceDigest: compaction.sourceDigest,
        summaryObjectHashes: compaction.summaryObjectHashes,
        promptVersion: compaction.promptVersion,
      })
      const rollover = buildContextRolloverEvent({
        run,
        expectedSequence: snapshot.sequence + 1,
        previousContextWindowId: currentRow.contextWindowId,
        contextWindowId: created.contextWindowId,
        generation: created.generation,
        reason: input.reason,
      })
      const nextSnapshot = await this.domainJournal.appendInTransaction(tx, {
        runId: input.runId,
        expectedSequence: snapshot.sequence,
        events: [compacted, rollover],
      })
      assertRunDomainProjection(nextSnapshot, run)
      return created
    })
  }
}

function assertSourceDigest(
  sourceDigest: string,
  sourceSummary: ContextWindow['sourceSummary'],
  runId: string,
): void {
  if (agentContextDigest(sourceSummary) !== sourceDigest) {
    throw new Error(`运行 '${runId}' 的上下文窗口来源摘要校验失败`)
  }
}

function mapContextWindowRow(
  row: typeof platformContextWindows.$inferSelect,
): ContextWindow {
  return contextWindowSchema.parse({
    schemaVersion: row.schemaVersion,
    contextWindowId: row.contextWindowId,
    runId: row.runId,
    generation: row.generation,
    promptProtocolVersion: row.promptProtocolVersion,
    sourceDigest: row.sourceDigest,
    sourceSummary: row.sourceSummaryJson,
    compaction: row.compactionJson,
    startedAt: row.startedAt.toISOString(),
    closedAt: row.closedAt?.toISOString() ?? null,
  })
}

function toContextWindowRow(window: ContextWindow): typeof platformContextWindows.$inferInsert {
  return {
    contextWindowId: window.contextWindowId,
    runId: window.runId,
    generation: window.generation,
    schemaVersion: window.schemaVersion,
    promptProtocolVersion: window.promptProtocolVersion,
    sourceDigest: window.sourceDigest,
    sourceSummaryJson: window.sourceSummary,
    compactionJson: window.compaction,
    startedAt: new Date(window.startedAt),
    closedAt: window.closedAt ? new Date(window.closedAt) : null,
  }
}
