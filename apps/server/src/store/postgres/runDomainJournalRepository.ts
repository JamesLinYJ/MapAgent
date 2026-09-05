// +-------------------------------------------------------------------------
//
//   地理智能平台 - PostgreSQL Run 领域日志仓库
//
//   文件:       runDomainJournalRepository.ts
//
//   日期:       2026年08月20日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { and,asc,eq,gt } from 'drizzle-orm'

import type { Database,DatabaseTransaction } from '../../db/connection.js'
import {
platformRunDomainEvents,
platformRunInputs,
platformRuns,
platformRunSnapshots,
} from '../../db/schema.js'
import {
reduceRunDomainEvents,
runDomainEventSchema,
runDomainInputDeliverySchema,
runDomainProjectionInspectionSchema,
runDomainSnapshotSchema,
type RunDomainEvent,
type RunDomainProjectionInspection,
type RunDomainSnapshot,
} from '../../schemas/types.js'
import { RunDomainSequenceConflictError } from '../storeErrors.js'
import {
assertRunDomainCheckpointProjection,
assertRunDomainInputCollection,
assertRunDomainProjection,
inspectRunDomainProjection,
toRunDomainCheckpoint,
} from '../runDomainProjection.js'
import {
runDomainProjectionInspectionsTotal,
runDomainProjectionSequenceDistanceRecords,
} from '../../observability/metrics.js'
import {
mapAnalysisRunRow,
toRunCheckpointUpdateValues,
} from './conversationRowMappers.js'
import type {
AppendRunDomainEventsInput,
RunDomainJournalRepository,
} from './conversationPersistencePorts.js'

/**
 * 领域事件与 reducer snapshot 的唯一写入边界。
 * 调用方若已经持有 platform_runs 行锁，应使用 appendInTransaction；
 * 对外 CAS API 则在这里取得同一行锁，二者不会产生 LWW。
 */
export class PostgresRunDomainJournalRepository implements RunDomainJournalRepository {
  constructor(private readonly db: Database) {}

  appendRunDomainEvents(input: AppendRunDomainEventsInput): Promise<RunDomainSnapshot> {
    return this.db.transaction(async tx => {
      const rows = await tx.select()
        .from(platformRuns)
        .where(eq(platformRuns.runId, input.runId))
        .for('update')
        .limit(1)
      const runRow = rows[0]
      if (!runRow) throw new Error(`运行 '${input.runId}' 不存在`)
      const snapshot = await this.appendInTransaction(tx, input)
      const projectionRows = await tx.update(platformRuns).set({
        status: snapshot.status,
        ...(snapshot.checkpoint ? toRunCheckpointUpdateValues(snapshot.checkpoint) : {}),
        updatedAt: new Date(snapshot.updatedAt),
      }).where(eq(platformRuns.runId, input.runId)).returning()
      const projectionRow = projectionRows[0]
      if (!projectionRow) throw new Error(`运行 '${input.runId}' 查询投影更新失败`)
      assertRunDomainProjection(snapshot, mapAnalysisRunRow(projectionRow, snapshot))
      if (snapshot.checkpoint) {
        assertRunDomainCheckpointProjection(snapshot, toRunDomainCheckpoint(projectionRow))
      }
      const inputRows = await tx.select().from(platformRunInputs)
        .where(eq(platformRunInputs.runId, input.runId))
        .orderBy(asc(platformRunInputs.inputSequence))
      assertRunDomainInputCollection(snapshot, inputRows.map(row => runDomainInputDeliverySchema.parse({
        inputId: row.inputId,
        inputSequence: row.inputSequence,
        status: row.status,
        leaseId: row.status === 'queued' ? null : row.leaseId,
        modelRequestId: row.status === 'included' || row.status === 'checkpointed'
          ? row.modelRequestId
          : null,
      })))
      return snapshot
    })
  }

  async getRunDomainSnapshot(runId: string): Promise<RunDomainSnapshot | null> {
    const rows = await this.db.select().from(platformRunSnapshots)
      .where(eq(platformRunSnapshots.runId, runId))
      .limit(1)
    return rows[0] ? mapSnapshotRow(rows[0]) : null
  }

  async listRunDomainEvents(runId: string, afterSequence = 0): Promise<RunDomainEvent[]> {
    const condition = afterSequence > 0
      ? and(
        eq(platformRunDomainEvents.runId, runId),
        gt(platformRunDomainEvents.sequence, afterSequence),
      )
      : eq(platformRunDomainEvents.runId, runId)
    const rows = await this.db.select().from(platformRunDomainEvents)
      .where(condition)
      .orderBy(asc(platformRunDomainEvents.sequence))
    return rows.map(mapEventRow)
  }

  async listEventsInTransaction(
    tx: DatabaseTransaction,
    runId: string,
  ): Promise<RunDomainEvent[]> {
    const rows = await tx.select().from(platformRunDomainEvents)
      .where(eq(platformRunDomainEvents.runId, runId))
      .orderBy(asc(platformRunDomainEvents.sequence))
    return rows.map(mapEventRow)
  }

  async inspectRunDomainProjection(runId: string): Promise<RunDomainProjectionInspection> {
    const inspection = await this.db.transaction(async tx => {
      const runRows = await tx.select().from(platformRuns)
        .where(eq(platformRuns.runId, runId))
        .limit(1)
      const runRow = runRows[0]
      if (!runRow) throw new Error(`运行 '${runId}' 不存在`)
      // node-postgres 的单一 transaction client 不支持并发 query；顺序读取仍由
      // 同一个 REPEATABLE READ snapshot 保护，且兼容 pg 9 的严格执行模型。
      const snapshotRows = await tx.select().from(platformRunSnapshots)
        .where(eq(platformRunSnapshots.runId, runId))
        .limit(1)
      const eventRows = await tx.select().from(platformRunDomainEvents)
        .where(eq(platformRunDomainEvents.runId, runId))
        .orderBy(asc(platformRunDomainEvents.sequence))
      const inputRows = await tx.select().from(platformRunInputs)
        .where(eq(platformRunInputs.runId, runId))
        .orderBy(asc(platformRunInputs.inputSequence))
      const sourceSequence = eventRows.at(-1)?.sequence ?? 0
      const snapshotRow = snapshotRows[0]
      try {
        const snapshot = snapshotRow ? mapSnapshotRow(snapshotRow) : null
        if (snapshotRow && (
          snapshot!.sequence !== snapshotRow.sequence
          || snapshot!.schemaVersion !== snapshotRow.snapshotSchemaVersion
        )) {
          return failedInspection(runId, sourceSequence, snapshotRow.sequence, 'snapshot', [
            'snapshot 索引列与 state_json 信封不一致',
          ])
        }
        return inspectRunDomainProjection({
          run: snapshot ? mapAnalysisRunRow(runRow, snapshot) : null,
          checkpoint: toRunDomainCheckpoint(runRow),
          inputs: inputRows.map(row => runDomainInputDeliverySchema.parse({
            inputId: row.inputId,
            inputSequence: row.inputSequence,
            status: row.status,
            leaseId: row.status === 'queued' ? null : row.leaseId,
            modelRequestId: row.status === 'included' || row.status === 'checkpointed'
              ? row.modelRequestId
              : null,
          })),
          snapshot,
          events: eventRows.map(mapEventRow),
        })
      } catch (error) {
        return failedInspection(
          runId,
          sourceSequence,
          snapshotRow?.sequence ?? null,
          'schema',
          [errorMessage(error)],
        )
      }
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
    const parsed = runDomainProjectionInspectionSchema.parse(inspection)
    runDomainProjectionSequenceDistanceRecords.observe(parsed.sequenceDistance)
    runDomainProjectionInspectionsTotal.inc({
      outcome: parsed.status,
      reason: parsed.reason,
    })
    return parsed
  }

  async requireSnapshotInTransaction(
    tx: DatabaseTransaction,
    runId: string,
  ): Promise<RunDomainSnapshot> {
    const snapshot = await this.getSnapshotInTransaction(tx, runId)
    if (!snapshot) {
      throw new Error(
        `run '${runId}' 缺少领域日志 snapshot；数据库不是当前权威基线或写入未完成`,
      )
    }
    return snapshot
  }

  async getSnapshotInTransaction(
    tx: DatabaseTransaction,
    runId: string,
  ): Promise<RunDomainSnapshot | null> {
    const rows = await tx.select().from(platformRunSnapshots)
      .where(eq(platformRunSnapshots.runId, runId))
      .for('update')
      .limit(1)
    return rows[0] ? mapSnapshotRow(rows[0]) : null
  }

  async appendInTransaction(
    tx: DatabaseTransaction,
    input: AppendRunDomainEventsInput,
  ): Promise<RunDomainSnapshot> {
    if (!input.events.length) throw new Error('Run 领域日志 append 不能为空')
    if (!Number.isInteger(input.expectedSequence) || input.expectedSequence < 0) {
      throw new Error('Run 领域日志 expectedSequence 必须是非负整数')
    }
    const events = input.events.map(event => runDomainEventSchema.parse(event))
    for (const [index, event] of events.entries()) {
      if (event.runId !== input.runId) {
        throw new Error(`领域事件 '${event.eventId}' 不属于 run '${input.runId}'`)
      }
      const expectedEventSequence = input.expectedSequence + index + 1
      if (event.sequence !== expectedEventSequence) {
        throw new Error(
          `领域事件 '${event.eventId}' sequence 应为 ${expectedEventSequence}，`
          + `实际为 ${event.sequence}`,
        )
      }
    }

    const current = await this.getSnapshotInTransaction(tx, input.runId)
    const currentSequence = current?.sequence ?? 0
    if (currentSequence !== input.expectedSequence) {
      throw new RunDomainSequenceConflictError(
        input.runId,
        input.expectedSequence,
        currentSequence,
      )
    }
    const next = reduceRunDomainEvents(current, events)
    if (!next) throw new Error(`run '${input.runId}' 领域日志没有产生 snapshot`)

    await tx.insert(platformRunDomainEvents).values(events.map(event => ({
      eventId: event.eventId,
      runId: event.runId,
      sequence: event.sequence,
      eventType: event.type,
      schemaVersion: event.schemaVersion,
      objectiveRevision: event.objectiveRevision,
      turnId: event.turnId,
      stepId: event.stepId,
      causationId: event.causationId,
      correlationId: event.correlationId,
      actorKind: event.actor.kind,
      actorId: event.actor.id,
      payloadJson: event.payload,
      occurredAt: new Date(event.occurredAt),
    })))
    await tx.insert(platformRunSnapshots).values({
      runId: next.runId,
      sequence: next.sequence,
      snapshotSchemaVersion: next.schemaVersion,
      stateJson: next,
      updatedAt: new Date(next.updatedAt),
    }).onConflictDoUpdate({
      target: platformRunSnapshots.runId,
      set: {
        sequence: next.sequence,
        snapshotSchemaVersion: next.schemaVersion,
        stateJson: next,
        updatedAt: new Date(next.updatedAt),
      },
    })
    return next
  }
}

function mapEventRow(row: typeof platformRunDomainEvents.$inferSelect): RunDomainEvent {
  return runDomainEventSchema.parse({
    eventId: row.eventId,
    runId: row.runId,
    sequence: row.sequence,
    turnId: row.turnId,
    stepId: row.stepId,
    objectiveRevision: row.objectiveRevision,
    causationId: row.causationId,
    correlationId: row.correlationId,
    actor: { kind: row.actorKind, id: row.actorId },
    occurredAt: row.occurredAt.toISOString(),
    schemaVersion: row.schemaVersion,
    type: row.eventType,
    payload: row.payloadJson,
  })
}

function mapSnapshotRow(row: typeof platformRunSnapshots.$inferSelect): RunDomainSnapshot {
  return runDomainSnapshotSchema.parse(row.stateJson)
}

function failedInspection(
  runId: string,
  sourceSequence: number,
  snapshotSequence: number | null,
  reason: Extract<RunDomainProjectionInspection['reason'], 'snapshot' | 'schema'>,
  details: string[],
): RunDomainProjectionInspection {
  return {
    runId,
    status: 'failed',
    reason,
    sourceSequence,
    snapshotSequence,
    sequenceDistance: Math.abs(sourceSequence - (snapshotSequence ?? 0)),
    details,
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
