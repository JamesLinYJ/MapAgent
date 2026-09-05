// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运行持久化组合适配器
//
//   文件:       runRepository.ts
//
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type {
  AnalysisRun,
  ArtifactRef,
  ConversationItem,
  RunCheckpoint,
  RunEvent,
  RunSteeringRecord,
  ToolValueRef,
} from '../../schemas/types.js'
import type { ToolInvocationRecord } from '@geo-agent-platform/shared-types/tool-runtime'
import type { RunPresentationProjection } from '@geo-agent-platform/shared-types/run-presentation'
import type { Database } from '../../db/connection.js'
import type { RunMutationQueue } from '../runMutationQueue.js'
import type {
  RunCheckpointRepository,
  RunLifecycleResult,
  RunRecordRepository,
  RunRepository,
  RunStateRepository,
  StartToolInvocationInput,
  TerminalToolInvocationInput,
  ToolEffectCommitResult,
  ToolInvocationEffectCommit,
  ToolInvocationRepository,
  ToolResultCommitter,
} from './conversationPersistencePorts.js'
import { PostgresRunCheckpointRepository } from './runCheckpointRepository.js'
import { RunInputDeliveryRecorder } from './runInputDeliveryRecorder.js'
import type { RunRecordAppender } from './runRecordAppender.js'
import { PostgresRunRecordRepository } from './runRecordRepository.js'
import { PostgresRunStateRepository } from './runStateRepository.js'
import { PostgresToolResultCommitRepository } from './toolResultCommitRepository.js'
import type { PostgresRunDomainJournalRepository } from './runDomainJournalRepository.js'
import { PostgresToolInvocationRepository } from './toolInvocationRepository.js'

/** 组合 Run 状态、checkpoint 和记录流端口，不直接访问数据库表。 */
export class PostgresRunRepository implements RunRepository, ToolInvocationRepository, ToolResultCommitter {
  private readonly state: RunStateRepository
  private readonly checkpoints: RunCheckpointRepository
  private readonly records: RunRecordRepository
  private readonly toolResults: PostgresToolResultCommitRepository
  private readonly toolInvocations: PostgresToolInvocationRepository

  constructor(
    db: Database,
    runMutations: RunMutationQueue,
    runRecords: RunRecordAppender,
    domainJournal: PostgresRunDomainJournalRepository,
    inputDelivery = new RunInputDeliveryRecorder(runRecords),
  ) {
    this.state = new PostgresRunStateRepository(db, runMutations, domainJournal)
    this.checkpoints = new PostgresRunCheckpointRepository(
      db,
      runMutations,
      inputDelivery,
      domainJournal,
    )
    this.records = new PostgresRunRecordRepository(db, runMutations, runRecords)
    this.toolResults = new PostgresToolResultCommitRepository(
      db,
      runMutations,
      domainJournal,
    )
    this.toolInvocations = new PostgresToolInvocationRepository(db, runMutations, domainJournal)
  }

  createRunLifecycle(run: AnalysisRun): Promise<RunLifecycleResult> {
    return this.state.createRunLifecycle(run)
  }

  saveRun(run: AnalysisRun): Promise<void> {
    return this.state.saveRun(run)
  }

  saveRunWithModelUsage(run: AnalysisRun, modelTokens: number): Promise<void> {
    return this.state.saveRunWithModelUsage(run, modelTokens)
  }

  saveRunWithCheckpoint(
    run: AnalysisRun,
    fields: Partial<Pick<RunCheckpoint, 'activeEntryId' | 'pendingToolCallIds' | 'recoveryStatus'>>,
  ): Promise<void> {
    return this.state.saveRunWithCheckpoint(run, fields)
  }

  listRunsForThread(threadId: string): Promise<AnalysisRun[]> {
    return this.state.listRunsForThread(threadId)
  }

  saveRunCheckpoint(
    runId: string,
    fields: Partial<Pick<RunCheckpoint, 'activeEntryId' | 'pendingToolCallIds' | 'recoveryStatus'>>,
  ): Promise<void> {
    return this.checkpoints.saveRunCheckpoint(runId, fields)
  }

  getRunCheckpoint(runId: string): Promise<RunCheckpoint> {
    return this.checkpoints.getRunCheckpoint(runId)
  }

  saveAgentsSdkCheckpoint(runId: string, input: {
    contentHash: string
    agentsSdkVersion: string
    runtimeConfigDigest: string
    sdkStateSchemaVersion: RunCheckpoint['sdkStateSchemaVersion']
    inputLeaseId?: string | null
    terminalToolCallIds?: readonly string[]
  }): Promise<RunSteeringRecord[]> {
    return this.checkpoints.saveAgentsSdkCheckpoint(runId, input)
  }

  appendConversationItem(item: ConversationItem): Promise<void> {
    return this.records.appendConversationItem(item)
  }

  listConversationItems(runId: string): Promise<ConversationItem[]> {
    return this.records.listConversationItems(runId)
  }

  appendRunEvent(event: RunEvent): Promise<void> {
    return this.records.appendRunEvent(event)
  }

  listRunEvents(runId: string): Promise<RunEvent[]> {
    return this.records.listRunEvents(runId)
  }

  appendToolValue(runId: string, value: ToolValueRef): Promise<void> {
    return this.records.appendToolValue(runId, value)
  }

  listToolValues(runId: string): Promise<ToolValueRef[]> {
    return this.records.listToolValues(runId)
  }

  loadRunPresentation(runId: string): Promise<RunPresentationProjection> {
    return this.records.loadRunPresentation(runId)
  }

  commitToolResult(
    run: AnalysisRun,
    resultId: string,
    invocation: ToolInvocationEffectCommit,
    values: readonly ToolValueRef[],
    artifacts: readonly ArtifactRef[],
  ): Promise<ToolEffectCommitResult> {
    return this.toolResults.commit(run, resultId, invocation, values, artifacts)
  }

  prepareToolInvocation(invocation: ToolInvocationRecord): Promise<ToolInvocationRecord> {
    return this.toolInvocations.prepareToolInvocation(invocation)
  }

  getToolInvocation(runId: string, callId: string): Promise<ToolInvocationRecord | null> {
    return this.toolInvocations.getToolInvocation(runId, callId)
  }

  listToolInvocations(runId: string): Promise<ToolInvocationRecord[]> {
    return this.toolInvocations.listToolInvocations(runId)
  }

  startToolInvocation(input: StartToolInvocationInput): Promise<ToolInvocationRecord> {
    return this.toolInvocations.startToolInvocation(input)
  }

  terminateToolInvocation(input: TerminalToolInvocationInput): Promise<ToolInvocationRecord> {
    return this.toolInvocations.terminateToolInvocation(input)
  }
}
