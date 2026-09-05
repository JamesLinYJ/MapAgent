// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运行记录流持久化
//
//   文件:       runRecordRepository.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
//   来源:       runRepository.ts 的 Item、Event、Tool Value 与 outbox 边界
// --------------------------------------------------------------------------

import { eq } from 'drizzle-orm'
import {
  RUN_PRESENTATION_PROJECTION_SCHEMA_VERSION,
  replayRunPresentationRecords,
  runPresentationProjectionSchema,
  type RunPresentationProjection,
  type RunPresentationRecord,
} from '@geo-agent-platform/shared-types/run-presentation'

import {
  conversationItemSchema,
  runDomainSnapshotSchema,
  runEventSchema,
  toolValueRefSchema,
  type ConversationItem,
  type RunEvent,
  type ToolValueRef,
} from '../../schemas/types.js'
import { summarizeAssistantText } from '../../conversation/items.js'
import type { Database } from '../../db/connection.js'
import {
  platformEventOutbox,
  platformRunRecords,
  platformRuns,
  platformRunSnapshots,
  platformThreads,
} from '../../db/schema.js'
import { currentLogContext } from '../../observability/logger.js'
import {
  runPresentationProjectionFailuresTotal,
  runPresentationProjectionLagRecords,
} from '../../observability/metrics.js'
import { makeId } from '../../utils/ids.js'
import type { RunMutationQueue } from '../runMutationQueue.js'
import type { RunRecordRepository } from './conversationPersistencePorts.js'
import type { RunRecordAppender } from './runRecordAppender.js'

/** Run Item、Event、Tool Value 与实时 outbox 的原子追加边界。 */
export class PostgresRunRecordRepository implements RunRecordRepository {
  constructor(
    private readonly db: Database,
    private readonly runMutations: RunMutationQueue,
    private readonly runRecords: RunRecordAppender,
  ) {}

  async appendConversationItem(item: ConversationItem): Promise<void> {
    const parsed = conversationItemSchema.parse(item)
    const traceId = stringContextValue('traceId')
    await this.runMutations.run(parsed.runId, () => this.db.transaction(async tx => {
      const runRows = await tx.select({
        threadId: platformRuns.threadId,
      })
        .from(platformRuns)
        .where(eq(platformRuns.runId, parsed.runId))
        .for('update')
        .limit(1)
      const run = runRows[0]
      if (!run) throw new Error(`运行 '${parsed.runId}' 不存在`)

      // 只锁定必然存在的 run 身份行。PostgreSQL 禁止对 LEFT JOIN 的可空侧执行
      // FOR UPDATE；取得身份行锁后再在同一事务中读取权威 snapshot，既保留串行
      // 语义，也不把查询投影或已删除的 state_json 重新变成事实源。
      const snapshotRows = await tx.select({ snapshotJson: platformRunSnapshots.stateJson })
        .from(platformRunSnapshots)
        .where(eq(platformRunSnapshots.runId, parsed.runId))
        .limit(1)
      const snapshotRow = snapshotRows[0]
      if (!snapshotRow) throw new Error(`运行 '${parsed.runId}' 缺少权威 snapshot`)
      const authoritativeStatus = runDomainSnapshotSchema.parse(snapshotRow.snapshotJson).status
      if (run.threadId !== parsed.threadId) {
        throw new Error(`运行记录的 threadId 与运行 '${parsed.runId}' 不一致`)
      }
      await this.runRecords.append(tx, parsed.runId, run.threadId, [{ recordType: 'item', payloadJson: parsed }], traceId)

      if (run.threadId && parsed.itemType === 'message' && parsed.role === 'assistant') {
        const summary = summarizeAssistantText(parsed.body ?? '')
        if (summary) {
          await tx.update(platformThreads).set({ latestAssistantSummary: summary, updatedAt: new Date() })
            .where(eq(platformThreads.threadId, run.threadId))
        }
      } else if (run.threadId && parsed.itemType === 'result') {
        await tx.update(platformThreads).set({ latestRunStatus: authoritativeStatus, updatedAt: new Date() })
          .where(eq(platformThreads.threadId, run.threadId))
      }
      await tx.insert(platformEventOutbox).values({
        outboxId: makeId('outbox'),
        aggregateType: 'run',
        aggregateId: parsed.runId,
        eventType: 'run.item',
        payloadJson: parsed,
        traceId,
      })
    }))
  }

  async listConversationItems(runId: string): Promise<ConversationItem[]> {
    return (await this.loadRunPresentation(runId)).items
  }

  async appendRunEvent(event: RunEvent): Promise<void> {
    const parsed = runEventSchema.parse(event)
    await this.appendTypedRunRecord(parsed.runId, parsed.threadId, 'event', parsed, 'run.event')
  }

  async listRunEvents(runId: string): Promise<RunEvent[]> {
    return (await this.loadRunPresentation(runId)).events
  }

  async appendToolValue(runId: string, value: ToolValueRef): Promise<void> {
    const parsed = toolValueRefSchema.parse(value)
    await this.appendTypedRunRecord(runId, null, 'value', parsed, 'run.value')
  }

  async listToolValues(runId: string): Promise<ToolValueRef[]> {
    return (await this.loadRunPresentation(runId)).values
  }

  async loadRunPresentation(runId: string): Promise<RunPresentationProjection> {
    const rows = await this.db.select({
      nextRecordSequence: platformRuns.nextRecordSequence,
      recordId: platformRunRecords.recordId,
      recordRunId: platformRunRecords.runId,
      recordThreadId: platformRunRecords.threadId,
      recordSequence: platformRunRecords.sequence,
      recordType: platformRunRecords.recordType,
      payloadJson: platformRunRecords.payloadJson,
      recordCreatedAt: platformRunRecords.createdAt,
    }).from(platformRuns)
      .leftJoin(platformRunRecords, eq(platformRunRecords.runId, platformRuns.runId))
      .where(eq(platformRuns.runId, runId))
      .orderBy(platformRunRecords.sequence)
    const runRow = rows[0]
    if (!runRow) throw new Error(`运行 '${runId}' 不存在`)
    const sourceSequence = runRow.nextRecordSequence - 1
    const records = rows.flatMap<RunPresentationRecord>(row => row.recordId === null
      ? []
      : [{
          recordId: row.recordId,
          runId: row.recordRunId!,
          threadId: row.recordThreadId,
          sequence: row.recordSequence!,
          recordType: row.recordType!,
          payload: row.payloadJson,
          createdAt: row.recordCreatedAt!.toISOString(),
        }])
    const appliedSequence = records.at(-1)?.sequence ?? 0
    runPresentationProjectionLagRecords.observe(Math.max(0, sourceSequence - appliedSequence))
    try {
      const replayed = replayRunPresentationRecords(records)
      if ((replayed?.sourceSequence ?? 0) !== sourceSequence) {
        throw new Error(
          `Run '${runId}' 展示投影游标落后：事实 ${sourceSequence}，已应用 ${replayed?.sourceSequence ?? 0}`,
        )
      }
      return replayed ?? runPresentationProjectionSchema.parse({
        schemaVersion: RUN_PRESENTATION_PROJECTION_SCHEMA_VERSION,
        runId,
        sourceSequence: 0,
        items: [],
        events: [],
        values: [],
      })
    } catch (error) {
      runPresentationProjectionFailuresTotal.inc({ reason: projectionFailureReason(error) })
      throw error
    }
  }

  private async appendTypedRunRecord(
    runId: string,
    threadId: string | null,
    recordType: string,
    payloadJson: Record<string, unknown>,
    outboxEventType: string,
  ): Promise<void> {
    const traceId = stringContextValue('traceId')
    await this.runMutations.run(runId, () => this.db.transaction(async tx => {
      const runRows = await tx.select({ threadId: platformRuns.threadId })
        .from(platformRuns)
        .where(eq(platformRuns.runId, runId))
        .for('update')
        .limit(1)
      const run = runRows[0]
      if (!run) throw new Error(`运行 '${runId}' 不存在`)
      if (recordType !== 'value' && run.threadId !== threadId) {
        throw new Error(`运行记录的 threadId 与运行 '${runId}' 不一致`)
      }
      await this.runRecords.append(tx, runId, run.threadId ?? threadId, [{ recordType, payloadJson }], traceId)
      await tx.insert(platformEventOutbox).values({
        outboxId: makeId('outbox'),
        aggregateType: 'run',
        aggregateId: runId,
        eventType: outboxEventType,
        payloadJson,
        traceId,
      })
    }))
  }
}

function projectionFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('sequence') || message.includes('游标落后')) return 'sequence'
  if (message.includes('稳定 ID')) return 'identity'
  if (message.includes('未知展示记录类型')) return 'record_type'
  return 'schema'
}

function stringContextValue(key: string): string | null {
  const value = currentLogContext()[key]
  return typeof value === 'string' && value.length ? value : null
}
