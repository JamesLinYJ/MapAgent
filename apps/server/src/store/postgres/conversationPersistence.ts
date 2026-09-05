// +-------------------------------------------------------------------------
//
//   地理智能平台 - PostgreSQL 会话持久化聚合
//
//   文件:       conversationPersistence.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
type AgentThreadRecord,
type AnalysisRun,
type ArtifactRef,
type CompactionRecord,
type ConversationItem,
type ModelRequestRecord,
type RunCheckpoint,
type RunDomainEvent,
type RunDomainProjectionInspection,
type RunDomainSnapshot,
type RunEvent,
type RunSteeringRecord,
type SessionRecord,
type ThreadManifest,
type ThreadMemoryDocument,
type ToolValueRef,
type TranscriptEntry,
} from '../../schemas/types.js'
import type { ToolInvocationRecord } from '@geo-agent-platform/shared-types/tool-runtime'
import type { ApprovalRecord } from '@geo-agent-platform/shared-types/approval-runtime'
import type { RunPresentationProjection } from '@geo-agent-platform/shared-types/run-presentation'
import type { Database } from '../../db/connection.js'
import { RunMutationQueue } from '../runMutationQueue.js'
import type {
AppendConversationEntryInput,
ConversationPersistence,
ConversationSnapshot,
ConversationSnapshotRepository,
DeletedThreadRecord,
EnqueueRunInput,
CommitModelRequestInput,
CommitModelRequestResult,
ModelRequestRepository,
ObjectReferenceRepository,
RunInputRepository,
RunDomainJournalRepository,
RunLifecycleResult,
RunRepository,
ToolResultCommitter,
ToolInvocationRepository,
ApprovalRepository,
ConsumeApprovalRecordInput,
ResolveApprovalRecordInput,
StartToolInvocationInput,
TerminalToolInvocationInput,
ToolEffectCommitResult,
ToolInvocationEffectCommit,
ThreadHistoryPage,
ThreadLifecycleResult,
ThreadMemoryVersionReference,
ThreadRepository,
TrashThreadLifecycleResult,
SessionRepository,
} from './conversationPersistencePorts.js'
import { PostgresRunInputRepository } from './runInputRepository.js'
import { RunRecordAppender } from './runRecordAppender.js'
import { RunInputDeliveryRecorder } from './runInputDeliveryRecorder.js'
import { PostgresConversationSnapshotRepository } from './conversationSnapshotRepository.js'
import { PostgresSessionRepository } from './sessionRepository.js'
import { PostgresThreadRepository } from './threadRepository.js'
import { PostgresRunRepository } from './runRepository.js'
import { PostgresObjectReferenceRepository } from './objectReferenceRepository.js'
import { PostgresRunDomainJournalRepository } from './runDomainJournalRepository.js'
import { PostgresModelRequestRepository } from './modelRequestRepository.js'
import { PostgresApprovalRepository } from './approvalRepository.js'

// PostgreSQL 是结构化会话事实源。Repository 只处理数据库语义；Agent 运行时、
// WS 推送和诊断导出通过更窄的 Service 组合这些原子操作。
export class PostgresConversationPersistence implements ConversationPersistence {
  private readonly runMutations = new RunMutationQueue()
  private readonly runRecords = new RunRecordAppender()
  private readonly runInputs: RunInputRepository
  private readonly modelRequests: ModelRequestRepository
  private readonly snapshots: ConversationSnapshotRepository
  private readonly sessions: SessionRepository
  private readonly threads: ThreadRepository
  private readonly runs: RunRepository & ToolResultCommitter & ToolInvocationRepository
  private readonly domainJournal: RunDomainJournalRepository
  private readonly objectReferences: ObjectReferenceRepository
  private readonly approvals: ApprovalRepository

  constructor(db: Database) {
    const inputDelivery = new RunInputDeliveryRecorder(this.runRecords)
    const domainJournal = new PostgresRunDomainJournalRepository(db)
    this.domainJournal = domainJournal
    this.runInputs = new PostgresRunInputRepository(
      db,
      this.runMutations,
      inputDelivery,
      domainJournal,
    )
    this.modelRequests = new PostgresModelRequestRepository(
      db,
      this.runMutations,
      inputDelivery,
      domainJournal,
    )
    this.snapshots = new PostgresConversationSnapshotRepository(db)
    this.sessions = new PostgresSessionRepository(db)
    this.threads = new PostgresThreadRepository(db, this.runMutations)
    this.runs = new PostgresRunRepository(
      db,
      this.runMutations,
      this.runRecords,
      domainJournal,
      inputDelivery,
    )
    this.objectReferences = new PostgresObjectReferenceRepository(db)
    this.approvals = new PostgresApprovalRepository(db, this.runMutations)
  }

  async loadSnapshot(): Promise<ConversationSnapshot> {
    return this.snapshots.loadSnapshot()
  }

  async saveSession(session: SessionRecord): Promise<void> {
    await this.sessions.saveSession(session)
  }

  async createThreadLifecycle(thread: AgentThreadRecord): Promise<ThreadLifecycleResult> {
    return this.threads.createThreadLifecycle(thread)
  }

  async saveThread(thread: AgentThreadRecord): Promise<void> {
    await this.threads.saveThread(thread)
  }

  async trashThread(
    thread: AgentThreadRecord,
    purgeAfter: string,
    replacementThreadId: string | null,
  ): Promise<TrashThreadLifecycleResult> {
    return this.threads.trashThread(thread, purgeAfter, replacementThreadId)
  }

  async listTrash(sessionId: string): Promise<DeletedThreadRecord[]> {
    return this.threads.listTrash(sessionId)
  }

  async getTrashedThread(threadId: string): Promise<DeletedThreadRecord> {
    return this.threads.getTrashedThread(threadId)
  }

  async restoreThread(threadId: string, sessionId: string): Promise<ThreadLifecycleResult> {
    return this.threads.restoreThread(threadId, sessionId)
  }

  async purgeThread(threadId: string, sessionId: string): Promise<SessionRecord> {
    return this.threads.purgeThread(threadId, sessionId)
  }

  async createRunLifecycle(run: AnalysisRun): Promise<RunLifecycleResult> {
    return this.runs.createRunLifecycle(run)
  }

  async saveRun(run: AnalysisRun): Promise<void> {
    await this.runs.saveRun(run)
  }

  async saveRunWithModelUsage(run: AnalysisRun, modelTokens: number): Promise<void> {
    await this.runs.saveRunWithModelUsage(run, modelTokens)
  }

  async saveRunWithCheckpoint(
    run: AnalysisRun,
    fields: Partial<Pick<RunCheckpoint, 'activeEntryId' | 'pendingToolCallIds' | 'recoveryStatus'>>,
  ): Promise<void> {
    await this.runs.saveRunWithCheckpoint(run, fields)
  }

  async listRunsForThread(threadId: string): Promise<AnalysisRun[]> {
    return this.runs.listRunsForThread(threadId)
  }

  async saveRunCheckpoint(
    runId: string,
    fields: Partial<Pick<RunCheckpoint, 'activeEntryId' | 'pendingToolCallIds' | 'recoveryStatus'>>,
  ): Promise<void> {
    await this.runs.saveRunCheckpoint(runId, fields)
  }

  async getRunCheckpoint(runId: string): Promise<RunCheckpoint> {
    return this.runs.getRunCheckpoint(runId)
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
    return this.runs.saveAgentsSdkCheckpoint(runId, input)
  }

  async appendConversationItem(item: ConversationItem): Promise<void> {
    await this.runs.appendConversationItem(item)
  }

  async listConversationItems(runId: string): Promise<ConversationItem[]> {
    return this.runs.listConversationItems(runId)
  }

  async appendRunEvent(event: RunEvent): Promise<void> {
    await this.runs.appendRunEvent(event)
  }

  async listRunEvents(runId: string): Promise<RunEvent[]> {
    return this.runs.listRunEvents(runId)
  }

  async loadRunPresentation(runId: string): Promise<RunPresentationProjection> {
    return this.runs.loadRunPresentation(runId)
  }

  async appendToolValue(runId: string, value: ToolValueRef): Promise<void> {
    await this.runs.appendToolValue(runId, value)
  }

  async commitToolResult(
    run: AnalysisRun,
    resultId: string,
    invocation: ToolInvocationEffectCommit,
    values: readonly ToolValueRef[],
    artifacts: readonly ArtifactRef[],
  ): Promise<ToolEffectCommitResult> {
    return this.runs.commitToolResult(run, resultId, invocation, values, artifacts)
  }

  prepareToolInvocation(invocation: ToolInvocationRecord): Promise<ToolInvocationRecord> {
    return this.runs.prepareToolInvocation(invocation)
  }

  getToolInvocation(runId: string, callId: string): Promise<ToolInvocationRecord | null> {
    return this.runs.getToolInvocation(runId, callId)
  }

  listToolInvocations(runId: string): Promise<ToolInvocationRecord[]> {
    return this.runs.listToolInvocations(runId)
  }

  startToolInvocation(input: StartToolInvocationInput): Promise<ToolInvocationRecord> {
    return this.runs.startToolInvocation(input)
  }

  terminateToolInvocation(input: TerminalToolInvocationInput): Promise<ToolInvocationRecord> {
    return this.runs.terminateToolInvocation(input)
  }

  prepareApprovalRecord(record: ApprovalRecord): Promise<ApprovalRecord> {
    return this.approvals.prepareApprovalRecord(record)
  }

  getApprovalRecord(approvalId: string): Promise<ApprovalRecord | null> {
    return this.approvals.getApprovalRecord(approvalId)
  }

  getApprovalRecordForCall(runId: string, callId: string): Promise<ApprovalRecord | null> {
    return this.approvals.getApprovalRecordForCall(runId, callId)
  }

  listApprovalRecords(runId: string): Promise<ApprovalRecord[]> {
    return this.approvals.listApprovalRecords(runId)
  }

  findSessionApproval(sessionId: string, actionKey: string): Promise<ApprovalRecord | null> {
    return this.approvals.findSessionApproval(sessionId, actionKey)
  }

  resolveApprovalRecord(input: ResolveApprovalRecordInput): Promise<ApprovalRecord> {
    return this.approvals.resolveApprovalRecord(input)
  }

  consumeApprovalRecord(input: ConsumeApprovalRecordInput): Promise<ApprovalRecord> {
    return this.approvals.consumeApprovalRecord(input)
  }

  async listToolValues(runId: string): Promise<ToolValueRef[]> {
    return this.runs.listToolValues(runId)
  }

  async getThreadManifest(threadId: string): Promise<ThreadManifest> {
    return this.threads.getThreadManifest(threadId)
  }

  async saveThreadMemoryVersion(input: {
    threadId: string
    expectedVersion: number
    version: number
    contentHash: string
    source: ThreadMemoryDocument['source']
    basedOnEntryId: string | null
    estimatedTokens: number
    createdAt: string
  }): Promise<ThreadMemoryVersionReference> {
    return this.threads.saveThreadMemoryVersion(input)
  }

  async getLatestThreadMemoryVersion(threadId: string): Promise<ThreadMemoryVersionReference | null> {
    return this.threads.getLatestThreadMemoryVersion(threadId)
  }

  async appendCompaction(record: CompactionRecord): Promise<void> {
    await this.threads.appendCompaction(record)
  }

  async listCompactions(threadId: string): Promise<CompactionRecord[]> {
    return this.threads.listCompactions(threadId)
  }

  async listReferencedObjectHashes(): Promise<string[]> {
    return this.objectReferences.listReferencedObjectHashes()
  }

  async appendConversationEntry(input: AppendConversationEntryInput): Promise<TranscriptEntry> {
    return this.threads.appendConversationEntry(input)
  }

  async readThreadHistory(threadId: string, cursor?: string | null, limit = 100): Promise<ThreadHistoryPage> {
    return this.threads.readThreadHistory(threadId, cursor, limit)
  }

  async readActiveConversation(threadId: string, leafEntryId?: string | null): Promise<TranscriptEntry[]> {
    return this.threads.readActiveConversation(threadId, leafEntryId)
  }

  async forkConversation(
    sourceThreadId: string,
    targetThreadId: string,
    sourceEntryId: string,
    lastNTurns?: number | null,
  ): Promise<Map<string, string>> {
    return this.threads.forkConversation(sourceThreadId, targetThreadId, sourceEntryId, lastNTurns)
  }

  async enqueueRunInput(input: EnqueueRunInput): Promise<RunSteeringRecord> {
    return this.runInputs.enqueueRunInput(input)
  }

  async leaseRunInputs(runId: string, leaseId: string): Promise<RunSteeringRecord[]> {
    return this.runInputs.leaseRunInputs(runId, leaseId)
  }

  async getRunInput(runId: string, inputId: string): Promise<RunSteeringRecord | null> {
    return this.runInputs.getRunInput(runId, inputId)
  }

  async requeueLeasedRunInputs(runId: string): Promise<RunSteeringRecord[]> {
    return this.runInputs.requeueLeasedRunInputs(runId)
  }

  async listRunInputs(runId: string): Promise<RunSteeringRecord[]> {
    return this.runInputs.listRunInputs(runId)
  }

  async tryClaimTerminalInput(input: {
    runId: string
    claimId: string
    objectiveRevision: number
    inputCursor: number
  }): Promise<boolean> {
    return this.runInputs.tryClaimTerminalInput(input)
  }

  async commitModelRequest(input: CommitModelRequestInput): Promise<CommitModelRequestResult> {
    return this.modelRequests.commitModelRequest(input)
  }

  async getModelRequest(requestId: string): Promise<ModelRequestRecord | null> {
    return this.modelRequests.getModelRequest(requestId)
  }

  async getActiveModelRequest(runId: string): Promise<ModelRequestRecord | null> {
    return this.modelRequests.getActiveModelRequest(runId)
  }

  async listModelRequests(runId: string): Promise<ModelRequestRecord[]> {
    return this.modelRequests.listModelRequests(runId)
  }

  appendRunDomainEvents(input: {
    runId: string
    expectedSequence: number
    events: readonly RunDomainEvent[]
  }): Promise<RunDomainSnapshot> {
    return this.domainJournal.appendRunDomainEvents(input)
  }

  getRunDomainSnapshot(runId: string): Promise<RunDomainSnapshot | null> {
    return this.domainJournal.getRunDomainSnapshot(runId)
  }

  listRunDomainEvents(runId: string, afterSequence = 0): Promise<RunDomainEvent[]> {
    return this.domainJournal.listRunDomainEvents(runId, afterSequence)
  }

  inspectRunDomainProjection(runId: string): Promise<RunDomainProjectionInspection> {
    return this.domainJournal.inspectRunDomainProjection(runId)
  }


}
