// +-------------------------------------------------------------------------
//
//   地理智能平台 - 平台持久化门面
//
//   文件:       platformPersistenceFacade.ts
//
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { Database } from '../db/connection.js'
import type {
SessionRecord,AgentThreadRecord,AnalysisRun,RunSummary,AgentState,AgentRunProfile,
RunEvent,ConversationItem,AgentRuntimeConfig,ArtifactRef,ContentRef,ContextReference,
RunCheckpoint,RunGoalInput,RunSteeringRecord,TranscriptEntry,TranscriptEntryKind,ThreadManifest,
ThreadMemoryDocument,CompactionRecord,ToolValueRef,MeteorologicalDatasetRecord,
ModelRequestRecord,
RunDomainProjectionInspection,
} from '../schemas/types.js'
import type { ToolInvocationRecord } from '@geo-agent-platform/shared-types/tool-runtime'
import type { ApprovalRecord } from '@geo-agent-platform/shared-types/approval-runtime'
import type { ConversationItemStoreUpdate } from '../conversation/itemUpdates.js'
import { ArtifactStore,type VisibleArtifactOptions } from './artifactStore.js'
import { ConversationProjectionIndex } from './conversationProjectionIndex.js'
import { ContentObjectGateway } from './contentObjectGateway.js'
import { ObjectPublicationCoordinator } from './objectPublicationCoordinator.js'
import { ConversationPayloadStore } from './conversationPayloadStore.js'
import { RunStore } from './runStore.js'
import { DEFAULT_SESSION_ID,SessionStore,type ResourceOwner } from './sessionStore.js'
import { ThreadStore } from './threadStore.js'
import { RuntimeFileStore } from './fileStore.js'
import type { FileLifecyclePort } from './fileLifecycleService.js'
import path from 'node:path'
import { ArtifactPublicationRepository } from './postgres/artifactPublicationRepository.js'
import type {
ArtifactRepository,
VisibleArtifactResource,
} from './postgres/artifactRepository.js'
import { MeteorologicalStore } from './postgres/meteorologicalStore.js'
import { RuntimeConfigStore } from './postgres/runtimeConfigStore.js'
import { ToolCatalogStore } from './postgres/toolCatalogStore.js'
import { AutomationStore } from './postgres/automationStore.js'
import { CustomProviderStore } from './postgres/customProviderStore.js'
import { PostgresChildRunRepository } from './postgres/childRunRepository.js'
import { PlatformEventHub } from './platformEventHub.js'
import {
PostgresConversationPersistence,
} from './postgres/conversationPersistence.js'
import type {
ConversationPersistence,
ApprovalRepository,
ConsumeApprovalRecordInput,
ConversationSnapshotRepository,
DeletedThreadRecord,
RunInputRepository,
RunDomainJournalRepository,
ResolveApprovalRecordInput,
StartToolInvocationInput,
TerminalToolInvocationInput,
ToolEffectCommitResult,
ToolInvocationEffectCommit,
} from './postgres/conversationPersistencePorts.js'

export type { ResourceOwner } from './sessionStore.js'

export class PlatformPersistenceFacade {
  static readonly DEFAULT_SESSION_ID = DEFAULT_SESSION_ID

  readonly payloadStoreRoot: string
  readonly runtimeRoot: string
  readonly runtimeFiles: RuntimeFileStore
  readonly fileLifecycle: FileLifecyclePort
  readonly meteorology: MeteorologicalStore
  readonly runtimeConfiguration: RuntimeConfigStore
  readonly toolCatalog: ToolCatalogStore
  readonly automations: AutomationStore
  readonly customProviders: CustomProviderStore
  readonly childRuns: PostgresChildRunRepository

  private readonly index = new ConversationProjectionIndex()
  private readonly payloadStore: ConversationPayloadStore
  private readonly sessionStore: SessionStore
  private readonly threadStore: ThreadStore
  private readonly runStore: RunStore
  private readonly artifactStore: ArtifactStore
  private readonly objectStore: ContentObjectGateway
  private readonly snapshotRepository: ConversationSnapshotRepository
  private readonly runInputRepository: RunInputRepository
  private readonly runDomainJournal: RunDomainJournalRepository
  private readonly objectPublication: ObjectPublicationCoordinator
  private readonly approvals: ApprovalRepository

  constructor(db: Database, storageRoot: string, options: {
    conversationPersistence?: ConversationPersistence
    artifactRepository?: ArtifactRepository
    events?: PlatformEventHub
    runtimeFiles?: RuntimeFileStore
    fileLifecycle: FileLifecyclePort
    objectPublication?: ObjectPublicationCoordinator
  }) {
    const events = options.events ?? new PlatformEventHub()
    this.payloadStoreRoot = storageRoot
    this.runtimeRoot = ['sessions', 'conversations'].includes(path.basename(storageRoot))
      ? path.dirname(storageRoot)
      : storageRoot
    this.objectPublication = options.objectPublication ?? new ObjectPublicationCoordinator()
    this.runtimeFiles = options.runtimeFiles ?? new RuntimeFileStore(this.runtimeRoot)
    this.fileLifecycle = options.fileLifecycle
    this.payloadStore = new ConversationPayloadStore(storageRoot)
    const persistence = options.conversationPersistence ?? new PostgresConversationPersistence(db)
    this.snapshotRepository = persistence
    this.runInputRepository = persistence
    this.runDomainJournal = persistence
    this.approvals = persistence
    this.sessionStore = new SessionStore(this.index, persistence)
    this.threadStore = new ThreadStore(
      this.index,
      this.payloadStore,
      this.sessionStore,
      {
        lifecycle: persistence,
        transcript: persistence,
        memory: persistence,
        compactions: persistence,
      },
      persistence,
      persistence,
      this.fileLifecycle,
      {
        threadUpdateBus: events.threadUpdates,
        threadEntryBus: events.threadEntries,
        threadCompactionBus: events.threadCompactions,
        threadMemoryBus: events.threadMemories,
      },
      this.objectPublication,
    )
    this.runStore = new RunStore(
      this.index,
      this.payloadStore,
      this.sessionStore,
      persistence,
      persistence,
      {
        runBus: events.runs,
        eventBus: events.runEvents,
        itemBus: events.conversationItems,
        itemUpsertBus: events.conversationItemUpserts,
        itemDeltaBus: events.conversationItemDeltas,
      },
      this.objectPublication,
    )
    this.artifactStore = new ArtifactStore(
      this.index,
      options.artifactRepository ?? new ArtifactPublicationRepository(db),
      this.runtimeRoot,
    )
    this.objectStore = new ContentObjectGateway(this.payloadStore)
    this.meteorology = new MeteorologicalStore(db)
    this.runtimeConfiguration = new RuntimeConfigStore(db)
    this.toolCatalog = new ToolCatalogStore(db)
    this.automations = new AutomationStore(db)
    this.customProviders = new CustomProviderStore(db)
    this.childRuns = new PostgresChildRunRepository(db)
  }

  // --- Sessions ---

  async initialize(): Promise<void> {
    const snapshot = await this.snapshotRepository.loadSnapshot()
    // PostgreSQL 决定有哪些 session/thread/run；文件层只按该快照定位 checkpoint 与大对象。
    await this.payloadStore.initialize(snapshot)
    this.index.load(snapshot)
    await this.runStore.recoverOrphanedRuns()
  }

  async createSession(owner?: ResourceOwner | null): Promise<SessionRecord> {
    return this.sessionStore.create(owner)
  }

  async getOrCreateUserDefaultSession(owner: ResourceOwner): Promise<SessionRecord> {
    return this.sessionStore.getOrCreateUserDefault(owner)
  }

  async getOrCreateDefaultSession(): Promise<SessionRecord> {
    return this.sessionStore.getOrCreateDefault()
  }

  getSession(sessionId: string): SessionRecord {
    return this.sessionStore.get(sessionId)
  }

  async updateSession(sessionId: string, fields: Partial<SessionRecord>): Promise<SessionRecord> {
    return this.sessionStore.update(sessionId, fields)
  }

  async createMeteorologicalDataset(dataset: MeteorologicalDatasetRecord): Promise<void> {
    const session = await this.meteorology.createMeteorologicalDataset(dataset)
    this.sessionStore.acceptPersisted(session)
  }

  async persistArtifact(artifact: ArtifactRef): Promise<void> {
    await this.artifactStore.persist(artifact)
  }

  async commitToolResult(
    runId: string,
    resultId: string,
    mutation: (state: AgentState) => Partial<AgentState>,
    invocation: ToolInvocationEffectCommit,
    values: readonly ToolValueRef[],
    artifacts: readonly ArtifactRef[],
  ): Promise<ToolEffectCommitResult> {
    return this.runStore.commitToolResult(runId, resultId, mutation, invocation, values, artifacts)
  }

  inspectRunDomainProjection(runId: string): Promise<RunDomainProjectionInspection> {
    this.runStore.get(runId)
    return this.runDomainJournal.inspectRunDomainProjection(runId)
  }

  prepareToolInvocation(invocation: ToolInvocationRecord): Promise<ToolInvocationRecord> {
    return this.runStore.prepareToolInvocation(invocation)
  }

  getToolInvocation(runId: string, callId: string): Promise<ToolInvocationRecord | null> {
    return this.runStore.getToolInvocation(runId, callId)
  }

  listToolInvocations(runId: string): Promise<ToolInvocationRecord[]> {
    return this.runStore.listToolInvocations(runId)
  }

  startToolInvocation(input: StartToolInvocationInput): Promise<ToolInvocationRecord> {
    return this.runStore.startToolInvocation(input)
  }

  terminateToolInvocation(input: TerminalToolInvocationInput): Promise<ToolInvocationRecord> {
    return this.runStore.terminateToolInvocation(input)
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

  async listArtifactsVisibleToRun(
    runId: string,
    options: VisibleArtifactOptions = {},
  ): Promise<VisibleArtifactResource[]> {
    return this.artifactStore.listVisibleToRun(runId, options)
  }

  // --- Threads ---

  listThreadsForSession(sessionId: string): AgentThreadRecord[] {
    return this.threadStore.listForSession(sessionId)
  }

  async createThread(sessionId: string, title?: string | null): Promise<AgentThreadRecord> {
    return this.threadStore.create(sessionId, title)
  }

  getThread(threadId: string): AgentThreadRecord {
    return this.threadStore.get(threadId)
  }

  async updateThread(threadId: string, fields: Partial<AgentThreadRecord>): Promise<AgentThreadRecord> {
    return this.threadStore.update(threadId, fields)
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.threadStore.delete(threadId)
  }

  // --- Runs ---

  listRunsForSession(sessionId: string): AnalysisRun[] {
    return this.runStore.listForSession(sessionId)
  }

  listRunsForThread(threadId: string): AnalysisRun[] {
    return this.runStore.listForThread(threadId)
  }

  listRunsForWorkspace(workspaceId: string): AnalysisRun[] {
    return this.runStore.listForWorkspace(workspaceId)
  }

  listRunSummaries(options: {
    sessionId: string
    threadId?: string | null
    cursor?: string | null
    limit?: number
  }): { items: RunSummary[]; nextCursor: string | null } {
    return this.runStore.listSummaries(options)
  }

  getRun(runId: string): AnalysisRun {
    return this.runStore.get(runId)
  }

  async createRun(sessionId: string, query: string, opts?: {
    threadId?: string | null; modelProvider?: string | null; modelName?: string | null
    runProfile?: AgentRunProfile
    goal?: RunGoalInput | null
    runtimeConfigSnapshot?: AgentRuntimeConfig | null
    contextReferences?: ContextReference[]
    childIdentity?: {
      rootRunId: string
      parentRunId: string
      parentTurnId: string
      rootTurnId: string
      spawnCallId: string
      agentPath: string
      taskName: string
      agentRole: string
      spawnDepth: number
      forkMode: 'none' | 'full_history' | 'last_n_turns'
      forkTurnCount: number | null
      modelOverride: string | null
      reasoningOverride: string | null
      maxModelTokens: number | null
      maxWallClockMs: number | null
    }
  }): Promise<AnalysisRun> {
    return this.runStore.create(sessionId, query, opts)
  }

  async updateRunState(runId: string, updates: Partial<AgentState>): Promise<AnalysisRun> {
    return this.runStore.updateState(runId, updates)
  }

  async mutateRunState(
    runId: string,
    mutation: (state: AgentState) => Partial<AgentState>,
  ): Promise<AnalysisRun> {
    return this.runStore.mutateState(runId, mutation)
  }

  async updateRunStatus(runId: string, status: AnalysisRun['status']): Promise<AnalysisRun> {
    return this.runStore.updateStatus(runId, status)
  }

  async completeRun(runId: string, status: string): Promise<AnalysisRun> {
    return this.runStore.complete(runId, status)
  }

  // --- payloadStore 窄封装 ---
  //
  // agent runtime、toolExecutionCoordinator、contextManager、resultPersistence
  // 只应通过这些封装方法访问底层文件载荷；它们不应直接引用 payloadStore。
  // 具体资源写入由 SessionStore / ThreadStore / RunStore 拥有，facade 只保留跨域组合 API。

  async saveRunCheckpoint(
    runId: string,
    fields: Partial<Pick<RunCheckpoint, 'activeEntryId' | 'pendingToolCallIds' | 'recoveryStatus'>> = {},
  ): Promise<void> {
    await this.runStore.saveCheckpoint(runId, fields)
  }

  async getRunCheckpoint(runId: string): Promise<RunCheckpoint> {
    return this.runStore.getCheckpoint(runId)
  }

  async appendAgentTranscript(
    runId: string,
    agentId: string,
    record: Record<string, unknown>,
  ): Promise<void> {
    await this.runStore.appendAgentTranscript(runId, agentId, record)
  }

  async saveAgentsSdkCheckpointEnvelope(
    runId: string,
    serializedEnvelope: string,
    metadata: {
      agentsSdkVersion: string
      runtimeConfigDigest: string
      inputLeaseId?: string | null
      terminalToolCallIds?: readonly string[]
      checkpointModelRequestStepId?: string | null
    },
  ): Promise<RunSteeringRecord[]> {
    return this.runStore.saveAgentsSdkCheckpointEnvelope(runId, serializedEnvelope, metadata)
  }

  async readAgentsSdkCheckpointEnvelope(runId: string): Promise<string> {
    return this.runStore.readAgentsSdkCheckpointEnvelope(runId)
  }

  async publishModelRequestSnapshot(
    serializedRequest: string,
    input: Omit<ModelRequestRecord, 'inputObjectHash' | 'inputEntryIds'>,
  ): Promise<{ record: ModelRequestRecord; includedInputs: RunSteeringRecord[] }> {
    return this.runStore.publishModelRequestSnapshot(serializedRequest, input)
  }

  async readModelRequestSnapshot(record: ModelRequestRecord): Promise<string> {
    return this.runStore.readModelRequestSnapshot(record)
  }

  async getActiveModelRequest(runId: string): Promise<ModelRequestRecord | null> {
    return this.runStore.getActiveModelRequest(runId)
  }

  async listModelRequests(runId: string): Promise<ModelRequestRecord[]> {
    return this.runStore.listModelRequests(runId)
  }

  async putConversationObject(
    content: string | Uint8Array,
    mediaType = 'application/octet-stream',
  ): Promise<ContentRef> {
    return this.objectStore.put(content, mediaType)
  }

  async publishConversationObject<T>(
    content: string | Uint8Array,
    mediaType: string,
    commitReference: (reference: ContentRef) => Promise<T>,
  ): Promise<T> {
    return this.objectPublication.publish(async () => {
      const reference = await this.objectStore.put(content, mediaType)
      return commitReference(reference)
    })
  }

  async readConversationObject(reference: ContentRef): Promise<Uint8Array> {
    return this.objectStore.read(reference)
  }

  async appendToolValue(runId: string, value: ToolValueRef): Promise<void> {
    await this.runStore.appendToolValue(runId, value)
  }

  async flushConversationStore(): Promise<void> {
    await this.objectStore.flush()
  }

  async closeConversationStore(): Promise<void> {
    await this.payloadStore.close()
  }

  getPayloadStoreRoot(): string {
    return this.payloadStoreRoot
  }

  // --- Events & Items ---

  async appendEvent(runId: string, event: RunEvent): Promise<void> {
    await this.runStore.appendEvent(runId, event)
  }

  async listEvents(runId: string): Promise<RunEvent[]> {
    return this.runStore.listEvents(runId)
  }

  async appendItem(update: ConversationItemStoreUpdate): Promise<void> {
    await this.runStore.appendItem(update)
  }

  async projectPersistedItems(items: readonly ConversationItem[]): Promise<void> {
    await this.runStore.projectPersistedItems(items)
  }

  async enqueueRunInput(input: {
    inputId: string
    entryId: string
    itemId: string
    runId: string
    turnId: string
    content: string
  }): Promise<RunSteeringRecord> {
    return this.runInputRepository.enqueueRunInput(input)
  }

  async leaseRunInputs(runId: string, leaseId: string): Promise<RunSteeringRecord[]> {
    return this.runInputRepository.leaseRunInputs(runId, leaseId)
  }

  async getRunInput(runId: string, inputId: string): Promise<RunSteeringRecord | null> {
    return this.runInputRepository.getRunInput(runId, inputId)
  }

  async requeueLeasedRunInputs(runId: string): Promise<RunSteeringRecord[]> {
    return this.runInputRepository.requeueLeasedRunInputs(runId)
  }

  async listRunInputs(runId: string): Promise<RunSteeringRecord[]> {
    return this.runInputRepository.listRunInputs(runId)
  }

  async tryClaimTerminalInput(input: {
    runId: string
    claimId: string
    objectiveRevision: number
    inputCursor: number
  }): Promise<boolean> {
    return this.runInputRepository.tryClaimTerminalInput(input)
  }

  async listItems(runId: string): Promise<ConversationItem[]> {
    return this.runStore.listItems(runId)
  }

  async listItemSnapshot(runId: string) {
    return this.runStore.listItemSnapshot(runId)
  }

  async listPresentationSnapshot(runId: string) {
    return this.runStore.listPresentationSnapshot(runId)
  }

  async getThreadManifest(threadId: string): Promise<ThreadManifest> {
    return this.threadStore.getManifest(threadId)
  }

  async listThreadHistory(threadId: string, cursor?: string | null, limit?: number) {
    return this.threadStore.listHistory(threadId, cursor, limit)
  }

  async activeTranscript(threadId: string, leafEntryId?: string | null): Promise<TranscriptEntry[]> {
    return this.threadStore.activeTranscript(threadId, leafEntryId)
  }

  async appendTranscript(input: {
    threadId: string
    runId?: string | null
    turnId?: string | null
    kind: TranscriptEntryKind
    payload?: Record<string, unknown>
    parentEntryId?: string | null
    logicalParentEntryId?: string | null
    entryId?: string
  }): Promise<TranscriptEntry> {
    return this.threadStore.appendTranscript(input)
  }

  async forkThread(
    sourceThreadId: string,
    sourceEntryId: string,
    title?: string | null,
    lastNTurns?: number | null,
  ): Promise<AgentThreadRecord> {
    return this.threadStore.fork(sourceThreadId, sourceEntryId, title, lastNTurns)
  }

  async getThreadMemory(threadId: string): Promise<ThreadMemoryDocument> {
    return this.threadStore.getMemory(threadId)
  }

  async updateThreadMemory(
    threadId: string,
    content: string,
    expectedVersion?: number,
    source: ThreadMemoryDocument['source'] = 'user',
    basedOnEntryId: string | null = null,
  ): Promise<ThreadMemoryDocument> {
    return this.threadStore.updateMemory(threadId, content, expectedVersion, source, basedOnEntryId)
  }

  async appendCompaction(record: CompactionRecord): Promise<void> {
    await this.threadStore.appendCompaction(record)
  }

  async listCompactions(threadId: string): Promise<CompactionRecord[]> {
    return this.threadStore.listCompactions(threadId)
  }

  async listTrash(sessionId: string): Promise<DeletedThreadRecord[]> {
    return this.threadStore.listTrash(sessionId)
  }

  async getTrashedThread(threadId: string): Promise<AgentThreadRecord> {
    return this.threadStore.getTrashed(threadId)
  }

  async restoreThread(threadId: string): Promise<AgentThreadRecord> {
    return this.threadStore.restore(threadId)
  }

  async purgeThread(threadId: string): Promise<void> {
    await this.threadStore.purge(threadId)
  }

  async recordAttachment(threadId: string, input: {
    id: string
    name: string
    contentHash: string
    mediaType: string
    sizeBytes: number
    relativePath: string
  }, action: 'attached' | 'deleted' = 'attached'): Promise<void> {
    await this.threadStore.recordAttachment(threadId, input, action)
  }
}
