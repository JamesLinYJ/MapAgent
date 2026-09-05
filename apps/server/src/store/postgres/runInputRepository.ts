// +-------------------------------------------------------------------------
//
//   地理智能平台 - PostgreSQL 运行输入仓库
//
//   文件:       runInputRepository.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { and, asc, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm'
import type { Database, DatabaseTransaction } from '../../db/connection.js'
import {
  platformConversationEntries,
  platformRunInputs,
  platformRuns,
  platformThreads,
} from '../../db/schema.js'
import {
  runSteeringRecordSchema,
  type RunDomainEvent,
  type RunDomainSnapshot,
  type RunSteeringRecord,
} from '../../schemas/types.js'
import { currentLogContext } from '../../observability/logger.js'
import { estimateTokens } from '../conversationEncoding.js'
import type { RunMutationQueue } from '../runMutationQueue.js'
import {
  assertRunDomainCheckpointProjection,
  assertRunDomainInputProjection,
  assertRunDomainProjection,
  buildCheckpointChangedEvent,
  buildInputTransitionEvent,
  buildTerminalCandidateSupersededEvent,
  buildTerminalClaimedEvent,
  toRunDomainCheckpoint,
} from '../runDomainProjection.js'
import type { EnqueueRunInput, RunInputRepository } from './conversationPersistencePorts.js'
import type { RunInputDeliveryRecorder } from './runInputDeliveryRecorder.js'
import {
  mapAnalysisRunRow,
  toRunCheckpointUpdateValues,
} from './conversationRowMappers.js'
import type { PostgresRunDomainJournalRepository } from './runDomainJournalRepository.js'

/** 运行中用户引导消息的幂等入队、lease 和恢复事实源。 */
export class PostgresRunInputRepository implements RunInputRepository {
  constructor(
    private readonly db: Database,
    private readonly mutations: RunMutationQueue,
    private readonly inputDelivery: RunInputDeliveryRecorder,
    private readonly domainJournal: PostgresRunDomainJournalRepository,
  ) {}

  async enqueueRunInput(input: EnqueueRunInput): Promise<RunSteeringRecord> {
    const normalized = input.content.trim()
    if (!normalized) throw new Error('引导消息不能为空')
    const traceId = stringContextValue('traceId')
    return this.mutations.run(input.runId, () => this.db.transaction(async tx => {
      const existingRows = await tx.select().from(platformRunInputs)
        .where(eq(platformRunInputs.inputId, input.inputId)).limit(1)
      const existing = existingRows[0]
      if (existing) {
        if (existing.runId !== input.runId || existing.content !== normalized) {
          throw new Error(`引导消息 '${input.inputId}' 的幂等键已被其它内容使用`)
        }
        return mapRunSteeringRow(existing)
      }

      const runRows = await tx.select().from(platformRuns)
        .where(eq(platformRuns.runId, input.runId)).for('update').limit(1)
      const run = runRows[0]
      if (!run) throw new Error(`运行 '${input.runId}' 不存在`)
      const currentSnapshot = await this.domainJournal.requireSnapshotInTransaction(tx, input.runId)
      const checkpoint = requireCheckpoint(currentSnapshot)
      if (currentSnapshot.status !== 'running') throw new Error(`运行 '${input.runId}' 已结束接收引导消息`)
      if (checkpoint.terminalInputClaimId) throw new Error(`运行 '${input.runId}' 已提交终态游标，不再接收引导消息`)
      if (!run.threadId) throw new Error(`运行 '${input.runId}' 缺少 threadId`)
      const inputSequence = checkpoint.nextInputSequence

      const sequenceRows = await tx.update(platformThreads)
        .set({
          nextEntrySequence: sql`${platformThreads.nextEntrySequence} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(platformThreads.threadId, run.threadId))
        .returning({
          sessionId: platformThreads.sessionId,
          nextEntrySequence: platformThreads.nextEntrySequence,
          transcriptEntryCount: platformThreads.transcriptEntryCount,
          estimatedContextTokens: platformThreads.estimatedContextTokens,
        })
      const sequenceState = sequenceRows[0]
      if (!sequenceState) throw new Error(`运行 '${input.runId}' 所属线程不存在`)

      const parentRows = await tx.select({ entryId: platformConversationEntries.entryId })
        .from(platformConversationEntries)
        .where(eq(platformConversationEntries.threadId, run.threadId))
        .orderBy(desc(platformConversationEntries.sequence))
        .limit(1)
      const queuedAt = new Date()
      const payload = { role: 'user', content: normalized, steeringId: input.inputId }
      await tx.insert(platformConversationEntries).values({
        entryId: input.entryId,
        sessionId: sequenceState.sessionId,
        threadId: run.threadId,
        runId: run.runId,
        turnId: input.turnId,
        sequence: sequenceState.nextEntrySequence - 1,
        parentEntryId: parentRows[0]?.entryId ?? null,
        logicalParentEntryId: null,
        kind: 'message',
        payloadJson: payload,
        traceId,
        createdAt: queuedAt,
      })
      await tx.update(platformThreads).set({
        activeLeafEntryId: input.entryId,
        transcriptEntryCount: sequenceState.transcriptEntryCount + 1,
        estimatedContextTokens: sequenceState.estimatedContextTokens + estimateTokens(JSON.stringify(payload)),
      }).where(eq(platformThreads.threadId, run.threadId))
      await tx.insert(platformRunInputs).values({
        inputId: input.inputId,
        runId: run.runId,
        threadId: run.threadId,
        turnId: input.turnId,
        entryId: input.entryId,
        itemId: input.itemId,
        kind: 'steering',
        content: normalized,
        inputSequence,
        status: 'queued',
        queuedAt,
      })
      const sequenceClaim = await tx.update(platformRuns).set({
        ...toRunCheckpointUpdateValues({
          ...checkpoint,
          nextInputSequence: inputSequence + 1,
        }),
        updatedAt: queuedAt,
      }).where(and(
        eq(platformRuns.runId, run.runId),
        eq(platformRuns.nextInputSequence, inputSequence),
      )).returning()
      const afterRow = sequenceClaim[0]
      if (!afterRow) throw new Error(`运行 '${run.runId}' 的 input sequence CAS 失败`)
      const record = runSteeringRecordSchema.parse({
        schemaVersion: 4,
        steeringId: input.inputId,
        entryId: input.entryId,
        itemId: input.itemId,
        runId: run.runId,
        threadId: run.threadId,
        turnId: input.turnId,
        content: normalized,
        inputSequence,
        status: 'queued',
        queuedAt: queuedAt.toISOString(),
        leaseId: null,
        leasedAt: null,
        modelRequestId: null,
        includedAt: null,
        checkpointedAt: null,
      })
      await this.inputDelivery.recordTransition(tx, 'queued', run.runId, run.threadId, [record])
      await this.appendInputProjection(
        tx,
        currentSnapshot,
        afterRow,
        'input.queued',
        [record],
      )
      return record
    }))
  }

  async leaseRunInputs(runId: string, leaseId: string): Promise<RunSteeringRecord[]> {
    if (!leaseId.trim()) throw new Error('run input leaseId 不能为空')
    return this.mutations.run(runId, () => this.db.transaction(async tx => {
      const runRows = await tx.select().from(platformRuns)
        .where(eq(platformRuns.runId, runId)).for('update').limit(1)
      const run = runRows[0]
      if (!run) throw new Error(`运行 '${runId}' 不存在`)
      const currentSnapshot = await this.domainJournal.requireSnapshotInTransaction(tx, runId)
      const checkpoint = requireCheckpoint(currentSnapshot)
      if (checkpoint.activeInputLeaseId) {
        if (checkpoint.activeInputLeaseId !== leaseId) {
          throw new Error(`运行 '${runId}' 已有活动输入 lease '${checkpoint.activeInputLeaseId}'`)
        }
        if (checkpoint.activeInputLeaseFrom === null || checkpoint.activeInputLeaseTo === null) {
          throw new Error(`运行 '${runId}' 的活动输入 lease 范围不完整`)
        }
        const existingLease = await tx.select().from(platformRunInputs)
          .where(and(
            eq(platformRunInputs.runId, runId),
            inArray(platformRunInputs.status, ['leased', 'included']),
            eq(platformRunInputs.leaseId, leaseId),
          ))
          .orderBy(asc(platformRunInputs.inputSequence))
          .for('update')
        assertContiguousInputPrefix(
          existingLease,
          checkpoint.activeInputLeaseFrom,
          checkpoint.activeInputLeaseTo - checkpoint.activeInputLeaseFrom + 1,
          runId,
        )
        const statuses = new Set(existingLease.map(row => row.status))
        if (statuses.size !== 1) throw new Error(`运行 '${runId}' 的活动输入 lease 状态不一致`)
        const records = existingLease.map(mapRunSteeringRow)
        this.assertUnchangedProjection(currentSnapshot, run, records)
        return records
      }

      const rows = await tx.select().from(platformRunInputs)
        .where(and(
          eq(platformRunInputs.runId, runId),
          gt(platformRunInputs.inputSequence, checkpoint.checkpointInputCursor),
          eq(platformRunInputs.status, 'queued'),
        ))
        .orderBy(asc(platformRunInputs.inputSequence))
        .for('update')
      const expectedCount = checkpoint.nextInputSequence - checkpoint.checkpointInputCursor - 1
      if (!rows.length) {
        if (expectedCount !== 0) {
          throw new Error(`运行 '${runId}' 的 input cursor 与 queued 连续前缀不一致`)
        }
        this.assertUnchangedProjection(currentSnapshot, run, [])
        return []
      }
      assertContiguousInputPrefix(rows, checkpoint.checkpointInputCursor + 1, expectedCount, runId)

      const leasedAt = new Date()
      const leaseFrom = rows[0]!.inputSequence
      const leaseTo = rows.at(-1)!.inputSequence
      const claimed = await tx.update(platformRuns)
        .set({
          ...toRunCheckpointUpdateValues({
            ...checkpoint,
            activeInputLeaseId: leaseId,
            activeInputLeaseFrom: leaseFrom,
            activeInputLeaseTo: leaseTo,
          }),
          updatedAt: leasedAt,
        })
        .where(and(
          eq(platformRuns.runId, runId),
          eq(platformRuns.checkpointInputCursor, checkpoint.checkpointInputCursor),
          isNull(platformRuns.activeInputLeaseId),
        ))
        .returning()
      const afterRow = claimed[0]
      if (!afterRow) throw new Error(`运行 '${runId}' 的输入 lease CAS 失败`)
      const leasedRows = await tx.update(platformRunInputs)
        .set({
          status: 'leased',
          leaseId,
          leasedAt,
          modelRequestId: null,
          includedAt: null,
          checkpointedAt: null,
        })
        .where(and(
          eq(platformRunInputs.runId, runId),
          eq(platformRunInputs.status, 'queued'),
          gt(platformRunInputs.inputSequence, checkpoint.checkpointInputCursor),
        ))
        .returning()
      leasedRows.sort((left, right) => left.inputSequence - right.inputSequence)
      assertContiguousInputPrefix(leasedRows, leaseFrom, expectedCount, runId)
      const records = leasedRows.map(mapRunSteeringRow)
      await this.inputDelivery.recordTransition(
        tx,
        'leased',
        runId,
        run.threadId ?? rows[0]!.threadId,
        records,
      )
      await this.appendInputProjection(
        tx,
        currentSnapshot,
        afterRow,
        'input.leased',
        records,
      )
      return records
    }))
  }

  async getRunInput(runId: string, inputId: string): Promise<RunSteeringRecord | null> {
    const rows = await this.db.select().from(platformRunInputs)
      .where(and(
        eq(platformRunInputs.runId, runId),
        eq(platformRunInputs.inputId, inputId),
      ))
      .limit(1)
    return rows[0] ? mapRunSteeringRow(rows[0]) : null
  }

  async requeueLeasedRunInputs(runId: string): Promise<RunSteeringRecord[]> {
    return this.mutations.run(runId, () => this.db.transaction(async tx => {
      const runRows = await tx.select().from(platformRuns)
        .where(eq(platformRuns.runId, runId)).for('update').limit(1)
      const run = runRows[0]
      if (!run) throw new Error(`运行 '${runId}' 不存在`)
      const currentSnapshot = await this.domainJournal.requireSnapshotInTransaction(tx, runId)
      const checkpoint = requireCheckpoint(currentSnapshot)
      const activeLeaseId = checkpoint.activeInputLeaseId
      if (!activeLeaseId) {
        this.assertUnchangedProjection(currentSnapshot, run, [])
        return []
      }
      if (checkpoint.activeInputLeaseFrom !== checkpoint.checkpointInputCursor + 1 || checkpoint.activeInputLeaseTo === null) {
        throw new Error(`运行 '${runId}' 的活动输入 lease 范围不合法`)
      }

      const rows = await tx.select().from(platformRunInputs)
        .where(and(
          eq(platformRunInputs.runId, runId),
          inArray(platformRunInputs.status, ['leased', 'included']),
          eq(platformRunInputs.leaseId, activeLeaseId),
        ))
        .orderBy(asc(platformRunInputs.inputSequence))
        .for('update')
      if (!rows.length) throw new Error(`运行 '${runId}' 的活动输入 lease '${activeLeaseId}' 没有对应记录`)
      const expectedCount = checkpoint.activeInputLeaseTo - checkpoint.activeInputLeaseFrom + 1
      assertContiguousInputPrefix(rows, checkpoint.activeInputLeaseFrom, expectedCount, runId)
      if (rows.some(row => row.status === 'included')) {
        if (rows.some(row => row.status !== 'included')) {
          throw new Error(`运行 '${runId}' 的活动输入 lease 同时包含 leased 与 included 记录`)
        }
        this.assertUnchangedProjection(currentSnapshot, run, rows.map(mapRunSteeringRow))
        return []
      }
      const requeuedRows = await tx.update(platformRunInputs)
        .set({
          status: 'queued',
          leaseId: null,
          leasedAt: null,
          modelRequestId: null,
          includedAt: null,
          checkpointedAt: null,
        })
        .where(and(
          eq(platformRunInputs.runId, runId),
          eq(platformRunInputs.status, 'leased'),
          eq(platformRunInputs.leaseId, activeLeaseId),
        ))
        .returning()
      requeuedRows.sort((left, right) => left.inputSequence - right.inputSequence)
      assertContiguousInputPrefix(requeuedRows, checkpoint.activeInputLeaseFrom, expectedCount, runId)
      const released = await tx.update(platformRuns)
        .set({
          ...toRunCheckpointUpdateValues({
            ...checkpoint,
            activeInputLeaseId: null,
            activeInputLeaseFrom: null,
            activeInputLeaseTo: null,
          }),
          updatedAt: new Date(),
        })
        .where(and(
          eq(platformRuns.runId, runId),
          eq(platformRuns.activeInputLeaseId, activeLeaseId),
        ))
        .returning()
      const afterRow = released[0]
      if (!afterRow) throw new Error(`运行 '${runId}' 的输入 lease 恢复 CAS 失败`)
      const records = requeuedRows.map(mapRunSteeringRow)
      await this.inputDelivery.recordTransition(
        tx,
        'requeued',
        runId,
        run.threadId ?? rows[0]!.threadId,
        records,
      )
      await this.appendInputProjection(
        tx,
        currentSnapshot,
        afterRow,
        'input.requeued',
        records,
      )
      return records
    }))
  }

  async listRunInputs(runId: string): Promise<RunSteeringRecord[]> {
    const rows = await this.db.select().from(platformRunInputs)
      .where(eq(platformRunInputs.runId, runId))
      .orderBy(asc(platformRunInputs.inputSequence))
    return rows.map(mapRunSteeringRow)
  }

  async tryClaimTerminalInput(input: {
    runId: string
    claimId: string
    objectiveRevision: number
    inputCursor: number
  }): Promise<boolean> {
    if (!input.claimId.trim()) throw new Error('terminal claimId 不能为空')
    return this.mutations.run(input.runId, () => this.db.transaction(async tx => {
      const runRows = await tx.select().from(platformRuns)
        .where(eq(platformRuns.runId, input.runId)).for('update').limit(1)
      const run = runRows[0]
      if (!run) throw new Error(`运行 '${input.runId}' 不存在`)
      const currentSnapshot = await this.domainJournal.requireSnapshotInTransaction(tx, input.runId)
      const checkpoint = requireCheckpoint(currentSnapshot)
      if (checkpoint.terminalInputClaimId) {
        if (
          checkpoint.terminalInputClaimId === input.claimId
          && checkpoint.terminalObjectiveRevision === input.objectiveRevision
          && checkpoint.terminalInputCursor === input.inputCursor
        ) {
          this.assertUnchangedProjection(currentSnapshot, run, [])
          return true
        }
        return false
      }

      const durableRevision = checkpoint.nextInputSequence
      const durableCursor = checkpoint.checkpointInputCursor
      if (
        currentSnapshot.status !== 'running'
        || checkpoint.activeInputLeaseId !== null
        || durableRevision !== input.objectiveRevision
        || durableCursor !== input.inputCursor
      ) {
        const projectedRun = mapAnalysisRunRow(run, currentSnapshot)
        const event = buildTerminalCandidateSupersededEvent({
          run: projectedRun,
          expectedSequence: currentSnapshot.sequence,
          objectiveRevision: input.objectiveRevision,
          inputCursor: input.inputCursor,
          durableObjectiveRevision: durableRevision,
          durableInputCursor: durableCursor,
        })
        await this.domainJournal.appendInTransaction(tx, {
          runId: input.runId,
          expectedSequence: currentSnapshot.sequence,
          events: [event],
        })
        return false
      }

      const claimedAt = new Date()
      const claimedRows = await tx.update(platformRuns).set({
        ...toRunCheckpointUpdateValues({
          ...checkpoint,
          terminalInputClaimId: input.claimId,
          terminalObjectiveRevision: input.objectiveRevision,
          terminalInputCursor: input.inputCursor,
          terminalClaimedAt: claimedAt.toISOString(),
        }),
        updatedAt: claimedAt,
      }).where(and(
        eq(platformRuns.runId, input.runId),
        isNull(platformRuns.terminalInputClaimId),
        isNull(platformRuns.activeInputLeaseId),
        eq(platformRuns.nextInputSequence, input.objectiveRevision),
        eq(platformRuns.checkpointInputCursor, input.inputCursor),
      )).returning()
      const afterRow = claimedRows[0]
      if (!afterRow) return false
      const projectedRun = mapAnalysisRunRow(afterRow, currentSnapshot)
      const nextCheckpoint = toRunDomainCheckpoint(afterRow)
      const events: RunDomainEvent[] = [
        buildTerminalClaimedEvent({
          run: projectedRun,
          expectedSequence: currentSnapshot.sequence,
          claimId: input.claimId,
          objectiveRevision: input.objectiveRevision,
          inputCursor: input.inputCursor,
        }),
        buildCheckpointChangedEvent({
          run: projectedRun,
          expectedSequence: currentSnapshot.sequence + 1,
          checkpoint: nextCheckpoint,
        }),
      ]
      const snapshot = await this.domainJournal.appendInTransaction(tx, {
        runId: input.runId,
        expectedSequence: currentSnapshot.sequence,
        events,
      })
      assertRunDomainProjection(snapshot, projectedRun)
      assertRunDomainCheckpointProjection(snapshot, nextCheckpoint)
      return true
    }))
  }

  private async appendInputProjection(
    tx: DatabaseTransaction,
    currentSnapshot: RunDomainSnapshot,
    afterRow: typeof platformRuns.$inferSelect,
    type: 'input.queued' | 'input.leased' | 'input.requeued',
    records: readonly RunSteeringRecord[],
  ): Promise<void> {
    const run = mapAnalysisRunRow(afterRow, currentSnapshot)
    const checkpoint = toRunDomainCheckpoint(afterRow)
    const events: RunDomainEvent[] = [
      buildInputTransitionEvent({
        run,
        expectedSequence: currentSnapshot.sequence,
        type,
        records,
      }),
      buildCheckpointChangedEvent({
        run,
        expectedSequence: currentSnapshot.sequence + 1,
        checkpoint,
      }),
    ]
    const snapshot = await this.domainJournal.appendInTransaction(tx, {
      runId: run.id,
      expectedSequence: currentSnapshot.sequence,
      events,
    })
    assertRunDomainProjection(snapshot, run)
    assertRunDomainCheckpointProjection(snapshot, checkpoint)
    assertRunDomainInputProjection(snapshot, records)
  }

  private assertUnchangedProjection(
    snapshot: RunDomainSnapshot,
    runRow: typeof platformRuns.$inferSelect,
    records: readonly RunSteeringRecord[],
  ): void {
    assertRunDomainProjection(snapshot, mapAnalysisRunRow(runRow, snapshot))
    assertRunDomainCheckpointProjection(snapshot, toRunDomainCheckpoint(runRow))
    if (records.length) assertRunDomainInputProjection(snapshot, records)
  }
}

function requireCheckpoint(snapshot: RunDomainSnapshot): NonNullable<RunDomainSnapshot['checkpoint']> {
  if (!snapshot.checkpoint) throw new Error(`运行 '${snapshot.runId}' 的权威 snapshot 缺少 checkpoint`)
  return snapshot.checkpoint
}

export function mapRunSteeringRow(row: {
  inputId: string
  entryId: string
  itemId: string
  runId: string
  threadId: string
  turnId: string
  content: string
  inputSequence: number
  status: string
  queuedAt: Date
  leaseId: string | null
  leasedAt: Date | null
  modelRequestId: string | null
  includedAt: Date | null
  checkpointedAt: Date | null
}): RunSteeringRecord {
  return runSteeringRecordSchema.parse({
    schemaVersion: 4,
    steeringId: row.inputId,
    entryId: row.entryId,
    itemId: row.itemId,
    runId: row.runId,
    threadId: row.threadId,
    turnId: row.turnId,
    content: row.content,
    inputSequence: row.inputSequence,
    status: row.status,
    queuedAt: row.queuedAt.toISOString(),
    leaseId: row.leaseId,
    leasedAt: row.leasedAt?.toISOString() ?? null,
    modelRequestId: row.modelRequestId,
    includedAt: row.includedAt?.toISOString() ?? null,
    checkpointedAt: row.checkpointedAt?.toISOString() ?? null,
  })
}

function assertContiguousInputPrefix(
  rows: readonly { inputSequence: number }[],
  firstSequence: number,
  expectedCount: number,
  runId: string,
): void {
  if (rows.length !== expectedCount) {
    throw new Error(`运行 '${runId}' 的 input sequence 存在空洞`)
  }
  rows.forEach((row, index) => {
    if (row.inputSequence !== firstSequence + index) {
      throw new Error(`运行 '${runId}' 的 input sequence 存在空洞`)
    }
  })
}

function stringContextValue(key: string): string | null {
  const value = currentLogContext()[key]
  return typeof value === 'string' && value.length ? value : null
}
