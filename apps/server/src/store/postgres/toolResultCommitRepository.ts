// +-------------------------------------------------------------------------
//
//   地理智能平台 - Tool Result 单事务提交
//
//   文件:       toolResultCommitRepository.ts
//
//   Tool Value、Run 状态、Artifact 元数据/地图投影和 Outbox 必须共享同一
//   PostgreSQL 事务；文件系统只在事务成功后由上层发布。
// --------------------------------------------------------------------------

import { and, eq } from 'drizzle-orm'

import type { Database } from '../../db/connection.js'
import {
  platformEventOutbox,
  platformRuns,
  platformToolInvocations,
  platformToolResultCommits,
} from '../../db/schema.js'
import type { AnalysisRun, ArtifactRef, ToolValueRef } from '../../schemas/types.js'
import { currentLogContext } from '../../observability/logger.js'
import { makeId } from '../../utils/ids.js'
import type { RunMutationQueue } from '../runMutationQueue.js'
import {
  assertRunDomainCheckpointProjection,
  assertRunDomainProjection,
  buildCheckpointChangedEvent,
  buildRunTransitionEvents,
  toRunDomainCheckpoint,
} from '../runDomainProjection.js'
import type {
  ToolEffectCommitResult,
  ToolInvocationEffectCommit,
} from './conversationPersistencePorts.js'
import {
  mapAnalysisRunRow,
  toRunCheckpointUpdateValues,
  toRunInsertValues,
  toRunUpdateValues,
} from './conversationRowMappers.js'
import { ArtifactPublicationRepository } from './artifactPublicationRepository.js'
import { RunRecordAppender } from './runRecordAppender.js'
import type { PostgresRunDomainJournalRepository } from './runDomainJournalRepository.js'
import { mapToolInvocationRow } from './toolInvocationRepository.js'

export class PostgresToolResultCommitRepository {
  private readonly artifactPublication: ArtifactPublicationRepository
  private readonly runRecords = new RunRecordAppender()

  constructor(
    private readonly db: Database,
    private readonly runMutations: RunMutationQueue,
    private readonly domainJournal: PostgresRunDomainJournalRepository,
  ) {
    this.artifactPublication = new ArtifactPublicationRepository(db)
  }

  async commit(
    run: AnalysisRun,
    resultId: string,
    invocation: ToolInvocationEffectCommit,
    values: readonly ToolValueRef[],
    artifacts: readonly ArtifactRef[],
  ): Promise<ToolEffectCommitResult> {
    return this.runMutations.run(run.id, () => this.db.transaction(async tx => {
      const runRows = await tx.select()
        .from(platformRuns)
        .where(eq(platformRuns.runId, run.id))
        .for('update')
        .limit(1)
      const persistedRun = runRows[0]
      if (!persistedRun) throw new Error(`运行 '${run.id}' 不存在`)
      if (persistedRun.threadId !== run.threadId) {
        throw new Error(`运行 '${run.id}' 的 threadId 与内存状态不一致`)
      }
      const invocationRows = await tx.select().from(platformToolInvocations)
        .where(and(
          eq(platformToolInvocations.runId, run.id),
          eq(platformToolInvocations.invocationId, invocation.invocationId),
        ))
        .for('update')
        .limit(1)
      const persistedInvocation = invocationRows[0]
      if (!persistedInvocation) throw new Error(`工具调用 '${invocation.invocationId}' 不存在`)

      const claimed = await tx.insert(platformToolResultCommits).values({
        runId: run.id,
        invocationId: invocation.invocationId,
        resultId,
      }).onConflictDoNothing().returning({ invocationId: platformToolResultCommits.invocationId })
      if (!claimed[0]) {
        const existing = mapToolInvocationRow(persistedInvocation)
        if (existing.terminalOutcome !== 'succeeded' || existing.resultId !== resultId) {
          throw new Error(`结果 '${resultId}' 已提交，但工具调用 '${existing.callId}' 未绑定该成功终态`)
        }
        return { committed: false, invocation: existing }
      }
      if (
        persistedInvocation.status !== 'running'
        || persistedInvocation.version !== invocation.expectedVersion
      ) {
        throw new Error(
          `工具调用 '${persistedInvocation.callId}' 无法从 `
          + `${persistedInvocation.status}/v${persistedInvocation.version} 提交结果 '${resultId}'`,
        )
      }

      const currentSnapshot = await this.domainJournal.requireSnapshotInTransaction(tx, run.id)
      const currentCheckpoint = currentSnapshot.checkpoint
      if (!currentCheckpoint) throw new Error(`运行 '${run.id}' 的权威 snapshot 缺少 checkpoint`)
      const pendingToolCallIds = invocation.checkpointImmediately
        ? currentCheckpoint.pendingToolCallIds.filter(callId => callId !== persistedInvocation.callId)
        : currentCheckpoint.pendingToolCallIds
      const updatedRows = await tx.update(platformRuns)
        .set({
          ...toRunUpdateValues(toRunInsertValues(run)),
          ...toRunCheckpointUpdateValues({
            ...currentCheckpoint,
            pendingToolCallIds,
            recoveryStatus: pendingToolCallIds.length ? 'requires_action' : 'clean',
          }),
        })
        .where(eq(platformRuns.runId, run.id))
        .returning()
      const updatedRow = updatedRows[0]
      if (!updatedRow) throw new Error(`运行 '${run.id}' 不存在`)
      const terminalAt = new Date(invocation.terminalAt)
      const terminalRows = await tx.update(platformToolInvocations).set({
        status: invocation.checkpointImmediately ? 'checkpointed' : 'succeeded',
        terminalOutcome: 'succeeded',
        resultId,
        terminalAt,
        checkpointedAt: invocation.checkpointImmediately ? terminalAt : null,
        version: persistedInvocation.version + 1,
      }).where(and(
        eq(platformToolInvocations.invocationId, invocation.invocationId),
        eq(platformToolInvocations.runId, run.id),
        eq(platformToolInvocations.status, 'running'),
        eq(platformToolInvocations.version, invocation.expectedVersion),
      )).returning()
      const terminalInvocation = terminalRows[0]
      if (!terminalInvocation) throw new Error(`工具调用 '${persistedInvocation.callId}' 的结果提交 CAS 失败`)
      const persistedAfter = mapAnalysisRunRow(updatedRow, run)
      const domainEvents = buildRunTransitionEvents({
        before: mapAnalysisRunRow(persistedRun, currentSnapshot),
        after: persistedAfter,
        expectedSequence: currentSnapshot.sequence,
        reason: 'tool_result_committed',
        resultId,
      })
      if (invocation.checkpointImmediately) {
        domainEvents.push(buildCheckpointChangedEvent({
          run: persistedAfter,
          expectedSequence: currentSnapshot.sequence + domainEvents.length,
          checkpoint: toRunDomainCheckpoint(updatedRow),
        }))
      }
      const domainSnapshot = await this.domainJournal.appendInTransaction(tx, {
        runId: run.id,
        expectedSequence: currentSnapshot.sequence,
        events: domainEvents,
      })
      assertRunDomainProjection(domainSnapshot, persistedAfter)
      assertRunDomainCheckpointProjection(domainSnapshot, toRunDomainCheckpoint(updatedRow))

      const traceId = stringContextValue('traceId')
      await this.runRecords.append(
        tx,
        run.id,
        persistedRun.threadId,
        values.map(value => ({ recordType: 'value', payloadJson: value })),
        traceId,
      )
      await tx.insert(platformEventOutbox).values({
        outboxId: makeId('outbox'),
        aggregateType: 'run',
        aggregateId: run.id,
        eventType: 'run.tool_result.committed',
        payloadJson: {
          invocationId: invocation.invocationId,
          callId: persistedInvocation.callId,
          resultId,
          valueRefIds: values.map(value => value.refId),
          artifactIds: artifacts.map(artifact => artifact.artifactId),
        },
        traceId,
      })

      const owner = {
        workspaceId: run.workspaceId,
        createdByUserId: run.createdByUserId,
        visibility: run.visibility,
        threadId: run.threadId,
        runCreatedAt: run.createdAt,
      }
      for (const artifact of artifacts) {
        await this.artifactPublication.persistInTransaction(tx, artifact, owner)
      }
      return { committed: true, invocation: mapToolInvocationRow(terminalInvocation) }
    }))
  }
}

function stringContextValue(key: string): string | null {
  const value = currentLogContext()[key]
  return typeof value === 'string' && value.length ? value : null
}
