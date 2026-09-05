// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工具调用持久账本
//
//   文件:       toolInvocationRepository.ts
//
//   日期:       2026年08月23日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { isDeepStrictEqual } from 'node:util'

import { and, asc, eq } from 'drizzle-orm'
import {
  toolInvocationRecordSchema,
  type ToolInvocationRecord,
} from '@geo-agent-platform/shared-types/tool-runtime'

import type { Database, DatabaseTransaction } from '../../db/connection.js'
import { platformToolInvocations, platformRuns } from '../../db/schema.js'
import type { RunDomainSnapshot } from '../../schemas/types.js'
import type { RunMutationQueue } from '../runMutationQueue.js'
import {
  assertRunDomainCheckpointProjection,
  assertRunDomainProjection,
  buildCheckpointChangedEvent,
  toRunDomainCheckpoint,
} from '../runDomainProjection.js'
import type {
  StartToolInvocationInput,
  TerminalToolInvocationInput,
  ToolInvocationRepository,
} from './conversationPersistencePorts.js'
import {
  mapAnalysisRunRow,
  toRunCheckpointUpdateValues,
} from './conversationRowMappers.js'
import type { PostgresRunDomainJournalRepository } from './runDomainJournalRepository.js'

export class PostgresToolInvocationRepository implements ToolInvocationRepository {
  constructor(
    private readonly db: Database,
    private readonly runMutations: RunMutationQueue,
    private readonly domainJournal: PostgresRunDomainJournalRepository,
  ) {}

  prepareToolInvocation(invocation: ToolInvocationRecord): Promise<ToolInvocationRecord> {
    const prepared = toolInvocationRecordSchema.parse(invocation)
    if (prepared.status !== 'prepared' || prepared.version !== 1) {
      return Promise.reject(new Error('新工具调用必须以 prepared/version 1 建立'))
    }
    return this.runMutations.run(prepared.runId, () => this.db.transaction(async tx => {
      const inserted = await tx.insert(platformToolInvocations)
        .values(toToolInvocationValues(prepared))
        .onConflictDoNothing()
        .returning()
      if (inserted[0]) return mapToolInvocationRow(inserted[0])

      const existingRows = await tx.select().from(platformToolInvocations)
        .where(and(
          eq(platformToolInvocations.runId, prepared.runId),
          eq(platformToolInvocations.callId, prepared.callId),
        ))
        .for('update')
        .limit(1)
      const existing = existingRows[0] ? mapToolInvocationRow(existingRows[0]) : null
      if (!existing) throw new Error(`工具调用 '${prepared.callId}' 的唯一键冲突但记录不存在`)
      if (!sameInvocationIdentity(existing, prepared)) {
        throw new Error(`工具调用 '${prepared.callId}' 的持久身份与重试请求不一致`)
      }
      return existing
    }))
  }

  async getToolInvocation(runId: string, callId: string): Promise<ToolInvocationRecord | null> {
    const rows = await this.db.select().from(platformToolInvocations)
      .where(and(
        eq(platformToolInvocations.runId, runId),
        eq(platformToolInvocations.callId, callId),
      ))
      .limit(1)
    return rows[0] ? mapToolInvocationRow(rows[0]) : null
  }

  async listToolInvocations(runId: string): Promise<ToolInvocationRecord[]> {
    const rows = await this.db.select().from(platformToolInvocations)
      .where(eq(platformToolInvocations.runId, runId))
      .orderBy(asc(platformToolInvocations.preparedAt), asc(platformToolInvocations.invocationId))
    return rows.map(mapToolInvocationRow)
  }

  startToolInvocation(input: StartToolInvocationInput): Promise<ToolInvocationRecord> {
    return this.runMutations.run(input.runId, () => this.db.transaction(async tx => {
      const current = await requireInvocation(tx, input.runId, input.invocationId)
      if (current.status === 'running') return current
      if (current.status !== 'prepared' || current.version !== input.expectedVersion) {
        throw invocationCasError(current, input.expectedVersion, 'running')
      }
      const runningAt = new Date(input.runningAt)
      const updatedRows = await tx.update(platformToolInvocations).set({
        status: 'running',
        approvalDecision: input.approvalDecision,
        runningAt,
        version: current.version + 1,
      }).where(and(
        eq(platformToolInvocations.invocationId, input.invocationId),
        eq(platformToolInvocations.runId, input.runId),
        eq(platformToolInvocations.status, 'prepared'),
        eq(platformToolInvocations.version, input.expectedVersion),
      )).returning()
      const updated = updatedRows[0]
      if (!updated) throw invocationCasError(current, input.expectedVersion, 'running')
      await addPendingCall(tx, input.runId, current.callId, this.domainJournal)
      return mapToolInvocationRow(updated)
    }))
  }

  terminateToolInvocation(input: TerminalToolInvocationInput): Promise<ToolInvocationRecord> {
    return this.runMutations.run(input.runId, () => this.db.transaction(async tx => {
      const current = await requireInvocation(tx, input.runId, input.invocationId)
      if (
        current.terminalOutcome === input.outcome
        && (current.status === input.outcome || current.status === 'checkpointed')
      ) return current
      const expectedStatuses = input.outcome === 'rejected' ? ['prepared', 'running'] : ['running']
      if (!expectedStatuses.includes(current.status) || current.version !== input.expectedVersion) {
        throw invocationCasError(current, input.expectedVersion, input.outcome)
      }
      const terminalAt = new Date(input.terminalAt)
      const status = input.checkpointImmediately ? 'checkpointed' : input.outcome
      const updatedRows = await tx.update(platformToolInvocations).set({
        status,
        terminalOutcome: input.outcome,
        terminalAt,
        checkpointedAt: input.checkpointImmediately ? terminalAt : null,
        resultId: input.resultId,
        error: input.error,
        ...(input.approvalDecision ? { approvalDecision: input.approvalDecision } : {}),
        version: current.version + 1,
      }).where(and(
        eq(platformToolInvocations.invocationId, input.invocationId),
        eq(platformToolInvocations.runId, input.runId),
        eq(platformToolInvocations.version, input.expectedVersion),
      )).returning()
      const updated = updatedRows[0]
      if (!updated) throw invocationCasError(current, input.expectedVersion, input.outcome)
      if (input.checkpointImmediately) {
        await removePendingCall(tx, input.runId, current.callId, this.domainJournal)
      }
      return mapToolInvocationRow(updated)
    }))
  }
}

async function addPendingCall(
  tx: DatabaseTransaction,
  runId: string,
  callId: string,
  domainJournal: PostgresRunDomainJournalRepository,
): Promise<void> {
  const runRows = await tx.select().from(platformRuns)
    .where(eq(platformRuns.runId, runId)).for('update').limit(1)
  const run = runRows[0]
  if (!run) throw new Error(`运行 '${runId}' 不存在`)
  const currentSnapshot = await domainJournal.requireSnapshotInTransaction(tx, runId)
  const checkpoint = requireCheckpoint(currentSnapshot)
  if (checkpoint.pendingToolCallIds.includes(callId)) return
  const updatedRows = await tx.update(platformRuns).set({
    ...toRunCheckpointUpdateValues({
      ...checkpoint,
      pendingToolCallIds: [...checkpoint.pendingToolCallIds, callId],
      recoveryStatus: 'requires_action',
    }),
    updatedAt: new Date(),
  }).where(eq(platformRuns.runId, runId)).returning()
  await appendCheckpointProjection(tx, currentSnapshot, updatedRows[0], domainJournal)
}

async function removePendingCall(
  tx: DatabaseTransaction,
  runId: string,
  callId: string,
  domainJournal: PostgresRunDomainJournalRepository,
): Promise<void> {
  const runRows = await tx.select().from(platformRuns)
    .where(eq(platformRuns.runId, runId)).for('update').limit(1)
  const run = runRows[0]
  if (!run) throw new Error(`运行 '${runId}' 不存在`)
  const currentSnapshot = await domainJournal.requireSnapshotInTransaction(tx, runId)
  const checkpoint = requireCheckpoint(currentSnapshot)
  if (!checkpoint.pendingToolCallIds.includes(callId)) return
  const pendingToolCallIds = checkpoint.pendingToolCallIds.filter(candidate => candidate !== callId)
  const updatedRows = await tx.update(platformRuns).set({
    ...toRunCheckpointUpdateValues({
      ...checkpoint,
      pendingToolCallIds,
      recoveryStatus: pendingToolCallIds.length ? 'requires_action' : 'clean',
    }),
    updatedAt: new Date(),
  }).where(eq(platformRuns.runId, runId)).returning()
  await appendCheckpointProjection(tx, currentSnapshot, updatedRows[0], domainJournal)
}

async function appendCheckpointProjection(
  tx: DatabaseTransaction,
  currentSnapshot: RunDomainSnapshot,
  row: typeof platformRuns.$inferSelect | undefined,
  domainJournal: PostgresRunDomainJournalRepository,
): Promise<void> {
  if (!row) throw new Error('工具调用账本更新后运行记录不存在')
  const run = mapAnalysisRunRow(row, currentSnapshot)
  const checkpoint = toRunDomainCheckpoint(row)
  const snapshot = await domainJournal.appendInTransaction(tx, {
    runId: run.id,
    expectedSequence: currentSnapshot.sequence,
    events: [buildCheckpointChangedEvent({
      run,
      expectedSequence: currentSnapshot.sequence,
      checkpoint,
    })],
  })
  assertRunDomainProjection(snapshot, run)
  assertRunDomainCheckpointProjection(snapshot, checkpoint)
}

function requireCheckpoint(snapshot: RunDomainSnapshot): NonNullable<RunDomainSnapshot['checkpoint']> {
  if (!snapshot.checkpoint) throw new Error(`运行 '${snapshot.runId}' 的权威 snapshot 缺少 checkpoint`)
  return snapshot.checkpoint
}

async function requireInvocation(
  tx: DatabaseTransaction,
  runId: string,
  invocationId: string,
): Promise<ToolInvocationRecord> {
  const rows = await tx.select().from(platformToolInvocations)
    .where(and(
      eq(platformToolInvocations.runId, runId),
      eq(platformToolInvocations.invocationId, invocationId),
    ))
    .for('update')
    .limit(1)
  if (!rows[0]) throw new Error(`工具调用 '${invocationId}' 不存在`)
  return mapToolInvocationRow(rows[0])
}

export function mapToolInvocationRow(
  row: typeof platformToolInvocations.$inferSelect,
): ToolInvocationRecord {
  return toolInvocationRecordSchema.parse({
    invocationId: row.invocationId,
    runId: row.runId,
    turnId: row.turnId,
    callId: row.callId,
    stepId: row.stepId,
    toolName: row.toolName,
    toolKind: row.toolKind,
    executionSurface: row.executionSurface,
    objectiveRevision: row.objectiveRevision,
    toolPlanDigest: row.toolPlanDigest,
    descriptorDigest: row.descriptorDigest,
    argsDigest: row.argsDigest,
    effect: row.effect,
    replayPolicy: row.replayPolicy,
    idempotencyKey: row.idempotencyKey,
    approvalAction: row.approvalAction,
    approvalDecision: row.approvalDecision,
    status: row.status,
    terminalOutcome: row.terminalOutcome,
    resultId: row.resultId,
    error: row.error,
    preparedAt: row.preparedAt.toISOString(),
    runningAt: row.runningAt?.toISOString() ?? null,
    terminalAt: row.terminalAt?.toISOString() ?? null,
    checkpointedAt: row.checkpointedAt?.toISOString() ?? null,
    version: row.version,
  })
}

function toToolInvocationValues(
  invocation: ToolInvocationRecord,
): typeof platformToolInvocations.$inferInsert {
  return {
    invocationId: invocation.invocationId,
    runId: invocation.runId,
    turnId: invocation.turnId,
    callId: invocation.callId,
    stepId: invocation.stepId,
    toolName: invocation.toolName,
    toolKind: invocation.toolKind,
    executionSurface: invocation.executionSurface,
    objectiveRevision: invocation.objectiveRevision,
    toolPlanDigest: invocation.toolPlanDigest,
    descriptorDigest: invocation.descriptorDigest,
    argsDigest: invocation.argsDigest,
    effect: invocation.effect,
    replayPolicy: invocation.replayPolicy,
    idempotencyKey: invocation.idempotencyKey,
    approvalAction: invocation.approvalAction,
    approvalDecision: invocation.approvalDecision,
    status: invocation.status,
    terminalOutcome: invocation.terminalOutcome,
    resultId: invocation.resultId,
    error: invocation.error,
    preparedAt: new Date(invocation.preparedAt),
    runningAt: invocation.runningAt ? new Date(invocation.runningAt) : null,
    terminalAt: invocation.terminalAt ? new Date(invocation.terminalAt) : null,
    checkpointedAt: invocation.checkpointedAt ? new Date(invocation.checkpointedAt) : null,
    version: invocation.version,
  }
}

function sameInvocationIdentity(left: ToolInvocationRecord, right: ToolInvocationRecord): boolean {
  const identity = (value: ToolInvocationRecord) => ({
    invocationId: value.invocationId,
    runId: value.runId,
    turnId: value.turnId,
    callId: value.callId,
    stepId: value.stepId,
    toolName: value.toolName,
    toolKind: value.toolKind,
    executionSurface: value.executionSurface,
    objectiveRevision: value.objectiveRevision,
    toolPlanDigest: value.toolPlanDigest,
    descriptorDigest: value.descriptorDigest,
    argsDigest: value.argsDigest,
    effect: value.effect,
    replayPolicy: value.replayPolicy,
    idempotencyKey: value.idempotencyKey,
    approvalAction: value.approvalAction,
  })
  return isDeepStrictEqual(identity(left), identity(right))
}

function invocationCasError(
  current: ToolInvocationRecord,
  expectedVersion: number,
  nextStatus: string,
): Error {
  return new Error(
    `工具调用 '${current.callId}' 无法从 ${current.status}/v${current.version} `
    + `以期望 v${expectedVersion} 转为 ${nextStatus}`,
  )
}
