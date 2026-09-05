// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运行检查点持久化
//
//   文件:       runCheckpointRepository.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
//   来源:       runRepository.ts 的恢复状态与 Agents SDK checkpoint 边界
// --------------------------------------------------------------------------

import { isDeepStrictEqual } from 'node:util'

import { and,asc,eq,inArray,isNull,sql } from 'drizzle-orm'

import {
runCheckpointSchema,
type RunCheckpoint,
type RunDomainSnapshot,
type RunSteeringRecord,
} from '../../schemas/types.js'
import type { Database,DatabaseTransaction } from '../../db/connection.js'
import {
platformModelRequestRecords,
platformRunInputs,
platformRuns,
platformToolInvocations,
} from '../../db/schema.js'
import type { RunMutationQueue } from '../runMutationQueue.js'
import {
assertRunDomainCheckpointProjection,
assertRunDomainInputProjection,
assertRunDomainProjection,
buildCheckpointChangedEvent,
buildInputTransitionEvent,
buildModelRequestCheckpointedEvent,
toRunDomainCheckpoint,
} from '../runDomainProjection.js'
import type { RunCheckpointRepository } from './conversationPersistencePorts.js'
import {
  mapAnalysisRunRow,
  toRunCheckpointUpdateValues,
} from './conversationRowMappers.js'
import type { RunInputDeliveryRecorder } from './runInputDeliveryRecorder.js'
import { mapRunSteeringRow } from './runInputRepository.js'
import type { PostgresRunDomainJournalRepository } from './runDomainJournalRepository.js'

/** Run 恢复字段和 Agents SDK 状态引用的唯一持久化边界。 */
export class PostgresRunCheckpointRepository implements RunCheckpointRepository {
  constructor(
    private readonly db: Database,
    private readonly runMutations: RunMutationQueue,
    private readonly inputDelivery: RunInputDeliveryRecorder,
    private readonly domainJournal: PostgresRunDomainJournalRepository,
  ) {}

  async saveRunCheckpoint(
    runId: string,
    fields: Partial<Pick<RunCheckpoint, 'activeEntryId' | 'pendingToolCallIds' | 'recoveryStatus'>>,
  ): Promise<void> {
    const updates: Partial<typeof platformRuns.$inferInsert> = { updatedAt: new Date() }
    await this.runMutations.run(runId, async () => {
      await this.db.transaction(async tx => {
        const beforeRows = await tx.select().from(platformRuns)
          .where(eq(platformRuns.runId, runId)).for('update').limit(1)
        if (!beforeRows[0]) throw new Error(`运行 '${runId}' 不存在`)
        const currentSnapshot = await this.domainJournal.requireSnapshotInTransaction(tx, runId)
        const currentCheckpoint = requireCheckpoint(currentSnapshot)
        const nextCheckpoint = {
          ...currentCheckpoint,
          ...(fields.activeEntryId !== undefined ? { activeEntryId: fields.activeEntryId } : {}),
          ...(fields.pendingToolCallIds !== undefined
            ? { pendingToolCallIds: [...fields.pendingToolCallIds] }
            : {}),
          ...(fields.recoveryStatus !== undefined ? { recoveryStatus: fields.recoveryStatus } : {}),
        }
        const rows = await tx.update(platformRuns).set({
          ...updates,
          ...toRunCheckpointUpdateValues(nextCheckpoint),
        })
          .where(eq(platformRuns.runId, runId))
          .returning()
        const afterRow = rows[0]
        if (!afterRow) throw new Error(`运行 '${runId}' 不存在`)
        await this.appendCheckpointProjection(tx, currentSnapshot, afterRow)
      })
    })
  }

  async getRunCheckpoint(runId: string): Promise<RunCheckpoint> {
    return this.db.transaction(async tx => {
      const rows = await tx.select().from(platformRuns)
        .where(eq(platformRuns.runId, runId)).limit(1)
      const row = rows[0]
      if (!row) throw new Error(`运行 '${runId}' 不存在`)
      const snapshot = await this.domainJournal.requireSnapshotInTransaction(tx, runId)
      const checkpoint = snapshot.checkpoint
      if (!checkpoint) throw new Error(`运行 '${runId}' 的权威 snapshot 缺少 checkpoint`)
      return runCheckpointSchema.parse({
        schemaVersion: 3,
        run: mapAnalysisRunRow(row, snapshot),
        ...checkpoint,
        lastPersistedAt: snapshot.updatedAt,
      })
    }, { isolationLevel: 'repeatable read' })
  }

  async saveAgentsSdkCheckpoint(runId: string, input: {
    contentHash: string
    agentsSdkVersion: string
    runtimeConfigDigest: string
    sdkStateSchemaVersion: RunCheckpoint['sdkStateSchemaVersion']
    inputLeaseId?: string | null
    terminalToolCallIds?: readonly string[]
    checkpointModelRequestStepId?: string | null
  }): Promise<RunSteeringRecord[]> {
    return this.runMutations.run(runId, () => this.db.transaction(async tx => {
      const runRows = await tx.select().from(platformRuns)
        .where(eq(platformRuns.runId, runId)).for('update').limit(1)
      const run = runRows[0]
      if (!run) throw new Error(`运行 '${runId}' 不存在`)
      const currentSnapshot = await this.domainJournal.requireSnapshotInTransaction(tx, runId)
      const authoritativeCheckpoint = requireCheckpoint(currentSnapshot)
      const checkpointModelRequest = await resolveModelRequestCheckpoint(
        tx,
        currentSnapshot,
        run,
        input.checkpointModelRequestStepId ?? null,
        input.contentHash,
      )

      const updatedAt = new Date()
      const terminalToolCallIds = new Set(input.terminalToolCallIds ?? [])
      await checkpointToolInvocations(tx, runId, terminalToolCallIds, updatedAt)
      const pendingToolCallIds = authoritativeCheckpoint.pendingToolCallIds
        .filter(callId => !terminalToolCallIds.has(callId))
      const nextCheckpointBase = {
        ...authoritativeCheckpoint,
        orchestrationEngine: 'openai_agents' as const,
        sdkStateContentHash: input.contentHash,
        agentsSdkVersion: input.agentsSdkVersion,
        runtimeConfigDigest: input.runtimeConfigDigest,
        sdkStateSchemaVersion: input.sdkStateSchemaVersion,
        sdkStateUpdatedAt: updatedAt.toISOString(),
        pendingToolCallIds,
        recoveryStatus: pendingToolCallIds.length ? 'requires_action' as const : 'clean' as const,
      }
      const checkpointFields = {
        ...toRunCheckpointUpdateValues(nextCheckpointBase),
        updatedAt,
      }
      const leaseId = input.inputLeaseId ?? null
      if (!leaseId) {
        if (authoritativeCheckpoint.activeInputLeaseId) {
          throw new Error(
            `运行 '${runId}' 存在未确认输入 lease '${authoritativeCheckpoint.activeInputLeaseId}'，`
            + '禁止挂载不带 input ack 的 SDK checkpoint',
          )
        }
        const rows = await tx.update(platformRuns).set(checkpointFields)
          .where(and(
            eq(platformRuns.runId, runId),
            eq(platformRuns.checkpointInputCursor, authoritativeCheckpoint.checkpointInputCursor),
            isNull(platformRuns.activeInputLeaseId),
          ))
          .returning()
        const afterRow = rows[0]
        if (!afterRow) throw new Error(`运行 '${runId}' 不存在`)
        await this.appendCheckpointProjection(
          tx,
          currentSnapshot,
          afterRow,
          [],
          checkpointModelRequest,
        )
        return []
      }

      const leasedRows = await tx.select().from(platformRunInputs)
        .where(and(
          eq(platformRunInputs.runId, runId),
          eq(platformRunInputs.leaseId, leaseId),
        ))
        .orderBy(asc(platformRunInputs.inputSequence))
        .for('update')
      if (!leasedRows.length) {
        throw new Error(`运行 '${runId}' 的输入 lease '${leaseId}' 不存在`)
      }

      const lastSequence = leasedRows.at(-1)!.inputSequence
      const isIdempotentCheckpoint = authoritativeCheckpoint.activeInputLeaseId === null
        && leasedRows.every(row => row.status === 'checkpointed')
        && lastSequence <= authoritativeCheckpoint.checkpointInputCursor
      if (isIdempotentCheckpoint) {
        if (authoritativeCheckpoint.sdkStateContentHash !== input.contentHash) {
          throw new Error(`运行 '${runId}' 的旧输入 lease '${leaseId}' 不能覆盖更新的 SDK checkpoint`)
        }
        if (pendingToolCallIds.length !== authoritativeCheckpoint.pendingToolCallIds.length) {
          const rows = await tx.update(platformRuns).set({
            ...toRunCheckpointUpdateValues({
              ...authoritativeCheckpoint,
              pendingToolCallIds,
              recoveryStatus: pendingToolCallIds.length ? 'requires_action' : 'clean',
            }),
            updatedAt,
          }).where(and(
            eq(platformRuns.runId, runId),
            eq(platformRuns.sdkStateContentHash, input.contentHash),
            isNull(platformRuns.activeInputLeaseId),
          )).returning()
          const afterRow = rows[0]
          if (!afterRow) throw new Error(`运行 '${runId}' 的工具终态 checkpoint CAS 失败`)
          await this.appendCheckpointProjection(
            tx,
            currentSnapshot,
            afterRow,
            [],
            checkpointModelRequest,
          )
        } else {
          const persistedRun = mapAnalysisRunRow(run, currentSnapshot)
          assertRunDomainProjection(currentSnapshot, persistedRun)
          assertRunDomainCheckpointProjection(currentSnapshot, toRunDomainCheckpoint(run))
        }
        return leasedRows.map(mapRunSteeringRow)
      }

      if (authoritativeCheckpoint.activeInputLeaseId !== leaseId) {
        throw new Error(
          `运行 '${runId}' 的活动输入 lease 与 checkpoint 不一致：`
          + `${authoritativeCheckpoint.activeInputLeaseId ?? 'none'} != ${leaseId}`,
        )
      }
      if (
        authoritativeCheckpoint.activeInputLeaseFrom !== authoritativeCheckpoint.checkpointInputCursor + 1
        || authoritativeCheckpoint.activeInputLeaseTo === null
      ) {
        throw new Error(`运行 '${runId}' 的活动输入 lease 范围不合法`)
      }
      assertAckPrefix(
        leasedRows,
        authoritativeCheckpoint.activeInputLeaseFrom,
        authoritativeCheckpoint.activeInputLeaseTo - authoritativeCheckpoint.activeInputLeaseFrom + 1,
        runId,
      )
      if (leasedRows.some(row => row.status !== 'included')) {
        throw new Error(`运行 '${runId}' 的活动输入 lease 尚未绑定精确 ModelRequest`)
      }
      if (checkpointModelRequest && leasedRows.some(row => (
        row.modelRequestId !== checkpointModelRequest.requestId
      ))) {
        throw new Error(`运行 '${runId}' 的输入 lease 与活动模型请求不一致`)
      }

      const checkpointedRows = await tx.update(platformRunInputs)
        .set({ status: 'checkpointed', checkpointedAt: updatedAt })
        .where(and(
          eq(platformRunInputs.runId, runId),
          eq(platformRunInputs.status, 'included'),
          eq(platformRunInputs.leaseId, leaseId),
        ))
        .returning()
      checkpointedRows.sort((left, right) => left.inputSequence - right.inputSequence)
      assertAckPrefix(
        checkpointedRows,
        authoritativeCheckpoint.activeInputLeaseFrom,
        authoritativeCheckpoint.activeInputLeaseTo - authoritativeCheckpoint.activeInputLeaseFrom + 1,
        runId,
      )
      const checkpointRows = await tx.update(platformRuns).set({
        ...toRunCheckpointUpdateValues({
          ...nextCheckpointBase,
          checkpointInputCursor: lastSequence,
          activeInputLeaseId: null,
          activeInputLeaseFrom: null,
          activeInputLeaseTo: null,
        }),
        updatedAt,
      }).where(and(
        eq(platformRuns.runId, runId),
        eq(platformRuns.checkpointInputCursor, authoritativeCheckpoint.checkpointInputCursor),
        eq(platformRuns.activeInputLeaseId, leaseId),
      )).returning()
      const afterRow = checkpointRows[0]
      if (!afterRow) throw new Error(`运行 '${runId}' 的 checkpoint/input cursor CAS 失败`)

      await this.inputDelivery.recordCheckpointed(
        tx,
        runId,
        run.threadId ?? checkpointedRows[0]?.threadId ?? null,
        checkpointedRows.map(mapRunSteeringRow),
      )

      await this.appendCheckpointProjection(
        tx,
        currentSnapshot,
        afterRow,
        checkpointedRows.map(mapRunSteeringRow),
        checkpointModelRequest,
      )

      return checkpointedRows.map(mapRunSteeringRow)
    }))
  }

  private async appendCheckpointProjection(
    tx: DatabaseTransaction,
    currentSnapshot: RunDomainSnapshot,
    afterRow: typeof platformRuns.$inferSelect,
    acknowledged: readonly RunSteeringRecord[] = [],
    checkpointedModelRequest: { requestId: string; stepId: string } | null = null,
  ): Promise<void> {
    const run = mapAnalysisRunRow(afterRow, {
      status: currentSnapshot.status,
      state: currentSnapshot.state,
      updatedAt: currentSnapshot.updatedAt,
    })
    const checkpoint = toRunDomainCheckpoint(afterRow)
    const events = []
    if (acknowledged.length) {
      events.push(buildInputTransitionEvent({
        run,
        expectedSequence: currentSnapshot.sequence,
        type: 'input.checkpointed',
        records: acknowledged,
      }))
    }
    if (checkpointedModelRequest) {
      events.push(buildModelRequestCheckpointedEvent({
        run,
        expectedSequence: currentSnapshot.sequence + events.length,
        requestId: checkpointedModelRequest.requestId,
        stepId: checkpointedModelRequest.stepId,
      }))
    }
    if (!isDeepStrictEqual(currentSnapshot.checkpoint, checkpoint)) {
      events.push(buildCheckpointChangedEvent({
        run,
        expectedSequence: currentSnapshot.sequence + events.length,
        checkpoint,
      }))
    }
    const snapshot = events.length
      ? await this.domainJournal.appendInTransaction(tx, {
        runId: run.id,
        expectedSequence: currentSnapshot.sequence,
        events,
      })
      : currentSnapshot
    assertRunDomainProjection(snapshot, run)
    assertRunDomainCheckpointProjection(snapshot, checkpoint)
    if (acknowledged.length) assertRunDomainInputProjection(snapshot, acknowledged)
  }
}

async function resolveModelRequestCheckpoint(
  tx: DatabaseTransaction,
  snapshot: RunDomainSnapshot,
  run: typeof platformRuns.$inferSelect,
  expectedStepId: string | null,
  checkpointContentHash: string,
): Promise<{ requestId: string; stepId: string } | null> {
  if (!expectedStepId) return null
  if (snapshot.activeModelRequestId) {
    const rows = await tx.select().from(platformModelRequestRecords).where(and(
      eq(platformModelRequestRecords.requestId, snapshot.activeModelRequestId),
      eq(platformModelRequestRecords.runId, run.runId),
    )).for('update').limit(1)
    const request = rows[0]
    if (!request) {
      throw new Error(
        `运行 '${run.runId}' 的活动模型请求 '${snapshot.activeModelRequestId}' 不存在或归属错误`,
      )
    }
    if (request.stepId !== expectedStepId) {
      throw new Error(`运行 '${run.runId}' 的活动模型请求与 checkpoint StepContext 不一致`)
    }
    return { requestId: request.requestId, stepId: request.stepId }
  }

  // 允许同一 checkpoint 在提交结果不确定时幂等重试；更新的 checkpoint
  // 绝不能借用历史 stepId 清除或覆盖当前恢复状态。
  const rows = await tx.select({ requestId: platformModelRequestRecords.requestId })
    .from(platformModelRequestRecords)
    .where(and(
      eq(platformModelRequestRecords.runId, run.runId),
      eq(platformModelRequestRecords.stepId, expectedStepId),
    )).for('update').limit(1)
  if (!rows[0] || snapshot.checkpoint?.sdkStateContentHash !== checkpointContentHash) {
    throw new Error(
      `运行 '${run.runId}' 没有可由 StepContext '${expectedStepId}' 确认的活动模型请求`,
    )
  }
  return null
}

function requireCheckpoint(snapshot: RunDomainSnapshot): NonNullable<RunDomainSnapshot['checkpoint']> {
  if (!snapshot.checkpoint) throw new Error(`运行 '${snapshot.runId}' 的权威 snapshot 缺少 checkpoint`)
  return snapshot.checkpoint
}

async function checkpointToolInvocations(
  tx: DatabaseTransaction,
  runId: string,
  callIds: ReadonlySet<string>,
  checkpointedAt: Date,
): Promise<void> {
  if (!callIds.size) return
  const rows = await tx.select().from(platformToolInvocations)
    .where(and(
      eq(platformToolInvocations.runId, runId),
      inArray(platformToolInvocations.callId, [...callIds]),
    ))
    .for('update')
  const byCallId = new Map(rows.map(row => [row.callId, row]))
  const missing = [...callIds].filter(callId => !byCallId.has(callId))
  if (missing.length) {
    throw new Error(`SDK checkpoint 引用了不存在的工具调用：${missing.join('、')}`)
  }
  const invalid = rows.filter(row => ![
    'succeeded',
    'failed',
    'rejected',
    'aborted',
    'checkpointed',
  ].includes(row.status))
  if (invalid.length) {
    throw new Error(
      `SDK checkpoint 不能确认非终态工具调用：`
      + invalid.map(row => `${row.callId}=${row.status}`).join('、'),
    )
  }
  const terminal = rows.filter(row => row.status !== 'checkpointed')
  if (!terminal.length) return
  const updated = await tx.update(platformToolInvocations).set({
    status: 'checkpointed',
    checkpointedAt,
    version: sql`${platformToolInvocations.version} + 1`,
  }).where(and(
    eq(platformToolInvocations.runId, runId),
    inArray(platformToolInvocations.invocationId, terminal.map(row => row.invocationId)),
    inArray(platformToolInvocations.status, ['succeeded', 'failed', 'rejected', 'aborted']),
  )).returning({ invocationId: platformToolInvocations.invocationId })
  if (updated.length !== terminal.length) {
    throw new Error(`运行 '${runId}' 的工具调用 checkpoint CAS 失败`)
  }
}

function assertAckPrefix(
  rows: readonly { inputSequence: number }[],
  firstSequence: number,
  expectedCount: number,
  runId: string,
): void {
  if (rows.length !== expectedCount) {
    throw new Error(`运行 '${runId}' 的 checkpoint ack 不是连续输入前缀`)
  }
  rows.forEach((row, index) => {
    if (row.inputSequence !== firstSequence + index) {
      throw new Error(`运行 '${runId}' 的 checkpoint ack 不是连续输入前缀`)
    }
  })
}
