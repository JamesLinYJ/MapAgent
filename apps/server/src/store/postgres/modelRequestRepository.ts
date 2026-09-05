// +-------------------------------------------------------------------------
//
//   地理智能平台 - PostgreSQL 精确模型请求日志
//
//   文件:       modelRequestRepository.ts
//   日期:       2026年08月23日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
//
//   ModelRequest 内容对象、StepContext 与 input.included 在同一 run 事务边界
//   绑定；恢复只能重放已经提交的不可变请求记录。
// --------------------------------------------------------------------------

import { isDeepStrictEqual } from 'node:util'

import { and, asc, eq, inArray, or } from 'drizzle-orm'
import { agentStepContextSchema } from '@geo-agent-platform/shared-types/agent-step-context'
import {
  modelRequestRecordSchema,
  type ModelRequestRecord,
} from '@geo-agent-platform/shared-types/model-request'

import type { Database } from '../../db/connection.js'
import {
  platformAgentStepContexts,
  platformModelRequestRecords,
  platformRunInputs,
  platformRuns,
} from '../../db/schema.js'
import type { RunDomainEvent } from '../../schemas/types.js'
import type { RunMutationQueue } from '../runMutationQueue.js'
import {
assertRunDomainCheckpointProjection,
assertRunDomainInputProjection,
assertRunDomainProjection,
buildInputTransitionEvent,
buildModelRequestCommittedEvent,
toRunDomainCheckpoint,
} from '../runDomainProjection.js'
import { mapAnalysisRunRow } from './conversationRowMappers.js'
import type {
  CommitModelRequestInput,
  CommitModelRequestResult,
  ModelRequestRepository,
} from './conversationPersistencePorts.js'
import type { RunInputDeliveryRecorder } from './runInputDeliveryRecorder.js'
import { mapRunSteeringRow } from './runInputRepository.js'
import type { PostgresRunDomainJournalRepository } from './runDomainJournalRepository.js'

export class PostgresModelRequestRepository implements ModelRequestRepository {
  constructor(
    private readonly db: Database,
    private readonly mutations: RunMutationQueue,
    private readonly inputDelivery: RunInputDeliveryRecorder,
    private readonly domainJournal: PostgresRunDomainJournalRepository,
  ) {}

  async commitModelRequest(input: CommitModelRequestInput): Promise<CommitModelRequestResult> {
    const parsed = modelRequestRecordSchema.omit({ inputEntryIds: true }).parse(input)
    return this.mutations.run(parsed.runId, () => this.db.transaction(async tx => {
      const runRows = await tx.select().from(platformRuns)
        .where(eq(platformRuns.runId, parsed.runId)).for('update').limit(1)
      const runRow = runRows[0]
      if (!runRow) throw new Error(`运行 '${parsed.runId}' 不存在`)
      const currentSnapshot = await this.domainJournal.requireSnapshotInTransaction(tx, parsed.runId)
      const checkpoint = currentSnapshot.checkpoint
      if (!checkpoint) throw new Error(`运行 '${parsed.runId}' 的权威 snapshot 缺少 checkpoint`)
      if (currentSnapshot.status !== 'running') throw new Error(`运行 '${parsed.runId}' 已结束，不能提交模型请求`)
      if (checkpoint.terminalInputClaimId) throw new Error(`运行 '${parsed.runId}' 已提交终态游标`)

      const contextRows = await tx.select().from(platformAgentStepContexts)
        .where(eq(platformAgentStepContexts.stepId, parsed.stepId)).limit(1)
      const contextRow = contextRows[0]
      if (!contextRow) throw new Error(`模型请求 '${parsed.requestId}' 缺少 StepContext '${parsed.stepId}'`)
      const context = agentStepContextSchema.parse(contextRow.contextJson)
      if (
        context.runId !== parsed.runId
        || context.turnId !== parsed.turnId
        || context.identity.segmentId !== parsed.segmentId
        || context.model.provider !== parsed.provider
        || context.model.modelId !== parsed.modelId
        || context.toolPlanDigest !== parsed.toolPlanDigest
        || context.worldRevision !== parsed.worldRevision
        || context.objectiveRevision !== parsed.objectiveRevision
        || context.inputCursor !== parsed.inputCursor
        || context.contextWindowId !== parsed.contextWindowId
        || context.contextDigest !== parsed.contextDigest
        || context.schemaVersion !== parsed.agentStepContextSchemaVersion
      ) {
        throw new Error(`模型请求 '${parsed.requestId}' 与 StepContext '${parsed.stepId}' 不一致`)
      }

      const activeRows = checkpoint.activeInputLeaseId
        ? await tx.select().from(platformRunInputs).where(and(
          eq(platformRunInputs.runId, parsed.runId),
          eq(platformRunInputs.leaseId, checkpoint.activeInputLeaseId),
          inArray(platformRunInputs.status, ['leased', 'included']),
        )).orderBy(asc(platformRunInputs.inputSequence)).for('update')
        : []
      if (checkpoint.activeInputLeaseId) {
        if (checkpoint.activeInputLeaseFrom === null || checkpoint.activeInputLeaseTo === null) {
          throw new Error(`运行 '${parsed.runId}' 的活动输入 lease 范围不完整`)
        }
        assertContiguous(
          activeRows,
          checkpoint.activeInputLeaseFrom,
          checkpoint.activeInputLeaseTo - checkpoint.activeInputLeaseFrom + 1,
          parsed.runId,
        )
        const states = new Set(activeRows.map(row => row.status))
        if (states.size !== 1) throw new Error(`运行 '${parsed.runId}' 的活动输入状态不一致`)
        if (activeRows[0]?.status === 'included') {
          if (activeRows.some(row => row.modelRequestId !== parsed.requestId)) {
            throw new Error(`运行 '${parsed.runId}' 的 included 输入已绑定其它模型请求`)
          }
        }
      }
      const inputEntryIds = activeRows.map(row => row.entryId)
      const proposed = modelRequestRecordSchema.parse({ ...parsed, inputEntryIds })

      const existingRows = await tx.select().from(platformModelRequestRecords)
        .where(or(
          eq(platformModelRequestRecords.requestId, parsed.requestId),
          and(
            eq(platformModelRequestRecords.runId, parsed.runId),
            eq(platformModelRequestRecords.stepId, parsed.stepId),
          ),
        ))
        .limit(2)
      if (existingRows.length) {
        const existing = mapModelRequestRow(existingRows[0]!)
        if (!isDeepStrictEqual(existing, proposed)) {
          throw new Error(`模型请求 '${parsed.requestId}' 的幂等键或 stepId 已被其它内容使用`)
        }
        if (currentSnapshot.activeModelRequestId !== existing.requestId) {
          throw new Error(`模型请求 '${existing.requestId}' 已被 checkpoint，不能重新打开`)
        }
        return { record: existing, includedInputs: activeRows.map(mapRunSteeringRow) }
      }
      if (currentSnapshot.activeModelRequestId) {
        throw new Error(
          `运行 '${parsed.runId}' 已有活动模型请求 '${currentSnapshot.activeModelRequestId}'`,
        )
      }

      await tx.insert(platformModelRequestRecords).values({
        requestId: proposed.requestId,
        schemaVersion: proposed.schemaVersion,
        runId: proposed.runId,
        turnId: proposed.turnId,
        stepId: proposed.stepId,
        segmentId: proposed.segmentId,
        objectiveRevision: proposed.objectiveRevision,
        inputCursor: proposed.inputCursor,
        contextWindowId: proposed.contextWindowId,
        contextDigest: proposed.contextDigest,
        agentStepContextSchemaVersion: proposed.agentStepContextSchemaVersion,
        provider: proposed.provider,
        modelId: proposed.modelId,
        inputObjectHash: proposed.inputObjectHash,
        inputDigest: proposed.inputDigest,
        instructionsDigest: proposed.instructionsDigest,
        toolPlanDigest: proposed.toolPlanDigest,
        worldRevision: proposed.worldRevision,
        inputEntryIds: proposed.inputEntryIds,
        summaryObjectHashes: proposed.summaryObjectHashes,
        createdAt: new Date(proposed.createdAt),
      })
      const includedAt = new Date()
      const activeLeaseId = checkpoint.activeInputLeaseId
      const includedRows = activeRows.length
        ? await tx.update(platformRunInputs).set({
          status: 'included',
          modelRequestId: proposed.requestId,
          includedAt,
          checkpointedAt: null,
        }).where(and(
          eq(platformRunInputs.runId, proposed.runId),
          eq(platformRunInputs.status, 'leased'),
          eq(platformRunInputs.leaseId, activeLeaseId!),
        )).returning()
        : []
      includedRows.sort((left, right) => left.inputSequence - right.inputSequence)
      if (activeRows.length) {
        assertContiguous(
          includedRows,
          checkpoint.activeInputLeaseFrom!,
          activeRows.length,
          parsed.runId,
        )
      }
      const includedInputs = includedRows.map(mapRunSteeringRow)
      if (includedInputs.length) {
        await this.inputDelivery.recordTransition(
          tx,
          'included',
          parsed.runId,
          runRow.threadId ?? includedRows[0]?.threadId ?? null,
          includedInputs,
        )
      }

      const projectedRun = mapAnalysisRunRow(runRow, currentSnapshot)
      const events: RunDomainEvent[] = []
      if (includedInputs.length) {
        events.push(buildInputTransitionEvent({
          run: projectedRun,
          expectedSequence: currentSnapshot.sequence,
          type: 'input.included',
          records: includedInputs,
        }))
      }
      events.push(buildModelRequestCommittedEvent({
        run: projectedRun,
        expectedSequence: currentSnapshot.sequence + events.length,
        requestId: proposed.requestId,
        stepId: proposed.stepId,
        inputObjectHash: proposed.inputObjectHash,
        inputEntryIds: proposed.inputEntryIds,
      }))
      const snapshot = await this.domainJournal.appendInTransaction(tx, {
        runId: parsed.runId,
        expectedSequence: currentSnapshot.sequence,
        events,
      })
      assertRunDomainProjection(snapshot, projectedRun)
      assertRunDomainCheckpointProjection(snapshot, toRunDomainCheckpoint(runRow))
      if (includedInputs.length) assertRunDomainInputProjection(snapshot, includedInputs)
      return { record: proposed, includedInputs }
    }))
  }

  async getModelRequest(requestId: string): Promise<ModelRequestRecord | null> {
    const rows = await this.db.select().from(platformModelRequestRecords)
      .where(eq(platformModelRequestRecords.requestId, requestId)).limit(1)
    return rows[0] ? mapModelRequestRow(rows[0]) : null
  }

  async getActiveModelRequest(runId: string): Promise<ModelRequestRecord | null> {
    const snapshot = await this.domainJournal.getRunDomainSnapshot(runId)
    if (!snapshot) throw new Error(`运行 '${runId}' 缺少 Run domain snapshot`)
    if (!snapshot.activeModelRequestId) return null
    const requestRows = await this.db.select().from(platformModelRequestRecords)
      .where(and(
        eq(platformModelRequestRecords.requestId, snapshot.activeModelRequestId),
        eq(platformModelRequestRecords.runId, runId),
      )).limit(1)
    const request = requestRows[0]
    if (!request) {
      throw new Error(
        `运行 '${runId}' 的活动模型请求 '${snapshot.activeModelRequestId}' 不存在或归属错误`,
      )
    }
    return mapModelRequestRow(request)
  }

  async listModelRequests(runId: string): Promise<ModelRequestRecord[]> {
    const rows = await this.db.select().from(platformModelRequestRecords)
      .where(eq(platformModelRequestRecords.runId, runId))
      .orderBy(asc(platformModelRequestRecords.createdAt))
    return rows.map(mapModelRequestRow)
  }
}

function mapModelRequestRow(
  row: typeof platformModelRequestRecords.$inferSelect,
): ModelRequestRecord {
  return modelRequestRecordSchema.parse({
    schemaVersion: row.schemaVersion,
    requestId: row.requestId,
    runId: row.runId,
    turnId: row.turnId,
    stepId: row.stepId,
    segmentId: row.segmentId,
    objectiveRevision: row.objectiveRevision,
    inputCursor: row.inputCursor,
    contextWindowId: row.contextWindowId,
    contextDigest: row.contextDigest,
    agentStepContextSchemaVersion: row.agentStepContextSchemaVersion,
    provider: row.provider,
    modelId: row.modelId,
    inputObjectHash: row.inputObjectHash,
    inputDigest: row.inputDigest,
    instructionsDigest: row.instructionsDigest,
    toolPlanDigest: row.toolPlanDigest,
    worldRevision: row.worldRevision,
    inputEntryIds: row.inputEntryIds,
    summaryObjectHashes: row.summaryObjectHashes,
    createdAt: row.createdAt.toISOString(),
  })
}

function assertContiguous(
  rows: readonly { inputSequence: number }[],
  firstSequence: number,
  expectedCount: number,
  runId: string,
): void {
  if (rows.length !== expectedCount) throw new Error(`运行 '${runId}' 的输入连续前缀存在空洞`)
  rows.forEach((row, index) => {
    if (row.inputSequence !== firstSequence + index) {
      throw new Error(`运行 '${runId}' 的输入连续前缀存在空洞`)
    }
  })
}
