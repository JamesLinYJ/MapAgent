// +-------------------------------------------------------------------------
//
//   地理智能平台 - 内存会话持久化测试替身
//
//   文件:       inMemoryConversationPersistence.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { isDeepStrictEqual } from 'node:util'
import {
  toolInvocationRecordSchema,
  type ToolInvocationRecord,
} from '@geo-agent-platform/shared-types/tool-runtime'
import {
  approvalRecordSchema,
  type ApprovalRecord,
} from '@geo-agent-platform/shared-types/approval-runtime'
import {
  RUN_PRESENTATION_PROJECTION_SCHEMA_VERSION,
  runPresentationProjectionSchema,
  type RunPresentationProjection,
} from '@geo-agent-platform/shared-types/run-presentation'

import {
  analysisRunSchema,
  compactionRecordSchema,
  conversationItemSchema,
  runCheckpointSchema,
  runEventSchema,
  runSteeringRecordSchema,
  modelRequestRecordSchema,
  reduceRunDomainEvents,
  runDomainEventSchema,
  threadManifestSchema,
  toolValueRefSchema,
  transcriptEntrySchema,
  type AgentThreadRecord,
  type AnalysisRun,
  type ArtifactRef,
  type CompactionRecord,
  type ConversationItem,
  type ModelRequestRecord,
  type RunEvent,
  type RunDomainCheckpoint,
  type RunDomainEvent,
  type RunDomainProjectionInspection,
  type RunDomainSnapshot,
  type RunCheckpoint,
  type RunSteeringRecord,
  type SessionRecord,
  type ThreadManifest,
  type ThreadMemoryDocument,
  type ToolValueRef,
  type TranscriptEntry,
} from '../src/schemas/types.js'
import type {
  AppendConversationEntryInput,
  ConversationPersistence,
  ConversationSnapshot,
  DeletedThreadRecord,
  EnqueueRunInput,
  CommitModelRequestInput,
  CommitModelRequestResult,
  ConsumeApprovalRecordInput,
  ResolveApprovalRecordInput,
  RunLifecycleResult,
  StartToolInvocationInput,
  TerminalToolInvocationInput,
  ToolEffectCommitResult,
  ToolInvocationEffectCommit,
  ToolResultCommitter,
  ThreadLifecycleResult,
  ThreadHistoryPage,
  ThreadMemoryVersionReference,
  TrashThreadLifecycleResult,
} from '../src/store/postgres/conversationPersistencePorts.js'
import { decodeHistoryCursor, encodeHistoryCursor, estimateTokens } from '../src/store/conversationEncoding.js'
import { makeId, nowUtc } from '../src/utils/ids.js'
import { summarizeAssistantText } from '../src/conversation/items.js'
import { MemoryVersionConflictError } from '../src/store/storeErrors.js'
import { runInputConversationItem } from '../src/store/runInputConversationItem.js'
import { RunDomainSequenceConflictError } from '../src/store/storeErrors.js'
import {
  assertRunDomainCheckpointProjection,
  assertRunDomainInputCollection,
  assertRunDomainInputProjection,
  assertRunDomainProjection,
  buildCheckpointChangedEvent,
  buildInputTransitionEvent,
  buildModelRequestCheckpointedEvent,
  buildModelRequestCommittedEvent,
  buildTerminalCandidateSupersededEvent,
  buildTerminalClaimedEvent,
  buildRunCreatedEvents,
  buildRunTransitionEvents,
  inspectRunDomainProjection as inspectDomainProjection,
} from '../src/store/runDomainProjection.js'

interface ThreadState {
  record: AgentThreadRecord
  activeLeafEntryId: string | null
  nextEntrySequence: number
  transcriptEntryCount: number
  estimatedContextTokens: number
  latestCompactionId: string | null
  memoryVersion: number
  memoryBasedOnTokens: number
  forkedFromThreadId: string | null
  forkedFromEntryId: string | null
  quarantined: boolean
  quarantineReason: string | null
  deletedAt: string | null
  purgeAfter: string | null
}

type CheckpointMetadata = Omit<RunCheckpoint, 'run'>

// 仅用于单元测试的明确端口替身。它模拟 PostgreSQL Repository 的领域语义，
// 不进入生产 container，也不让生产代码识别残缺的假 Database。
export class InMemoryConversationPersistence implements ConversationPersistence, ToolResultCommitter {
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly threads = new Map<string, ThreadState>()
  private readonly runs = new Map<string, AnalysisRun>()
  private readonly checkpoints = new Map<string, CheckpointMetadata>()
  private readonly entries = new Map<string, TranscriptEntry[]>()
  private readonly items = new Map<string, ConversationItem[]>()
  private readonly events = new Map<string, RunEvent[]>()
  private readonly values = new Map<string, ToolValueRef[]>()
  private readonly committedToolResults = new Set<string>()
  private readonly toolInvocations = new Map<string, ToolInvocationRecord>()
  private readonly approvalRecords = new Map<string, ApprovalRecord>()
  private readonly inputs = new Map<string, RunSteeringRecord[]>()
  private readonly modelRequests = new Map<string, ModelRequestRecord>()
  private readonly memoryVersions = new Map<string, ThreadMemoryVersionReference[]>()
  private readonly compactions = new Map<string, CompactionRecord[]>()
  private readonly domainEvents = new Map<string, RunDomainEvent[]>()
  private readonly domainSnapshots = new Map<string, RunDomainSnapshot>()

  async loadSnapshot(): Promise<ConversationSnapshot> {
    const activeThreadIds = new Set(
      [...this.threads.values()].filter(state => state.record.status !== 'deleted').map(state => state.record.id),
    )
    return clone({
      sessions: [...this.sessions.values()],
      threads: [...this.threads.values()].map(state => state.record).filter(thread => thread.status !== 'deleted'),
      deletedThreads: [...this.threads.values()]
        .filter(state => state.record.status === 'deleted')
        .map(state => this.deletedThreadRecord(state)),
      runs: [...this.runs.values()].filter(run => run.threadId === null || activeThreadIds.has(run.threadId)),
    })
  }

  async saveSession(session: SessionRecord): Promise<void> {
    this.sessions.set(session.id, clone(session))
  }

  async createThreadLifecycle(thread: AgentThreadRecord): Promise<ThreadLifecycleResult> {
    const session = this.sessions.get(thread.sessionId)
    if (!session || session.status !== 'active') throw new Error(`会话 '${thread.sessionId}' 不存在或不可用`)
    if (this.threads.has(thread.id)) throw new Error(`线程 '${thread.id}' 已存在`)
    assertThreadOwnerMatchesSession(thread, session)
    const state = createThreadState(thread)
    this.threads.set(thread.id, state)
    const updatedSession = { ...session, latestThreadId: thread.id }
    this.sessions.set(session.id, updatedSession)
    return clone({
      session: updatedSession,
      thread,
      manifest: this.threadManifest(state),
    })
  }

  async saveThread(thread: AgentThreadRecord): Promise<void> {
    if (thread.status === 'deleted') {
      throw new Error('删除线程必须使用 trashThread，以保证回收站时间元数据完整')
    }
    const current = this.threads.get(thread.id)
    if (!current || current.record.status === 'deleted') throw new Error(`线程 '${thread.id}' 不存在`)
    this.threads.set(thread.id, {
      record: clone(thread),
      activeLeafEntryId: current.activeLeafEntryId,
      nextEntrySequence: current.nextEntrySequence,
      transcriptEntryCount: current.transcriptEntryCount,
      estimatedContextTokens: current.estimatedContextTokens,
      latestCompactionId: current.latestCompactionId,
      memoryVersion: current.memoryVersion,
      memoryBasedOnTokens: current.memoryBasedOnTokens,
      forkedFromThreadId: current.forkedFromThreadId,
      forkedFromEntryId: current.forkedFromEntryId,
      quarantined: current.quarantined,
      quarantineReason: current.quarantineReason,
      deletedAt: null,
      purgeAfter: null,
    })
  }

  async trashThread(
    thread: AgentThreadRecord,
    purgeAfter: string,
    replacementThreadId: string | null,
  ): Promise<TrashThreadLifecycleResult> {
    const state = this.requireThread(thread.id)
    if (state.record.status === 'deleted') throw new Error(`线程 '${thread.id}' 不存在`)
    const session = this.sessions.get(thread.sessionId)
    if (!session) throw new Error(`会话 '${thread.sessionId}' 不存在`)
    const replacement = replacementThreadId ? this.requireThread(replacementThreadId) : null
    if (replacement && (replacement.record.sessionId !== thread.sessionId || replacement.record.status === 'deleted')) {
      throw new Error(`替代线程 '${replacementThreadId}' 不存在或不属于当前会话`)
    }
    state.record = clone(thread)
    state.deletedAt = thread.updatedAt
    state.purgeAfter = purgeAfter
    const latestRun = session.latestRunId ? this.runs.get(session.latestRunId) ?? null : null
    const updatedSession: SessionRecord = {
      ...session,
      latestThreadId: session.latestThreadId === thread.id
        ? replacement?.record.id ?? null
        : session.latestThreadId,
      latestRunId: latestRun?.threadId === thread.id
        ? replacement?.record.latestRunId ?? null
        : session.latestRunId,
    }
    this.sessions.set(session.id, updatedSession)
    return clone({ session: updatedSession, deleted: this.deletedThreadRecord(state) })
  }

  async listTrash(sessionId: string): Promise<DeletedThreadRecord[]> {
    return clone([...this.threads.values()]
      .filter(state => state.record.sessionId === sessionId && state.record.status === 'deleted')
      .sort((left, right) => (right.deletedAt ?? '').localeCompare(left.deletedAt ?? ''))
      .map(state => this.deletedThreadRecord(state)))
  }

  async getTrashedThread(threadId: string): Promise<DeletedThreadRecord> {
    const state = this.requireThread(threadId)
    if (state.record.status !== 'deleted') throw new Error(`回收站线程 '${threadId}' 不存在`)
    return clone(this.deletedThreadRecord(state))
  }

  async restoreThread(threadId: string, sessionId: string): Promise<ThreadLifecycleResult> {
    const state = this.requireThread(threadId)
    if (state.record.status !== 'deleted' || state.record.sessionId !== sessionId) {
      throw new Error(`回收站线程 '${threadId}' 不存在`)
    }
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`会话 '${sessionId}' 不存在`)
    state.record = { ...state.record, status: 'active', updatedAt: nowUtc() }
    state.deletedAt = null
    state.purgeAfter = null
    const updatedSession: SessionRecord = {
      ...session,
      latestThreadId: session.latestThreadId ?? threadId,
      latestRunId: session.latestRunId ?? state.record.latestRunId,
    }
    this.sessions.set(sessionId, updatedSession)
    return clone({ session: updatedSession, thread: state.record, manifest: this.threadManifest(state) })
  }

  async purgeThread(threadId: string, sessionId: string): Promise<SessionRecord> {
    const state = this.requireThread(threadId)
    if (state.record.status !== 'deleted' || state.record.sessionId !== sessionId) {
      throw new Error(`回收站线程 '${threadId}' 不存在`)
    }
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`会话 '${sessionId}' 不存在`)
    const latestRunBelongsToThread = session.latestRunId
      ? this.runs.get(session.latestRunId)?.threadId === threadId
      : false
    this.threads.delete(threadId)
    this.entries.delete(threadId)
    this.memoryVersions.delete(threadId)
    this.compactions.delete(threadId)
    for (const [runId, run] of this.runs) {
      if (run.threadId !== threadId) continue
      this.runs.delete(runId)
      this.checkpoints.delete(runId)
      this.items.delete(runId)
      this.events.delete(runId)
      this.values.delete(runId)
      this.inputs.delete(runId)
      for (const [key, invocation] of this.toolInvocations) {
        if (invocation.runId === runId) this.toolInvocations.delete(key)
      }
      for (const [approvalId, approval] of this.approvalRecords) {
        if (approval.runId === runId) this.approvalRecords.delete(approvalId)
      }
      this.domainEvents.delete(runId)
      this.domainSnapshots.delete(runId)
    }
    const updatedSession: SessionRecord = {
      ...session,
      latestThreadId: session.latestThreadId === threadId ? null : session.latestThreadId,
      latestRunId: latestRunBelongsToThread ? null : session.latestRunId,
    }
    this.sessions.set(sessionId, updatedSession)
    return clone(updatedSession)
  }

  async createRunLifecycle(run: AnalysisRun): Promise<RunLifecycleResult> {
    const session = this.sessions.get(run.sessionId)
    if (!session || session.status !== 'active') throw new Error(`会话 '${run.sessionId}' 不存在或不可用`)
    if (this.runs.has(run.id)) throw new Error(`运行 '${run.id}' 已存在`)
    const thread = run.threadId ? this.requireThread(run.threadId) : null
    if (thread) {
      if (thread.record.sessionId !== run.sessionId || thread.record.status === 'deleted') {
        throw new Error(`线程 '${run.threadId}' 不存在或不属于当前会话`)
      }
      assertRunOwnerMatchesThread(run, thread.record)
    } else {
      assertRunOwnerMatchesSession(run, session)
    }
    this.runs.set(run.id, clone(run))
    this.checkpoints.set(run.id, initialCheckpoint(run.updatedAt))
    const checkpoint = memoryDomainCheckpoint(this.requireCheckpoint(run.id))
    const domainSnapshot = this.appendDomainEvents({
      runId: run.id,
      expectedSequence: 0,
      events: buildRunCreatedEvents(run, checkpoint, 0),
    })
    assertRunDomainProjection(domainSnapshot, run)
    assertRunDomainCheckpointProjection(domainSnapshot, checkpoint)
    let updatedThread: AgentThreadRecord | null = null
    if (thread) {
      updatedThread = {
        ...thread.record,
        latestRunId: run.id,
        latestUserQuery: run.userQuery,
        latestRunStatus: run.status,
        runCount: thread.record.runCount + 1,
        updatedAt: run.updatedAt,
      }
      thread.record = updatedThread
    }
    const updatedSession: SessionRecord = {
      ...session,
      latestRunId: run.id,
      latestThreadId: updatedThread?.id ?? session.latestThreadId,
    }
    this.sessions.set(session.id, updatedSession)
    return clone({ session: updatedSession, thread: updatedThread, run })
  }

  async saveRun(run: AnalysisRun): Promise<void> {
    const before = clone(this.requireRun(run.id))
    if (run.usedModelTokens !== before.usedModelTokens) {
      throw new Error(`运行 '${run.id}' 的模型词元只能通过用量事务推进`)
    }
    const current = this.requireDomainSnapshot(run.id)
    this.runs.set(run.id, clone(run))
    const events = buildRunTransitionEvents({
      before,
      after: run,
      expectedSequence: current.sequence,
      reason: 'run_state_saved',
    })
    const snapshot = events.length
      ? this.appendDomainEvents({ runId: run.id, expectedSequence: current.sequence, events })
      : current
    assertRunDomainProjection(snapshot, run)
    assertRunDomainCheckpointProjection(snapshot, memoryDomainCheckpoint(this.requireCheckpoint(run.id)))
  }

  async saveRunWithModelUsage(run: AnalysisRun, modelTokens: number): Promise<void> {
    if (!Number.isInteger(modelTokens) || modelTokens <= 0) {
      throw new Error('模型词元增量必须是正整数')
    }
    const before = clone(this.requireRun(run.id))
    if (run.status !== before.status) {
      throw new Error(`运行 '${run.id}' 的模型用量事务不能同时改变运行状态`)
    }
    if (run.usedModelTokens !== before.usedModelTokens + modelTokens) {
      throw new Error(`运行 '${run.id}' 的模型词元累计值与增量不一致`)
    }
    if (run.maxModelTokens !== null && run.usedModelTokens > run.maxModelTokens) {
      throw new Error(`运行 '${run.id}' 的模型词元预算已耗尽`)
    }
    const current = this.requireDomainSnapshot(run.id)
    this.runs.set(run.id, clone(run))
    const events = buildRunTransitionEvents({
      before,
      after: run,
      expectedSequence: current.sequence,
      reason: 'model_usage_recorded',
    })
    const snapshot = events.length
      ? this.appendDomainEvents({ runId: run.id, expectedSequence: current.sequence, events })
      : current
    assertRunDomainProjection(snapshot, run)
    assertRunDomainCheckpointProjection(snapshot, memoryDomainCheckpoint(this.requireCheckpoint(run.id)))
  }

  async saveRunWithCheckpoint(
    run: AnalysisRun,
    fields: Partial<Pick<RunCheckpoint, 'activeEntryId' | 'pendingToolCallIds' | 'recoveryStatus'>>,
  ): Promise<void> {
    const before = clone(this.requireRun(run.id))
    if (run.usedModelTokens !== before.usedModelTokens) {
      throw new Error(`运行 '${run.id}' 的模型词元只能通过用量事务推进`)
    }
    const domainBefore = this.requireDomainSnapshot(run.id)
    const current = this.requireCheckpoint(run.id)
    this.runs.set(run.id, clone(run))
    this.checkpoints.set(run.id, {
      ...current,
      ...clone(fields),
      lastPersistedAt: run.updatedAt,
    })
    const checkpoint = memoryDomainCheckpoint(this.requireCheckpoint(run.id))
    const events = buildRunTransitionEvents({
      before,
      after: run,
      expectedSequence: domainBefore.sequence,
      reason: 'run_state_and_checkpoint_saved',
    })
    if (!isDeepStrictEqual(domainBefore.checkpoint, checkpoint)) {
      events.push(buildCheckpointChangedEvent({
        run,
        expectedSequence: domainBefore.sequence + events.length,
        checkpoint,
      }))
    }
    const snapshot = events.length
      ? this.appendDomainEvents({ runId: run.id, expectedSequence: domainBefore.sequence, events })
      : domainBefore
    assertRunDomainProjection(snapshot, run)
    assertRunDomainCheckpointProjection(snapshot, checkpoint)
  }

  async listRunsForThread(threadId: string): Promise<AnalysisRun[]> {
    return clone([...this.runs.values()]
      .filter(run => run.threadId === threadId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt)))
  }

  async saveRunCheckpoint(
    runId: string,
    fields: Partial<Pick<RunCheckpoint, 'activeEntryId' | 'pendingToolCallIds' | 'recoveryStatus'>>,
  ): Promise<void> {
    const run = this.requireRun(runId)
    const current = this.requireCheckpoint(runId)
    this.checkpoints.set(runId, {
      ...current,
      ...clone(fields),
      lastPersistedAt: run.updatedAt,
    })
    this.recordMemoryCheckpoint(runId)
  }

  async getRunCheckpoint(runId: string): Promise<RunCheckpoint> {
    return runCheckpointSchema.parse({
      ...clone(this.requireCheckpoint(runId)),
      run: clone(this.requireRun(runId)),
    })
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
    const domainBefore = this.requireDomainSnapshot(runId)
    const current = this.requireCheckpoint(runId)
    const leaseId = input.inputLeaseId ?? null
    const requestedStepId = input.checkpointModelRequestStepId ?? null
    const activeRequestId = domainBefore.activeModelRequestId
    const activeRequest = activeRequestId ? this.modelRequests.get(activeRequestId) ?? null : null
    if (activeRequestId && !activeRequest) {
      throw new Error(`运行 '${runId}' 的活动模型请求 '${activeRequestId}' 不存在`)
    }
    if (requestedStepId) {
      if (activeRequest) {
        if (activeRequest.runId !== runId || activeRequest.stepId !== requestedStepId) {
          throw new Error(`运行 '${runId}' 的活动模型请求与 checkpoint StepContext 不一致`)
        }
      } else {
        const checkpointed = [...this.modelRequests.values()].find(record => (
          record.runId === runId && record.stepId === requestedStepId
        ))
        if (!checkpointed || current.sdkStateContentHash !== input.contentHash) {
          throw new Error(`运行 '${runId}' 没有可由 StepContext '${requestedStepId}' 确认的活动模型请求`)
        }
      }
    }
    const terminalToolCallIds = new Set(input.terminalToolCallIds ?? [])
    const terminalInvocations = [...terminalToolCallIds].map(callId => {
      const invocation = this.toolInvocations.get(toolInvocationKey(runId, callId))
      if (!invocation) throw new Error(`SDK checkpoint 引用了不存在的工具调用 '${callId}'`)
      if (!['succeeded', 'failed', 'rejected', 'aborted', 'checkpointed'].includes(invocation.status)) {
        throw new Error(`SDK checkpoint 不能确认非终态工具调用 '${callId}'=${invocation.status}`)
      }
      return invocation
    })
    const pendingToolCallIds = current.pendingToolCallIds
      .filter(callId => !terminalToolCallIds.has(callId))
    if (!leaseId && current.activeInputLeaseId) {
      throw new Error(`运行 '${runId}' 存在未确认输入 lease '${current.activeInputLeaseId}'`)
    }
    let checkpointed: RunSteeringRecord[] = []
    if (leaseId) {
      const leaseRows = (this.inputs.get(runId) ?? [])
        .filter(record => record.leaseId === leaseId)
        .sort((left, right) => left.inputSequence - right.inputSequence)
      if (!leaseRows.length) throw new Error(`运行 '${runId}' 的输入 lease '${leaseId}' 不存在`)
      const leaseTo = leaseRows.at(-1)!.inputSequence
      if (
        current.activeInputLeaseId === null
        && leaseRows.every(record => record.status === 'checkpointed')
        && leaseTo <= current.checkpointInputCursor
      ) {
        if (current.sdkStateContentHash !== input.contentHash) {
          throw new Error(`运行 '${runId}' 的旧输入 lease '${leaseId}' 不能覆盖更新的 SDK checkpoint`)
        }
        this.checkpoints.set(runId, {
          ...current,
          pendingToolCallIds,
          recoveryStatus: pendingToolCallIds.length ? 'requires_action' : 'clean',
        })
        this.recordMemoryCheckpoint(runId, domainBefore, [], activeRequest && requestedStepId
          ? { requestId: activeRequest.requestId, stepId: activeRequest.stepId }
          : null)
        return clone(leaseRows)
      }
      if (
        current.activeInputLeaseId !== leaseId
        || current.activeInputLeaseFrom !== current.checkpointInputCursor + 1
        || current.activeInputLeaseTo !== leaseTo
      ) {
        throw new Error(`运行 '${runId}' 的活动输入 lease 与 checkpoint 不一致`)
      }
      assertContiguousRecords(
        leaseRows,
        current.activeInputLeaseFrom,
        current.activeInputLeaseTo - current.activeInputLeaseFrom + 1,
        runId,
      )
      if (requestedStepId && activeRequest && leaseRows.some(record => (
        record.modelRequestId !== activeRequest.requestId
      ))) {
        throw new Error(`运行 '${runId}' 的输入 lease 与活动模型请求不一致`)
      }
      const checkpointedAt = nowUtc()
      const byId = new Map(leaseRows.map(record => [record.steeringId, record]))
      const next = (this.inputs.get(runId) ?? []).map(record => {
        if (!byId.has(record.steeringId)) return record
        if (record.status !== 'included') throw new Error(`运行 '${runId}' 的 lease 尚未绑定 ModelRequest`)
        return runSteeringRecordSchema.parse({ ...record, status: 'checkpointed', checkpointedAt })
      })
      this.inputs.set(runId, next)
      checkpointed = next.filter(record => byId.has(record.steeringId))
      this.persistRunInputItems(checkpointed)
    }
    const updatedAt = nowUtc()
    this.checkpoints.set(runId, {
      ...current,
      lastPersistedAt: updatedAt,
      orchestrationEngine: 'openai_agents',
      sdkStateContentHash: input.contentHash,
      agentsSdkVersion: input.agentsSdkVersion,
      runtimeConfigDigest: input.runtimeConfigDigest,
      sdkStateSchemaVersion: input.sdkStateSchemaVersion,
      sdkStateUpdatedAt: updatedAt,
      pendingToolCallIds,
      recoveryStatus: pendingToolCallIds.length ? 'requires_action' : 'clean',
      checkpointInputCursor: checkpointed.at(-1)?.inputSequence ?? current.checkpointInputCursor,
      activeInputLeaseId: leaseId ? null : current.activeInputLeaseId,
      activeInputLeaseFrom: leaseId ? null : current.activeInputLeaseFrom,
      activeInputLeaseTo: leaseId ? null : current.activeInputLeaseTo,
    })
    for (const invocation of terminalInvocations) {
      if (invocation.status === 'checkpointed') continue
      this.toolInvocations.set(toolInvocationKey(runId, invocation.callId), toolInvocationRecordSchema.parse({
        ...invocation,
        status: 'checkpointed',
        checkpointedAt: updatedAt,
        version: invocation.version + 1,
      }))
    }
    this.recordMemoryCheckpoint(runId, domainBefore, checkpointed, activeRequest && requestedStepId
      ? { requestId: activeRequest.requestId, stepId: activeRequest.stepId }
      : null)
    return clone(checkpointed)
  }

  async appendConversationItem(item: ConversationItem): Promise<void> {
    const run = this.requireRun(item.runId)
    const parsed = conversationItemSchema.parse(item)
    this.items.set(item.runId, [...(this.items.get(item.runId) ?? []), clone(parsed)])
    if (!run.threadId) return
    const thread = this.requireThread(run.threadId)
    if (parsed.itemType === 'message' && parsed.role === 'assistant') {
      const summary = summarizeAssistantText(parsed.body ?? '')
      if (summary) thread.record = { ...thread.record, latestAssistantSummary: summary, updatedAt: nowUtc() }
    } else if (parsed.itemType === 'result') {
      thread.record = { ...thread.record, latestRunStatus: run.status, updatedAt: nowUtc() }
    }
  }

  async listConversationItems(runId: string): Promise<ConversationItem[]> {
    return clone((await this.loadRunPresentation(runId)).items)
  }

  async appendRunEvent(event: RunEvent): Promise<void> {
    this.requireRun(event.runId)
    const parsed = runEventSchema.parse(event)
    this.events.set(event.runId, [...(this.events.get(event.runId) ?? []), clone(parsed)])
  }

  async listRunEvents(runId: string): Promise<RunEvent[]> {
    return clone((await this.loadRunPresentation(runId)).events)
  }

  async appendToolValue(runId: string, value: ToolValueRef): Promise<void> {
    this.requireRun(runId)
    const parsed = toolValueRefSchema.parse(value)
    this.values.set(runId, [...(this.values.get(runId) ?? []), clone(parsed)])
  }

  async loadRunPresentation(runId: string): Promise<RunPresentationProjection> {
    this.requireRun(runId)
    const latestItems = new Map<string, ConversationItem>()
    for (const item of this.items.get(runId) ?? []) latestItems.set(item.itemId, item)
    const uniqueEvents = new Map<string, RunEvent>()
    for (const event of this.events.get(runId) ?? []) {
      const existing = uniqueEvents.get(event.eventId)
      if (existing && !isDeepStrictEqual(existing, event)) {
        throw new Error(`RunEvent '${event.eventId}' 的稳定 ID 被不同内容重复使用`)
      }
      uniqueEvents.set(event.eventId, event)
    }
    const uniqueValues = new Map<string, ToolValueRef>()
    for (const value of this.values.get(runId) ?? []) {
      const existing = uniqueValues.get(value.refId)
      if (existing && !isDeepStrictEqual(existing, value)) {
        throw new Error(`ToolValueRef '${value.refId}' 的稳定 ID 被不同内容重复使用`)
      }
      uniqueValues.set(value.refId, value)
    }
    const sourceSequence = (this.items.get(runId)?.length ?? 0)
      + (this.events.get(runId)?.length ?? 0)
      + (this.values.get(runId)?.length ?? 0)
    return clone(runPresentationProjectionSchema.parse({
      schemaVersion: RUN_PRESENTATION_PROJECTION_SCHEMA_VERSION,
      runId,
      sourceSequence,
      items: [...latestItems.values()].sort((left, right) => left.timestamp.localeCompare(right.timestamp)),
      events: [...uniqueEvents.values()],
      values: [...uniqueValues.values()],
    }))
  }

  async commitToolResult(
    run: AnalysisRun,
    resultId: string,
    invocationCommit: ToolInvocationEffectCommit,
    values: readonly ToolValueRef[],
    _artifacts: readonly ArtifactRef[],
  ): Promise<ToolEffectCommitResult> {
    const before = clone(this.requireRun(run.id))
    const domainBefore = this.requireDomainSnapshot(run.id)
    const commitKey = `${run.id}:${invocationCommit.invocationId}`
    const invocation = this.requireToolInvocationById(run.id, invocationCommit.invocationId)
    if (this.committedToolResults.has(commitKey)) {
      if (invocation.terminalOutcome !== 'succeeded' || invocation.resultId !== resultId) {
        throw new Error(`结果 '${resultId}' 已提交，但调用 '${invocation.callId}' 没有成功终态`)
      }
      return { committed: false, invocation: clone(invocation) }
    }
    if (invocation.status !== 'running' || invocation.version !== invocationCommit.expectedVersion) {
      throw new Error(`工具调用 '${invocation.callId}' 的结果提交 CAS 失败`)
    }
    this.committedToolResults.add(commitKey)
    this.runs.set(run.id, clone(run))
    const current = this.values.get(run.id) ?? []
    this.values.set(run.id, [...current, ...values.map(value => clone(toolValueRefSchema.parse(value)))])
    const domainEvents = buildRunTransitionEvents({
      before,
      after: run,
      expectedSequence: domainBefore.sequence,
      reason: 'tool_result_committed',
      resultId,
    })
    const domainSnapshot = this.appendDomainEvents({
      runId: run.id,
      expectedSequence: domainBefore.sequence,
      events: domainEvents,
    })
    assertRunDomainProjection(domainSnapshot, run)
    assertRunDomainCheckpointProjection(
      domainSnapshot,
      memoryDomainCheckpoint(this.requireCheckpoint(run.id)),
    )
    const terminal = toolInvocationRecordSchema.parse({
      ...invocation,
      status: invocationCommit.checkpointImmediately ? 'checkpointed' : 'succeeded',
      terminalOutcome: 'succeeded',
      resultId,
      terminalAt: invocationCommit.terminalAt,
      checkpointedAt: invocationCommit.checkpointImmediately ? invocationCommit.terminalAt : null,
      version: invocation.version + 1,
    })
    this.toolInvocations.set(toolInvocationKey(run.id, invocation.callId), terminal)
    if (invocationCommit.checkpointImmediately) {
      const checkpoint = this.requireCheckpoint(run.id)
      const pendingToolCallIds = checkpoint.pendingToolCallIds.filter(callId => callId !== invocation.callId)
      await this.saveRunCheckpoint(run.id, {
        pendingToolCallIds,
        recoveryStatus: pendingToolCallIds.length ? 'requires_action' : 'clean',
      })
    }
    return { committed: true, invocation: clone(terminal) }
  }

  async prepareToolInvocation(invocation: ToolInvocationRecord): Promise<ToolInvocationRecord> {
    const prepared = toolInvocationRecordSchema.parse(invocation)
    if (prepared.status !== 'prepared' || prepared.version !== 1) {
      throw new Error('新工具调用必须以 prepared/version 1 建立')
    }
    this.requireRun(prepared.runId)
    const key = toolInvocationKey(prepared.runId, prepared.callId)
    const existing = this.toolInvocations.get(key)
    if (existing) {
      if (!sameToolInvocationIdentity(existing, prepared)) {
        throw new Error(`工具调用 '${prepared.callId}' 的持久身份与重试请求不一致`)
      }
      return clone(existing)
    }
    this.toolInvocations.set(key, clone(prepared))
    return clone(prepared)
  }

  async getToolInvocation(runId: string, callId: string): Promise<ToolInvocationRecord | null> {
    this.requireRun(runId)
    const invocation = this.toolInvocations.get(toolInvocationKey(runId, callId))
    return invocation ? clone(invocation) : null
  }

  async listToolInvocations(runId: string): Promise<ToolInvocationRecord[]> {
    this.requireRun(runId)
    return clone([...this.toolInvocations.values()]
      .filter(invocation => invocation.runId === runId)
      .sort((left, right) => left.preparedAt.localeCompare(right.preparedAt)
        || left.invocationId.localeCompare(right.invocationId)))
  }

  async startToolInvocation(input: StartToolInvocationInput): Promise<ToolInvocationRecord> {
    const current = this.requireToolInvocationById(input.runId, input.invocationId)
    if (current.status === 'running') return clone(current)
    if (current.status !== 'prepared' || current.version !== input.expectedVersion) {
      throw new Error(`工具调用 '${current.callId}' 的 running CAS 失败`)
    }
    const updated = toolInvocationRecordSchema.parse({
      ...current,
      status: 'running',
      approvalDecision: input.approvalDecision,
      runningAt: input.runningAt,
      version: current.version + 1,
    })
    const checkpoint = this.requireCheckpoint(input.runId)
    const pendingToolCallIds = checkpoint.pendingToolCallIds.includes(current.callId)
      ? checkpoint.pendingToolCallIds
      : [...checkpoint.pendingToolCallIds, current.callId]
    await this.saveRunCheckpoint(input.runId, {
      pendingToolCallIds,
      recoveryStatus: 'requires_action',
    })
    this.toolInvocations.set(toolInvocationKey(input.runId, current.callId), updated)
    return clone(updated)
  }

  async terminateToolInvocation(input: TerminalToolInvocationInput): Promise<ToolInvocationRecord> {
    const current = this.requireToolInvocationById(input.runId, input.invocationId)
    if (
      current.terminalOutcome === input.outcome
      && (current.status === input.outcome || current.status === 'checkpointed')
    ) return clone(current)
    const expectedStatuses = input.outcome === 'rejected' ? ['prepared', 'running'] : ['running']
    if (!expectedStatuses.includes(current.status) || current.version !== input.expectedVersion) {
      throw new Error(`工具调用 '${current.callId}' 的 ${input.outcome} CAS 失败`)
    }
    const updated = toolInvocationRecordSchema.parse({
      ...current,
      status: input.checkpointImmediately ? 'checkpointed' : input.outcome,
      terminalOutcome: input.outcome,
      resultId: input.resultId,
      error: input.error,
      terminalAt: input.terminalAt,
      checkpointedAt: input.checkpointImmediately ? input.terminalAt : null,
      ...(input.approvalDecision ? { approvalDecision: input.approvalDecision } : {}),
      version: current.version + 1,
    })
    if (input.checkpointImmediately) {
      const checkpoint = this.requireCheckpoint(input.runId)
      const pendingToolCallIds = checkpoint.pendingToolCallIds.filter(callId => callId !== current.callId)
      await this.saveRunCheckpoint(input.runId, {
        pendingToolCallIds,
        recoveryStatus: pendingToolCallIds.length ? 'requires_action' : 'clean',
      })
    }
    this.toolInvocations.set(toolInvocationKey(input.runId, current.callId), updated)
    return clone(updated)
  }

  async prepareApprovalRecord(record: ApprovalRecord): Promise<ApprovalRecord> {
    const prepared = approvalRecordSchema.parse(record)
    if (prepared.version !== 1 || prepared.status === 'consumed') {
      throw new Error('新审批记录必须以 version 1 的 pending/resolved 状态建立')
    }
    this.requireRun(prepared.runId)
    const existing = this.getApprovalForCall(prepared.runId, prepared.callId)
    if (existing) {
      if (!sameApprovalIdentity(existing, prepared)) {
        throw new Error(`审批调用 '${prepared.callId}' 的持久身份与重试请求不一致`)
      }
      return clone(existing)
    }
    if (this.approvalRecords.has(prepared.approvalId)) {
      throw new Error(`审批 '${prepared.approvalId}' 已绑定其他调用`)
    }
    this.approvalRecords.set(prepared.approvalId, clone(prepared))
    return clone(prepared)
  }

  async getApprovalRecord(approvalId: string): Promise<ApprovalRecord | null> {
    const record = this.approvalRecords.get(approvalId)
    return record ? clone(record) : null
  }

  async getApprovalRecordForCall(runId: string, callId: string): Promise<ApprovalRecord | null> {
    this.requireRun(runId)
    const record = this.getApprovalForCall(runId, callId)
    return record ? clone(record) : null
  }

  async listApprovalRecords(runId: string): Promise<ApprovalRecord[]> {
    this.requireRun(runId)
    return clone([...this.approvalRecords.values()]
      .filter(record => record.runId === runId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt)
        || left.approvalId.localeCompare(right.approvalId)))
  }

  async findSessionApproval(sessionId: string, actionKey: string): Promise<ApprovalRecord | null> {
    const record = [...this.approvalRecords.values()]
      .filter(candidate => (
        candidate.sessionId === sessionId
        && candidate.actionKey === actionKey
        && candidate.decision === 'approved'
        && candidate.decisionScope === 'session'
        && ['resolved', 'consumed'].includes(candidate.status)
      ))
      .sort((left, right) => (right.resolvedAt ?? '').localeCompare(left.resolvedAt ?? '')
        || right.approvalId.localeCompare(left.approvalId))[0]
    return record ? clone(record) : null
  }

  async resolveApprovalRecord(input: ResolveApprovalRecordInput): Promise<ApprovalRecord> {
    const current = this.requireApproval(input.runId, input.approvalId)
    if (current.status !== 'pending') {
      if (
        current.decision === input.decision
        && current.decisionScope === input.scope
        && current.decisionReason === input.reason
      ) return clone(current)
      throw new Error(`审批 '${input.approvalId}' 已用不同决定处理`)
    }
    if (current.version !== input.expectedVersion) {
      throw new Error(`审批 '${input.approvalId}' 的 resolve CAS 失败`)
    }
    const updated = approvalRecordSchema.parse({
      ...current,
      status: 'resolved',
      decision: input.decision,
      decisionScope: input.scope,
      decisionReason: input.reason,
      decidedByUserId: input.decidedByUserId,
      resolvedAt: input.resolvedAt,
      version: current.version + 1,
    })
    this.approvalRecords.set(updated.approvalId, clone(updated))
    return clone(updated)
  }

  async consumeApprovalRecord(input: ConsumeApprovalRecordInput): Promise<ApprovalRecord> {
    const current = this.requireApproval(input.runId, input.approvalId)
    if (current.status === 'consumed') return clone(current)
    if (current.status !== 'resolved' || current.version !== input.expectedVersion) {
      throw new Error(`审批 '${input.approvalId}' 的 consume CAS 失败`)
    }
    const updated = approvalRecordSchema.parse({
      ...current,
      status: 'consumed',
      consumedAt: input.consumedAt,
      version: current.version + 1,
    })
    this.approvalRecords.set(updated.approvalId, clone(updated))
    return clone(updated)
  }

  async appendRunDomainEvents(input: {
    runId: string
    expectedSequence: number
    events: readonly RunDomainEvent[]
  }): Promise<RunDomainSnapshot> {
    const run = this.requireRun(input.runId)
    const previousRun = clone(run)
    const previousCheckpoint = clone(this.requireCheckpoint(input.runId))
    const previousEvents = clone(this.domainEvents.get(input.runId) ?? [])
    const previousSnapshot = clone(this.domainSnapshots.get(input.runId) ?? null)
    try {
      const snapshot = this.appendDomainEvents(input)
      const projectedRun = analysisRunSchema.parse({
        ...run,
        status: snapshot.status,
        state: snapshot.state,
        updatedAt: snapshot.updatedAt,
      })
      this.runs.set(input.runId, clone(projectedRun))
      if (snapshot.checkpoint) {
        this.checkpoints.set(input.runId, {
          ...previousCheckpoint,
          ...snapshot.checkpoint,
          lastPersistedAt: snapshot.updatedAt,
        })
      }
      assertRunDomainProjection(snapshot, projectedRun)
      assertRunDomainCheckpointProjection(
        snapshot,
        memoryDomainCheckpoint(this.requireCheckpoint(input.runId)),
      )
      assertRunDomainInputCollection(
        snapshot,
        (this.inputs.get(input.runId) ?? []).map(record => ({
          inputId: record.steeringId,
          inputSequence: record.inputSequence,
          status: record.status,
          leaseId: record.status === 'queued' ? null : record.leaseId,
          modelRequestId: record.status === 'included' || record.status === 'checkpointed'
            ? record.modelRequestId
            : null,
        })),
      )
      return clone(snapshot)
    } catch (error) {
      this.runs.set(input.runId, previousRun)
      this.checkpoints.set(input.runId, previousCheckpoint)
      this.domainEvents.set(input.runId, previousEvents)
      if (previousSnapshot) this.domainSnapshots.set(input.runId, previousSnapshot)
      else this.domainSnapshots.delete(input.runId)
      throw error
    }
  }

  async getRunDomainSnapshot(runId: string): Promise<RunDomainSnapshot | null> {
    this.requireRun(runId)
    const snapshot = this.domainSnapshots.get(runId)
    return snapshot ? clone(snapshot) : null
  }

  async listRunDomainEvents(runId: string, afterSequence = 0): Promise<RunDomainEvent[]> {
    this.requireRun(runId)
    return clone((this.domainEvents.get(runId) ?? [])
      .filter(event => event.sequence > afterSequence))
  }

  async inspectRunDomainProjection(runId: string): Promise<RunDomainProjectionInspection> {
    const run = this.requireRun(runId)
    return clone(inspectDomainProjection({
      run,
      checkpoint: memoryDomainCheckpoint(this.requireCheckpoint(runId)),
      inputs: (this.inputs.get(runId) ?? []).map(record => ({
        inputId: record.steeringId,
        inputSequence: record.inputSequence,
        status: record.status,
        leaseId: record.status === 'queued' ? null : record.leaseId,
        modelRequestId: record.status === 'included' || record.status === 'checkpointed'
          ? record.modelRequestId
          : null,
      })),
      snapshot: this.domainSnapshots.get(runId) ?? null,
      events: this.domainEvents.get(runId) ?? [],
    }))
  }

  async listToolValues(runId: string): Promise<ToolValueRef[]> {
    return clone((await this.loadRunPresentation(runId)).values)
  }

  async getThreadManifest(threadId: string): Promise<ThreadManifest> {
    const state = this.requireThread(threadId)
    if (state.record.status === 'deleted') throw new Error(`线程 '${threadId}' 不存在`)
    return clone(this.threadManifest(state))
  }

  private threadManifest(state: ThreadState): ThreadManifest {
    return threadManifestSchema.parse({
      schemaVersion: 2,
      threadId: state.record.id,
      sessionId: state.record.sessionId,
      activeLeafEntryId: state.activeLeafEntryId,
      lastSequence: state.nextEntrySequence - 1,
      transcriptEntryCount: state.transcriptEntryCount,
      estimatedContextTokens: state.estimatedContextTokens,
      latestCompactionId: state.latestCompactionId,
      memoryVersion: state.memoryVersion,
      memoryBasedOnTokens: state.memoryBasedOnTokens,
      forkedFrom: state.forkedFromThreadId && state.forkedFromEntryId
        ? { threadId: state.forkedFromThreadId, entryId: state.forkedFromEntryId }
        : null,
      quarantined: state.quarantined,
      quarantineReason: state.quarantineReason,
      createdAt: state.record.createdAt,
      updatedAt: state.record.updatedAt,
    })
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
    const state = this.requireThread(input.threadId)
    if (state.record.status === 'deleted') throw new Error(`线程 '${input.threadId}' 不存在`)
    if (state.memoryVersion !== input.expectedVersion) {
      throw new MemoryVersionConflictError(input.expectedVersion, state.memoryVersion)
    }
    if (input.version !== state.memoryVersion + 1) {
      throw new Error(`线程记忆版本必须从 ${state.memoryVersion} 递增到 ${state.memoryVersion + 1}`)
    }
    const reference: ThreadMemoryVersionReference = clone(input)
    this.memoryVersions.set(input.threadId, [
      ...(this.memoryVersions.get(input.threadId) ?? []),
      reference,
    ])
    state.memoryVersion = input.version
    state.memoryBasedOnTokens = state.estimatedContextTokens
    state.record = { ...state.record, updatedAt: input.createdAt }
    return clone(reference)
  }

  async getLatestThreadMemoryVersion(threadId: string): Promise<ThreadMemoryVersionReference | null> {
    const state = this.requireThread(threadId)
    if (state.record.status === 'deleted') throw new Error(`线程 '${threadId}' 不存在`)
    const versions = this.memoryVersions.get(threadId) ?? []
    return versions.length ? clone(versions[versions.length - 1]!) : null
  }

  async appendCompaction(record: CompactionRecord): Promise<void> {
    const parsed = compactionRecordSchema.parse(record)
    const state = this.requireThread(parsed.threadId)
    if (state.record.status === 'deleted') throw new Error(`线程 '${parsed.threadId}' 不存在`)
    const current = this.compactions.get(parsed.threadId) ?? []
    const existing = current.find(item => item.compactionId === parsed.compactionId)
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(parsed)) {
        throw new Error(`压缩记录 '${parsed.compactionId}' 与首次写入不一致`)
      }
      return
    }
    this.compactions.set(parsed.threadId, [...current, clone(parsed)])
    state.latestCompactionId = parsed.compactionId
    state.estimatedContextTokens = parsed.postTokens
    state.record = { ...state.record, updatedAt: parsed.createdAt }
  }

  async listCompactions(threadId: string): Promise<CompactionRecord[]> {
    const state = this.requireThread(threadId)
    if (state.record.status === 'deleted') throw new Error(`线程 '${threadId}' 不存在`)
    return clone(this.compactions.get(threadId) ?? [])
  }

  async listReferencedObjectHashes(): Promise<string[]> {
    const hashes = new Set<string>()
    for (const checkpoint of this.checkpoints.values()) collectSha256Strings(checkpoint, hashes)
    for (const request of this.modelRequests.values()) collectSha256Strings(request, hashes)
    for (const versions of this.memoryVersions.values()) collectSha256Strings(versions, hashes)
    for (const entries of this.entries.values()) collectSha256Strings(entries, hashes)
    for (const items of this.items.values()) collectSha256Strings(items, hashes)
    for (const events of this.events.values()) collectSha256Strings(events, hashes)
    for (const values of this.values.values()) collectSha256Strings(values, hashes)
    return [...hashes]
  }

  async appendConversationEntry(input: AppendConversationEntryInput): Promise<TranscriptEntry> {
    const state = this.requireThread(input.threadId)
    const existing = input.entryId
      ? (this.entries.get(input.threadId) ?? []).find(entry => entry.entryId === input.entryId)
      : null
    if (existing) return clone(existing)
    const parentEntryId = input.parentEntryId === undefined ? state.activeLeafEntryId : input.parentEntryId
    this.assertEntry(input.threadId, parentEntryId ?? null)
    this.assertEntry(input.threadId, input.logicalParentEntryId ?? null)
    const entry = transcriptEntrySchema.parse({
      schemaVersion: 2,
      seq: state.nextEntrySequence,
      entryId: input.entryId ?? makeId('entry'),
      parentEntryId: parentEntryId ?? null,
      logicalParentEntryId: input.logicalParentEntryId ?? null,
      threadId: input.threadId,
      runId: input.runId ?? null,
      turnId: input.turnId ?? null,
      kind: input.kind,
      timestamp: nowUtc(),
      payload: input.payload ?? {},
    })
    this.entries.set(input.threadId, [...(this.entries.get(input.threadId) ?? []), entry])
    state.activeLeafEntryId = entry.entryId
    state.nextEntrySequence += 1
    state.transcriptEntryCount += 1
    state.estimatedContextTokens += estimateTokens(JSON.stringify(entry.payload))
    state.record = { ...state.record, updatedAt: entry.timestamp }
    return clone(entry)
  }

  async readThreadHistory(threadId: string, cursor?: string | null, limit = 50): Promise<ThreadHistoryPage> {
    this.requireThread(threadId)
    const bounded = Math.min(200, Math.max(1, Math.trunc(limit)))
    const before = cursor ? decodeHistoryCursor(cursor) : Number.POSITIVE_INFINITY
    const eligible = (this.entries.get(threadId) ?? []).filter(entry => entry.seq < before)
    const selected = eligible.slice(Math.max(0, eligible.length - bounded))
    return {
      entries: clone(selected),
      nextCursor: selected.length && selected[0]!.seq > 1 ? encodeHistoryCursor(selected[0]!.seq) : null,
    }
  }

  async readActiveConversation(threadId: string, leafEntryId?: string | null): Promise<TranscriptEntry[]> {
    const state = this.requireThread(threadId)
    const entries = this.entries.get(threadId) ?? []
    const byId = new Map(entries.map(entry => [entry.entryId, entry]))
    const chain: TranscriptEntry[] = []
    let cursor = leafEntryId ?? state.activeLeafEntryId
    const visited = new Set<string>()
    while (cursor) {
      if (visited.has(cursor)) throw new Error(`线程 '${threadId}' 的父链存在循环`)
      visited.add(cursor)
      const entry = byId.get(cursor)
      if (!entry) throw new Error(`对话条目 '${cursor}' 不存在`)
      chain.push(entry)
      cursor = entry.parentEntryId
    }
    return clone(chain.reverse())
  }

  async forkConversation(
    sourceThreadId: string,
    targetThreadId: string,
    sourceEntryId: string,
    lastNTurns?: number | null,
  ): Promise<Map<string, string>> {
    if (lastNTurns !== undefined && lastNTurns !== null
      && (!Number.isInteger(lastNTurns) || lastNTurns <= 0)) {
      throw new Error('lastNTurns 必须是正整数')
    }
    const completeSource = await this.readActiveConversation(sourceThreadId, sourceEntryId)
    const source = lastNTurns ? lastMemoryTurns(completeSource, lastNTurns) : completeSource
    const target = this.requireThread(targetThreadId)
    const mapping = new Map<string, string>()
    for (const entry of source) {
      const nextId = makeId('entry')
      const copied = await this.appendConversationEntry({
        threadId: targetThreadId,
        runId: null,
        turnId: entry.turnId,
        kind: entry.kind,
        payload: { ...entry.payload, forkedFromEntryId: entry.entryId },
        parentEntryId: entry.parentEntryId ? mapping.get(entry.parentEntryId) ?? null : null,
        logicalParentEntryId: entry.logicalParentEntryId ? mapping.get(entry.logicalParentEntryId) ?? null : null,
        entryId: nextId,
      })
      mapping.set(entry.entryId, copied.entryId)
    }
    target.forkedFromThreadId = sourceThreadId
    target.forkedFromEntryId = sourceEntryId
    return mapping
  }

  async enqueueRunInput(input: EnqueueRunInput): Promise<RunSteeringRecord> {
    const existing = (this.inputs.get(input.runId) ?? []).find(record => record.steeringId === input.inputId)
    if (existing) {
      if (existing.content !== input.content.trim()) throw new Error(`引导消息 '${input.inputId}' 的内容与首次提交不一致`)
      return clone(existing)
    }
    const run = this.requireRun(input.runId)
    const domainBefore = this.requireDomainSnapshot(input.runId)
    if (!run.threadId) throw new Error(`运行 '${input.runId}' 缺少 threadId`)
    const content = input.content.trim()
    const entry = await this.appendConversationEntry({
      threadId: run.threadId,
      runId: run.id,
      turnId: input.turnId,
      kind: 'message',
      payload: { role: 'user', content, steeringId: input.inputId },
      entryId: input.entryId,
    })
    const record = runSteeringRecordSchema.parse({
      schemaVersion: 4,
      steeringId: input.inputId,
      entryId: entry.entryId,
      itemId: input.itemId,
      runId: run.id,
      threadId: run.threadId,
      turnId: input.turnId,
      content,
      inputSequence: this.requireCheckpoint(run.id).nextInputSequence,
      status: 'queued',
      queuedAt: entry.timestamp,
      leaseId: null,
      leasedAt: null,
      modelRequestId: null,
      includedAt: null,
      checkpointedAt: null,
    })
    this.inputs.set(run.id, [...(this.inputs.get(run.id) ?? []), record])
    this.persistRunInputItems([record])
    const checkpoint = this.requireCheckpoint(run.id)
    this.checkpoints.set(run.id, { ...checkpoint, nextInputSequence: checkpoint.nextInputSequence + 1 })
    this.recordMemoryInputTransition(run.id, domainBefore, 'input.queued', [record])
    return clone(record)
  }

  async leaseRunInputs(runId: string, leaseId: string): Promise<RunSteeringRecord[]> {
    this.requireRun(runId)
    const domainBefore = this.requireDomainSnapshot(runId)
    const checkpoint = this.requireCheckpoint(runId)
    if (checkpoint.activeInputLeaseId) {
      if (checkpoint.activeInputLeaseId === leaseId) {
        const existing = (this.inputs.get(runId) ?? [])
          .filter(record => (
            (record.status === 'leased' || record.status === 'included')
            && record.leaseId === leaseId
          ))
          .sort((left, right) => left.inputSequence - right.inputSequence)
        if (checkpoint.activeInputLeaseFrom === null || checkpoint.activeInputLeaseTo === null) {
          throw new Error(`运行 '${runId}' 的活动输入 lease 范围不完整`)
        }
        assertContiguousRecords(
          existing,
          checkpoint.activeInputLeaseFrom,
          checkpoint.activeInputLeaseTo - checkpoint.activeInputLeaseFrom + 1,
          runId,
        )
        return clone(existing)
      }
      throw new Error(`运行 '${runId}' 已有活动输入 lease '${checkpoint.activeInputLeaseId}'`)
    }
    const queued = (this.inputs.get(runId) ?? [])
      .filter(record => record.status === 'queued' && record.inputSequence > checkpoint.checkpointInputCursor)
      .sort((left, right) => left.inputSequence - right.inputSequence)
    const expectedCount = checkpoint.nextInputSequence - checkpoint.checkpointInputCursor - 1
    if (!queued.length) {
      if (expectedCount) throw new Error(`运行 '${runId}' 的 input cursor 与 queued 连续前缀不一致`)
      return []
    }
    assertContiguousRecords(queued, checkpoint.checkpointInputCursor + 1, expectedCount, runId)
    const leasedAt = nowUtc()
    const queuedIds = new Set(queued.map(record => record.steeringId))
    const leased: RunSteeringRecord[] = []
    const next = (this.inputs.get(runId) ?? []).map(record => {
      if (!queuedIds.has(record.steeringId)) return record
      const updated = runSteeringRecordSchema.parse({ ...record, status: 'leased', leaseId, leasedAt })
      leased.push(updated)
      return updated
    })
    this.inputs.set(runId, next)
    this.persistRunInputItems(leased)
    this.checkpoints.set(runId, {
      ...checkpoint,
      activeInputLeaseId: leaseId,
      activeInputLeaseFrom: leased[0]!.inputSequence,
      activeInputLeaseTo: leased.at(-1)!.inputSequence,
    })
    this.recordMemoryInputTransition(runId, domainBefore, 'input.leased', leased)
    return clone(leased)
  }

  async getRunInput(runId: string, inputId: string): Promise<RunSteeringRecord | null> {
    this.requireRun(runId)
    const record = (this.inputs.get(runId) ?? []).find(candidate => candidate.steeringId === inputId)
    return record ? clone(record) : null
  }

  async requeueLeasedRunInputs(runId: string): Promise<RunSteeringRecord[]> {
    this.requireRun(runId)
    const domainBefore = this.requireDomainSnapshot(runId)
    const checkpoint = this.requireCheckpoint(runId)
    const leaseId = checkpoint.activeInputLeaseId
    if (!leaseId) return []
    const leased = (this.inputs.get(runId) ?? [])
      .filter(record => (
        (record.status === 'leased' || record.status === 'included')
        && record.leaseId === leaseId
      ))
      .sort((left, right) => left.inputSequence - right.inputSequence)
    if (checkpoint.activeInputLeaseFrom === null || checkpoint.activeInputLeaseTo === null) {
      throw new Error(`运行 '${runId}' 的活动输入 lease 范围不完整`)
    }
    assertContiguousRecords(
      leased,
      checkpoint.activeInputLeaseFrom,
      checkpoint.activeInputLeaseTo - checkpoint.activeInputLeaseFrom + 1,
      runId,
    )
    if (leased.some(record => record.status === 'included')) {
      if (leased.some(record => record.status !== 'included')) {
        throw new Error(`运行 '${runId}' 的活动 lease 状态不一致`)
      }
      return []
    }
    const leasedIds = new Set(leased.map(record => record.steeringId))
    const requeued: RunSteeringRecord[] = []
    const next = (this.inputs.get(runId) ?? []).map(record => {
      if (!leasedIds.has(record.steeringId)) return record
      const updated = runSteeringRecordSchema.parse({
        ...record,
        status: 'queued',
        leaseId: null,
        leasedAt: null,
        modelRequestId: null,
        includedAt: null,
        checkpointedAt: null,
      })
      requeued.push(updated)
      return updated
    })
    this.inputs.set(runId, next)
    this.persistRunInputItems(requeued)
    this.checkpoints.set(runId, {
      ...checkpoint,
      activeInputLeaseId: null,
      activeInputLeaseFrom: null,
      activeInputLeaseTo: null,
    })
    this.recordMemoryInputTransition(runId, domainBefore, 'input.requeued', requeued)
    return clone(requeued)
  }

  async listRunInputs(runId: string): Promise<RunSteeringRecord[]> {
    this.requireRun(runId)
    return clone(this.inputs.get(runId) ?? [])
  }

  async commitModelRequest(input: CommitModelRequestInput): Promise<CommitModelRequestResult> {
    const run = this.requireRun(input.runId)
    const checkpoint = this.requireCheckpoint(input.runId)
    const domainBefore = this.requireDomainSnapshot(input.runId)
    if (checkpoint.terminalInputClaimId) throw new Error(`运行 '${input.runId}' 已提交终态游标`)
    const activeInputs = checkpoint.activeInputLeaseId
      ? (this.inputs.get(input.runId) ?? [])
        .filter(record => (
          record.leaseId === checkpoint.activeInputLeaseId
          && (record.status === 'leased' || record.status === 'included')
        ))
        .sort((left, right) => left.inputSequence - right.inputSequence)
      : []
    if (checkpoint.activeInputLeaseId) {
      if (checkpoint.activeInputLeaseFrom === null || checkpoint.activeInputLeaseTo === null) {
        throw new Error(`运行 '${input.runId}' 的活动输入 lease 范围不完整`)
      }
      assertContiguousRecords(
        activeInputs,
        checkpoint.activeInputLeaseFrom,
        checkpoint.activeInputLeaseTo - checkpoint.activeInputLeaseFrom + 1,
        input.runId,
      )
    }
    const proposed = modelRequestRecordSchema.parse({
      ...input,
      inputEntryIds: activeInputs.map(record => record.entryId),
    })
    const existing = [...this.modelRequests.values()].find(record => (
      record.requestId === proposed.requestId
      || (record.runId === proposed.runId && record.stepId === proposed.stepId)
    ))
    if (existing) {
      if (!isDeepStrictEqual(existing, proposed)) {
        throw new Error(`模型请求 '${proposed.requestId}' 的幂等键或 stepId 已被其它内容使用`)
      }
      if (domainBefore.activeModelRequestId !== existing.requestId) {
        throw new Error(`模型请求 '${existing.requestId}' 已被 checkpoint，不能重新打开`)
      }
      return { record: clone(existing), includedInputs: clone(activeInputs) }
    }

    const activeRequestId = domainBefore.activeModelRequestId
    if (activeRequestId) {
      throw new Error(`运行 '${input.runId}' 已有活动模型请求 '${activeRequestId}'`)
    }

    const activeIds = new Set(activeInputs.map(record => record.steeringId))
    const includedAt = nowUtc()
    const includedInputs: RunSteeringRecord[] = []
    const next = (this.inputs.get(input.runId) ?? []).map(record => {
      if (!activeIds.has(record.steeringId)) return record
      if (record.status !== 'leased') throw new Error(`运行 '${input.runId}' 的输入已绑定其它模型请求`)
      const included = runSteeringRecordSchema.parse({
        ...record,
        status: 'included',
        modelRequestId: proposed.requestId,
        includedAt,
      })
      includedInputs.push(included)
      return included
    })
    this.modelRequests.set(proposed.requestId, clone(proposed))
    this.inputs.set(input.runId, next)
    this.persistRunInputItems(includedInputs)
    const events: RunDomainEvent[] = []
    if (includedInputs.length) {
      events.push(buildInputTransitionEvent({
        run,
        expectedSequence: domainBefore.sequence,
        type: 'input.included',
        records: includedInputs,
      }))
    }
    events.push(buildModelRequestCommittedEvent({
      run,
      expectedSequence: domainBefore.sequence + events.length,
      requestId: proposed.requestId,
      stepId: proposed.stepId,
      inputObjectHash: proposed.inputObjectHash,
      inputEntryIds: proposed.inputEntryIds,
    }))
    const snapshot = this.appendDomainEvents({
      runId: input.runId,
      expectedSequence: domainBefore.sequence,
      events,
    })
    assertRunDomainProjection(snapshot, run)
    assertRunDomainCheckpointProjection(snapshot, memoryDomainCheckpoint(checkpoint))
    if (includedInputs.length) assertRunDomainInputProjection(snapshot, includedInputs)
    return { record: clone(proposed), includedInputs: clone(includedInputs) }
  }

  async getModelRequest(requestId: string): Promise<ModelRequestRecord | null> {
    const record = this.modelRequests.get(requestId)
    return record ? clone(record) : null
  }

  async getActiveModelRequest(runId: string): Promise<ModelRequestRecord | null> {
    const domainBefore = this.requireDomainSnapshot(runId)
    const requestId = domainBefore.activeModelRequestId
    if (!requestId) return null
    const request = this.modelRequests.get(requestId)
    if (!request || request.runId !== runId) {
      throw new Error(`运行 '${runId}' 的活动模型请求 '${requestId}' 不存在或归属错误`)
    }
    return clone(request)
  }

  async listModelRequests(runId: string): Promise<ModelRequestRecord[]> {
    this.requireRun(runId)
    return clone([...this.modelRequests.values()]
      .filter(record => record.runId === runId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt)))
  }

  async tryClaimTerminalInput(input: {
    runId: string
    claimId: string
    objectiveRevision: number
    inputCursor: number
  }): Promise<boolean> {
    const run = this.requireRun(input.runId)
    const checkpoint = this.requireCheckpoint(input.runId)
    const domainBefore = this.requireDomainSnapshot(input.runId)
    if (checkpoint.terminalInputClaimId) {
      return checkpoint.terminalInputClaimId === input.claimId
        && checkpoint.terminalObjectiveRevision === input.objectiveRevision
        && checkpoint.terminalInputCursor === input.inputCursor
    }
    if (
      run.status !== 'running'
      || checkpoint.activeInputLeaseId !== null
      || checkpoint.nextInputSequence !== input.objectiveRevision
      || checkpoint.checkpointInputCursor !== input.inputCursor
    ) {
      this.appendDomainEvents({
        runId: input.runId,
        expectedSequence: domainBefore.sequence,
        events: [buildTerminalCandidateSupersededEvent({
          run,
          expectedSequence: domainBefore.sequence,
          objectiveRevision: input.objectiveRevision,
          inputCursor: input.inputCursor,
          durableObjectiveRevision: checkpoint.nextInputSequence,
          durableInputCursor: checkpoint.checkpointInputCursor,
        })],
      })
      return false
    }
    const terminalClaimedAt = nowUtc()
    const updated = {
      ...checkpoint,
      terminalInputClaimId: input.claimId,
      terminalObjectiveRevision: input.objectiveRevision,
      terminalInputCursor: input.inputCursor,
      terminalClaimedAt,
    }
    this.checkpoints.set(input.runId, updated)
    const projectedCheckpoint = memoryDomainCheckpoint(updated)
    const events: RunDomainEvent[] = [
      buildTerminalClaimedEvent({
        run,
        expectedSequence: domainBefore.sequence,
        claimId: input.claimId,
        objectiveRevision: input.objectiveRevision,
        inputCursor: input.inputCursor,
      }),
      buildCheckpointChangedEvent({
        run,
        expectedSequence: domainBefore.sequence + 1,
        checkpoint: projectedCheckpoint,
      }),
    ]
    const snapshot = this.appendDomainEvents({
      runId: input.runId,
      expectedSequence: domainBefore.sequence,
      events,
    })
    assertRunDomainCheckpointProjection(snapshot, projectedCheckpoint)
    return true
  }

  private recordMemoryInputTransition(
    runId: string,
    domainBefore: RunDomainSnapshot,
    type: 'input.queued' | 'input.leased' | 'input.requeued',
    records: readonly RunSteeringRecord[],
  ): void {
    const run = this.requireRun(runId)
    const checkpoint = memoryDomainCheckpoint(this.requireCheckpoint(runId))
    const events: RunDomainEvent[] = [
      buildInputTransitionEvent({
        run,
        expectedSequence: domainBefore.sequence,
        type,
        records,
      }),
      buildCheckpointChangedEvent({
        run,
        expectedSequence: domainBefore.sequence + 1,
        checkpoint,
      }),
    ]
    const snapshot = this.appendDomainEvents({
      runId,
      expectedSequence: domainBefore.sequence,
      events,
    })
    assertRunDomainProjection(snapshot, run)
    assertRunDomainCheckpointProjection(snapshot, checkpoint)
    assertRunDomainInputProjection(snapshot, records)
  }

  private recordMemoryCheckpoint(
    runId: string,
    domainBefore = this.requireDomainSnapshot(runId),
    acknowledged: readonly RunSteeringRecord[] = [],
    checkpointedModelRequest: { requestId: string; stepId: string } | null = null,
  ): void {
    const run = this.requireRun(runId)
    const checkpoint = memoryDomainCheckpoint(this.requireCheckpoint(runId))
    const events: RunDomainEvent[] = []
    if (acknowledged.length) {
      events.push(buildInputTransitionEvent({
        run,
        expectedSequence: domainBefore.sequence,
        type: 'input.checkpointed',
        records: acknowledged,
      }))
    }
    if (checkpointedModelRequest) {
      events.push(buildModelRequestCheckpointedEvent({
        run,
        expectedSequence: domainBefore.sequence + events.length,
        requestId: checkpointedModelRequest.requestId,
        stepId: checkpointedModelRequest.stepId,
      }))
    }
    if (!isDeepStrictEqual(domainBefore.checkpoint, checkpoint)) {
      events.push(buildCheckpointChangedEvent({
        run,
        expectedSequence: domainBefore.sequence + events.length,
        checkpoint,
      }))
    }
    const snapshot = events.length
      ? this.appendDomainEvents({ runId, expectedSequence: domainBefore.sequence, events })
      : domainBefore
    assertRunDomainProjection(snapshot, run)
    assertRunDomainCheckpointProjection(snapshot, checkpoint)
    if (acknowledged.length) assertRunDomainInputProjection(snapshot, acknowledged)
  }

  private appendDomainEvents(input: {
    runId: string
    expectedSequence: number
    events: readonly RunDomainEvent[]
  }): RunDomainSnapshot {
    const current = this.domainSnapshots.get(input.runId) ?? null
    const currentSequence = current?.sequence ?? 0
    if (currentSequence !== input.expectedSequence) {
      throw new RunDomainSequenceConflictError(
        input.runId,
        input.expectedSequence,
        currentSequence,
      )
    }
    const events = input.events.map(event => runDomainEventSchema.parse(event))
    const next = reduceRunDomainEvents(current, events)
    if (!next) throw new Error(`run '${input.runId}' 领域日志没有产生 snapshot`)
    this.domainEvents.set(input.runId, [
      ...(this.domainEvents.get(input.runId) ?? []),
      ...clone(events),
    ])
    this.domainSnapshots.set(input.runId, clone(next))
    return next
  }

  private requireDomainSnapshot(runId: string): RunDomainSnapshot {
    const snapshot = this.domainSnapshots.get(runId)
    if (!snapshot) throw new Error(`run '${runId}' 缺少领域日志 snapshot`)
    return clone(snapshot)
  }

  private persistRunInputItems(records: readonly RunSteeringRecord[]): void {
    for (const record of records) {
      const item = runInputConversationItem(record)
      this.items.set(record.runId, [...(this.items.get(record.runId) ?? []), clone(item)])
    }
  }

  private requireThread(threadId: string): ThreadState {
    const state = this.threads.get(threadId)
    if (!state) throw new Error(`线程 '${threadId}' 不存在`)
    return state
  }

  private requireRun(runId: string): AnalysisRun {
    const run = this.runs.get(runId)
    if (!run) throw new Error(`运行 '${runId}' 不存在`)
    return run
  }

  private requireCheckpoint(runId: string): CheckpointMetadata {
    const checkpoint = this.checkpoints.get(runId)
    if (!checkpoint) throw new Error(`运行 '${runId}' 检查点不存在`)
    return checkpoint
  }

  private requireToolInvocationById(runId: string, invocationId: string): ToolInvocationRecord {
    const invocation = [...this.toolInvocations.values()].find(candidate => (
      candidate.runId === runId && candidate.invocationId === invocationId
    ))
    if (!invocation) throw new Error(`工具调用 '${invocationId}' 不存在`)
    return invocation
  }

  private getApprovalForCall(runId: string, callId: string): ApprovalRecord | null {
    return [...this.approvalRecords.values()].find(record => (
      record.runId === runId && record.callId === callId
    )) ?? null
  }

  private requireApproval(runId: string, approvalId: string): ApprovalRecord {
    const record = this.approvalRecords.get(approvalId)
    if (!record || record.runId !== runId) throw new Error(`审批 '${approvalId}' 不存在`)
    return record
  }

  private assertEntry(threadId: string, entryId: string | null): void {
    if (!entryId) return
    if (!(this.entries.get(threadId) ?? []).some(entry => entry.entryId === entryId)) {
      throw new Error(`父对话条目 '${entryId}' 不属于线程 '${threadId}'`)
    }
  }

  private deletedThreadRecord(state: ThreadState): DeletedThreadRecord {
    if (!state.deletedAt || !state.purgeAfter) {
      throw new Error(`已删除线程 '${state.record.id}' 缺少回收站时间信息`)
    }
    return {
      thread: clone(state.record),
      manifest: this.threadManifest(state),
      deletedAt: state.deletedAt,
      purgeAfter: state.purgeAfter,
    }
  }
}

function lastMemoryTurns(entries: TranscriptEntry[], count: number): TranscriptEntry[] {
  const turnIds: string[] = []
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const turnId = entries[index]?.turnId
    if (!turnId || turnIds.includes(turnId)) continue
    turnIds.unshift(turnId)
    if (turnIds.length === count) break
  }
  if (!turnIds.length) throw new Error('源对话没有可供 last_n_turns fork 的 turn 身份')
  const selected = new Set(turnIds)
  const first = entries.findIndex(entry => entry.turnId !== null && selected.has(entry.turnId))
  if (first < 0) throw new Error('无法定位 last_n_turns fork 边界')
  return entries.slice(first)
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function toolInvocationKey(runId: string, callId: string): string {
  return `${runId}\u0000${callId}`
}

function sameToolInvocationIdentity(
  left: ToolInvocationRecord,
  right: ToolInvocationRecord,
): boolean {
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

function sameApprovalIdentity(left: ApprovalRecord, right: ApprovalRecord): boolean {
  const identity = (record: ApprovalRecord) => ({
    approvalId: record.approvalId,
    runId: record.runId,
    threadId: record.threadId,
    sessionId: record.sessionId,
    workspaceId: record.workspaceId,
    invocationId: record.invocationId,
    callId: record.callId,
    stepId: record.stepId,
    contextDigest: record.contextDigest,
    actionKey: record.actionKey,
    action: record.action,
  })
  return isDeepStrictEqual(identity(left), identity(right))
}

function createThreadState(thread: AgentThreadRecord): ThreadState {
  return {
    record: clone(thread),
    activeLeafEntryId: null,
    nextEntrySequence: 1,
    transcriptEntryCount: 0,
    estimatedContextTokens: 0,
    latestCompactionId: null,
    memoryVersion: 0,
    memoryBasedOnTokens: 0,
    forkedFromThreadId: null,
    forkedFromEntryId: null,
    quarantined: false,
    quarantineReason: null,
    deletedAt: null,
    purgeAfter: null,
  }
}

function initialCheckpoint(updatedAt: string): CheckpointMetadata {
  return {
    schemaVersion: 3,
    activeEntryId: null,
    pendingToolCallIds: [],
    lastPersistedAt: updatedAt,
    recoveryStatus: 'clean',
    orchestrationEngine: null,
    sdkStateContentHash: null,
    agentsSdkVersion: null,
    runtimeConfigDigest: null,
    sdkStateSchemaVersion: null,
    sdkStateUpdatedAt: null,
    nextInputSequence: 1,
    checkpointInputCursor: 0,
    activeInputLeaseId: null,
    activeInputLeaseFrom: null,
    activeInputLeaseTo: null,
    terminalInputClaimId: null,
    terminalObjectiveRevision: null,
    terminalInputCursor: null,
    terminalClaimedAt: null,
  }
}

function memoryDomainCheckpoint(checkpoint: CheckpointMetadata): RunDomainCheckpoint {
  return {
    activeEntryId: checkpoint.activeEntryId,
    pendingToolCallIds: [...checkpoint.pendingToolCallIds],
    recoveryStatus: checkpoint.recoveryStatus,
    orchestrationEngine: checkpoint.orchestrationEngine,
    sdkStateContentHash: checkpoint.sdkStateContentHash,
    agentsSdkVersion: checkpoint.agentsSdkVersion,
    runtimeConfigDigest: checkpoint.runtimeConfigDigest,
    sdkStateSchemaVersion: checkpoint.sdkStateSchemaVersion,
    sdkStateUpdatedAt: checkpoint.sdkStateUpdatedAt,
    nextInputSequence: checkpoint.nextInputSequence,
    checkpointInputCursor: checkpoint.checkpointInputCursor,
    activeInputLeaseId: checkpoint.activeInputLeaseId,
    activeInputLeaseFrom: checkpoint.activeInputLeaseFrom,
    activeInputLeaseTo: checkpoint.activeInputLeaseTo,
    terminalInputClaimId: checkpoint.terminalInputClaimId,
    terminalObjectiveRevision: checkpoint.terminalObjectiveRevision,
    terminalInputCursor: checkpoint.terminalInputCursor,
    terminalClaimedAt: checkpoint.terminalClaimedAt,
  }
}

function assertContiguousRecords(
  records: readonly RunSteeringRecord[],
  firstSequence: number,
  expectedCount: number,
  runId: string,
): void {
  if (records.length !== expectedCount) throw new Error(`运行 '${runId}' 的 input sequence 存在空洞`)
  records.forEach((record, index) => {
    if (record.inputSequence !== firstSequence + index) {
      throw new Error(`运行 '${runId}' 的 input sequence 存在空洞`)
    }
  })
}

function assertThreadOwnerMatchesSession(thread: AgentThreadRecord, session: SessionRecord): void {
  if (
    thread.workspaceId !== session.workspaceId
    || thread.createdByUserId !== session.createdByUserId
    || thread.visibility !== session.visibility
  ) {
    throw new Error(`线程 '${thread.id}' 的资源归属与会话 '${session.id}' 不一致`)
  }
}

function assertRunOwnerMatchesThread(run: AnalysisRun, thread: AgentThreadRecord): void {
  if (
    run.workspaceId !== thread.workspaceId
    || run.createdByUserId !== thread.createdByUserId
    || run.visibility !== thread.visibility
  ) {
    throw new Error(`运行 '${run.id}' 的资源归属与线程 '${thread.id}' 不一致`)
  }
}

function assertRunOwnerMatchesSession(run: AnalysisRun, session: SessionRecord): void {
  if (
    run.workspaceId !== session.workspaceId
    || run.createdByUserId !== session.createdByUserId
    || run.visibility !== session.visibility
  ) {
    throw new Error(`运行 '${run.id}' 的资源归属与会话 '${session.id}' 不一致`)
  }
}

function collectSha256Strings(value: unknown, hashes: Set<string>): void {
  if (typeof value === 'string') {
    if (/^[a-f0-9]{64}$/u.test(value)) hashes.add(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSha256Strings(item, hashes)
    return
  }
  if (!value || typeof value !== 'object') return
  for (const item of Object.values(value)) collectSha256Strings(item, hashes)
}
