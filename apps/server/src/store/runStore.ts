// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运行资源存储
//
//   文件:       runStore.ts
//
//   日期:       2026年07月07日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import type {
AgentRuntimeConfig,
AgentRunProfile,
AgentState,
AnalysisRun,
ArtifactRef,
ConversationItem,
ConversationItemTextDelta,
ContextReference,
RunCheckpoint,
RunEvent,
RunGoalInput,
ModelRequestRecord,
RunItemStreamSnapshot,
RunItemUpsert,
RunSteeringRecord,
RunSummary,
ToolValueRef,
} from '../schemas/types.js'
import type { ToolInvocationRecord } from '@geo-agent-platform/shared-types/tool-runtime'
import {
AGENTS_SDK_STATE_SCHEMA_VERSION,
agentStateSchema,
} from '../schemas/types.js'
import {
isConversationItemWrite,
type AppendConversationItemBody,
type ConversationItemStoreUpdate,
} from '../conversation/itemUpdates.js'
import { summarizeAssistantText } from '../conversation/items.js'
import { errorLogPayload,logger } from '../observability/logger.js'
import { makeId,nowUtc } from '../utils/ids.js'
import type { ConversationProjectionIndex } from './conversationProjectionIndex.js'
import type { InMemoryEventBus } from './eventBus.js'
import type { ConversationPayloadStore } from './conversationPayloadStore.js'
import {
decodeRunCursor,
compareRuns,
encodeRunCursor,
isRunAfterCursor,
toRunSummary,
} from './runProjection.js'
import type { SessionStore } from './sessionStore.js'
import { ObjectPublicationCoordinator } from './objectPublicationCoordinator.js'
import type {
CommitModelRequestInput,
CommitModelRequestResult,
ModelRequestRepository,
RunRepository,
ThreadLifecycleRepository,
ToolResultCommitter,
ToolInvocationRepository,
StartToolInvocationInput,
TerminalToolInvocationInput,
ToolEffectCommitResult,
ToolInvocationEffectCommit,
} from './postgres/conversationPersistencePorts.js'

export interface RunStoreEvents {
  runBus: InMemoryEventBus<AnalysisRun>
  eventBus: InMemoryEventBus<RunEvent>
  itemBus: InMemoryEventBus<ConversationItem>
  itemUpsertBus: InMemoryEventBus<RunItemUpsert>
  itemDeltaBus: InMemoryEventBus<ConversationItemTextDelta>
}

interface StreamedConversationItem {
  item: ConversationItem
  textChunks: string[]
  utf16Length: number
  sequence: number
  hasBodyDeltas: boolean
}

interface RunItemStreamState {
  streamId: string
  items: Map<string, StreamedConversationItem>
}

// RunStore 拥有 run manifest、checkpoint、event 和 item 追加写入。
// session/thread 上的 latest* 字段是 run 的投影，由这里同步维护。
export class RunStore {
  private readonly durableRunningItems = new Map<string, Set<string>>()
  private readonly itemStreams = new Map<string, RunItemStreamState>()
  private readonly itemMutationTails = new Map<string, Promise<void>>()
  private readonly closedItemRuns = new Set<string>()
  private readonly committedItemRunClosures = new Set<string>()
  private readonly pendingItemRunClosures = new Map<string, number>()
  private readonly stateMutationTails = new Map<string, Promise<void>>()

  constructor(
    private readonly index: ConversationProjectionIndex,
    private readonly payloadStore: ConversationPayloadStore,
    private readonly sessionStore: SessionStore,
    private readonly repository: RunRepository & ToolResultCommitter & ToolInvocationRepository & ModelRequestRepository,
    private readonly threadWriter: Pick<ThreadLifecycleRepository, 'saveThread'>,
    private readonly events: RunStoreEvents,
    private readonly objectPublication = new ObjectPublicationCoordinator(),
  ) {}

  listForSession(sessionId: string): AnalysisRun[] {
    return this.index.listRunsForSession(sessionId)
  }

  listForThread(threadId: string): AnalysisRun[] {
    return this.index.listRunsForThread(threadId)
  }

  listForWorkspace(workspaceId: string): AnalysisRun[] {
    return [...this.index.runValues()]
      .filter(run => run.workspaceId === workspaceId)
      .sort(compareRuns)
  }

  listSummaries(options: {
    sessionId: string
    threadId?: string | null
    cursor?: string | null
    limit?: number
  }): { items: RunSummary[]; nextCursor: string | null } {
    this.sessionStore.get(options.sessionId)
    if (options.threadId) {
      const thread = this.index.getThread(options.threadId)
      if (thread.sessionId !== options.sessionId) throw new Error('threadId 不属于当前 session')
    }

    const limit = Math.min(100, Math.max(1, Math.trunc(options.limit ?? 20)))
    const cursor = options.cursor ? decodeRunCursor(options.cursor) : null
    const source = options.threadId
      ? this.listForThread(options.threadId)
      : this.listForSession(options.sessionId)
    const eligible = cursor
      ? source.filter(run => isRunAfterCursor(run, cursor))
      : source
    const page = eligible.slice(0, limit + 1)
    const hasMore = page.length > limit
    const selected = hasMore ? page.slice(0, limit) : page
    const lastSelected = selected.at(-1)

    return {
      items: selected.map(toRunSummary),
      nextCursor: hasMore && lastSelected ? encodeRunCursor(lastSelected) : null,
    }
  }

  get(runId: string): AnalysisRun {
    return this.index.getRun(runId)
  }

  // 单写实例启动后，内存中不存在上一进程的执行器。遗留的 queued/running
  // Run 必须原子转为可恢复终态，不能继续向 UI 投影成“正在执行”。
  async recoverOrphanedRuns(): Promise<AnalysisRun[]> {
    const recovered: AnalysisRun[] = []
    const candidates = [...this.index.runValues()]
      .filter(run => run.status === 'queued' || run.status === 'running')
      .sort(compareRuns)
    for (const run of candidates) {
      const checkpoint = await this.repository.getRunCheckpoint(run.id)
      const requiresAction = checkpoint.recoveryStatus === 'requires_action'
        || checkpoint.pendingToolCallIds.length > 0
      const status: AnalysisRun['status'] = requiresAction ? 'requires_action' : 'interrupted'
      const reason = requiresAction
        ? `服务进程重启时发现状态未知的工具调用：${checkpoint.pendingToolCallIds.join('、') || 'checkpoint 标记需要操作'}。系统未自动重放。`
        : '服务进程重启时该运行仍处于活动状态，已标记为中断；如需继续，必须由用户显式恢复。'
      const updatedAt = nowUtc()
      const next: AnalysisRun = {
        ...run,
        status,
        updatedAt,
        state: agentStateSchema.parse({
          ...run.state,
          warnings: run.state.warnings.includes(reason)
            ? run.state.warnings
            : [...run.state.warnings, reason],
          runLifecycle: { status, reason, updatedAt },
        }),
      }
      await this.repository.saveRunWithCheckpoint(next, {
        pendingToolCallIds: checkpoint.pendingToolCallIds,
        recoveryStatus: requiresAction ? 'requires_action' : 'interrupted',
      })
      this.index.setRun(next)
      this.events.runBus.publish(next.id, structuredClone(next))
      await this.persistDerivedThreadRunStatusProjection(run, status, updatedAt)
      recovered.push(next)
    }
    return recovered
  }

  async create(sessionId: string, query: string, opts?: {
    threadId?: string | null
    modelProvider?: string | null
    modelName?: string | null
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
    const session = this.sessionStore.get(sessionId)
    const thread = opts?.threadId ? this.index.getThread(opts.threadId) : null
    if (thread && thread.sessionId !== sessionId) throw new Error('run 的 thread 不属于当前 session')
    const now = nowUtc()
    const runId = makeId('run')
    const child = opts?.childIdentity
    const run: AnalysisRun = {
      id: runId,
      runKind: child ? 'child' : 'root',
      rootRunId: child?.rootRunId ?? runId,
      parentRunId: child?.parentRunId ?? null,
      parentTurnId: child?.parentTurnId ?? null,
      rootTurnId: child?.rootTurnId ?? null,
      spawnCallId: child?.spawnCallId ?? null,
      agentPath: child?.agentPath ?? '/root',
      taskName: child?.taskName ?? null,
      agentRole: child?.agentRole ?? null,
      spawnDepth: child?.spawnDepth ?? 0,
      forkMode: child?.forkMode ?? 'none',
      forkTurnCount: child?.forkTurnCount ?? null,
      modelOverride: child?.modelOverride ?? null,
      reasoningOverride: child?.reasoningOverride ?? null,
      maxModelTokens: child?.maxModelTokens ?? null,
      maxWallClockMs: child?.maxWallClockMs ?? null,
      usedModelTokens: 0,
      threadId: opts?.threadId ?? null,
      sessionId,
      workspaceId: thread?.workspaceId ?? session.workspaceId,
      createdByUserId: thread?.createdByUserId ?? session.createdByUserId,
      visibility: thread?.visibility ?? session.visibility,
      userQuery: query,
      modelProvider: opts?.modelProvider ?? null,
      modelName: opts?.modelName ?? null,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      conversationPath: opts?.threadId ? `conversations/sessions/${sessionId}/threads/${opts.threadId}/runs` : null,
      runtimeConfigSnapshot: opts?.runtimeConfigSnapshot ?? null,
      state: agentStateSchema.parse({
        sessionId,
        threadId: opts?.threadId ?? null,
        userQuery: query,
        objectiveRevision: 1,
        modelProvider: opts?.modelProvider ?? null,
        modelName: opts?.modelName ?? null,
        loopTrace: [],
        todos: [],
        tasks: [],
        runProfile: opts?.runProfile ?? 'standard',
        subAgents: [],
        activeSkills: [],
        activeMcpServers: [],
        approvals: [],
        decisions: [],
        toolResults: [],
        toolValueRefs: [],
        artifacts: [],
        selectedDataSources: [],
        warnings: [],
        errors: [],
        failure: null,
        denialCounts: {},
        runtimeStats: {},
        currentStep: 0,
        loopIteration: 0,
        loopPhase: 'idle',
        planRepairAttempts: 0,
        planMode: false,
        contextReferences: structuredClone(opts?.contextReferences ?? []),
        contextResolution: null,
        parsedIntent: null,
        clarification: null,
        placeResolution: null,
        agentWorkflow: null,
        runLifecycle: { status: 'created', reason: null, updatedAt: null },
        goal: opts?.goal ? {
          goalId: makeId('goal'),
          objectiveRevision: 1,
          condition: opts.goal.condition,
          acceptanceCriteria: [...opts.goal.acceptanceCriteria],
          maxRechecks: opts.goal.maxRechecks,
          deadlineAt: opts.goal.deadlineAt,
          maxTokenBudget: opts.goal.maxTokenBudget,
          status: 'active',
          recheckCount: 0,
          lastVerdict: null,
          failureReason: null,
          createdAt: now,
          updatedAt: now,
          completedAt: null,
        } : null,
        failedStepId: null,
        failedTool: null,
      }),
    }
    const persisted = await this.repository.createRunLifecycle(run)
    this.payloadStore.registerRun(persisted.run)
    this.sessionStore.acceptPersisted(persisted.session)
    if (persisted.thread) this.index.setThread(persisted.thread)
    this.index.setRun(persisted.run)
    this.events.runBus.publish(run.id, structuredClone(persisted.run))
    return persisted.run
  }

  async updateState(runId: string, updates: Partial<AgentState>): Promise<AnalysisRun> {
    return this.mutateState(runId, () => updates)
  }

  async commitToolResult(
    runId: string,
    resultId: string,
    mutation: (state: AgentState) => Partial<AgentState>,
    invocation: ToolInvocationEffectCommit,
    values: readonly ToolValueRef[],
    artifacts: readonly ArtifactRef[],
  ): Promise<ToolEffectCommitResult> {
    let outcome: ToolEffectCommitResult | null = null
    await this.serializeStateMutation(runId, async () => {
      const run = this.get(runId)
      const updates = mutation(run.state)
      const next = {
        ...run,
        state: agentStateSchema.parse({ ...run.state, ...updates }),
        updatedAt: nowUtc(),
      }
      outcome = await this.repository.commitToolResult(next, resultId, invocation, values, artifacts)
      if (!outcome.committed) return
      this.index.setRun(next)
      this.updateThreadProjectionFromArtifacts(next, artifacts)
      this.events.runBus.publish(runId, structuredClone(next))
    })
    if (!outcome) throw new Error(`运行 '${runId}' 的工具结果提交没有返回事务结果`)
    return outcome
  }

  prepareToolInvocation(invocation: ToolInvocationRecord): Promise<ToolInvocationRecord> {
    return this.repository.prepareToolInvocation(invocation)
  }

  getToolInvocation(runId: string, callId: string): Promise<ToolInvocationRecord | null> {
    return this.repository.getToolInvocation(runId, callId)
  }

  listToolInvocations(runId: string): Promise<ToolInvocationRecord[]> {
    return this.repository.listToolInvocations(runId)
  }

  startToolInvocation(input: StartToolInvocationInput): Promise<ToolInvocationRecord> {
    return this.repository.startToolInvocation(input)
  }

  terminateToolInvocation(input: TerminalToolInvocationInput): Promise<ToolInvocationRecord> {
    return this.repository.terminateToolInvocation(input)
  }

  // Run 状态的读-改-写必须在同一串行边界内完成。仅序列化数据库 save
  // 不足以保护内存投影：并行调用可能先读到同一旧快照，再依次覆盖新状态。
  async mutateState(
    runId: string,
    mutation: (state: AgentState) => Partial<AgentState>,
  ): Promise<AnalysisRun> {
    return this.serializeStateMutation(runId, async () => {
      const run = this.get(runId)
      const updates = mutation(run.state)
      const state = agentStateSchema.parse({ ...run.state, ...updates })
      const modelTokens = modelTokenDelta(run.state.runtimeStats, state.runtimeStats)
      const next = {
        ...run,
        usedModelTokens: normalizedModelTokens(run.usedModelTokens) + modelTokens,
        state,
        updatedAt: nowUtc(),
      }
      if (modelTokens > 0) await this.repository.saveRunWithModelUsage(next, modelTokens)
      else await this.repository.saveRun(next)
      this.index.setRun(next)
      this.events.runBus.publish(runId, structuredClone(next))
      return next
    })
  }

  async updateStatus(runId: string, status: AnalysisRun['status']): Promise<AnalysisRun> {
    return this.serializeStateMutation(runId, async () => {
      const run = this.get(runId)
      const next = { ...run, status, updatedAt: nowUtc() }
      await this.repository.saveRunWithCheckpoint(next, {
        recoveryStatus: status === 'interrupted' ? 'interrupted' : status === 'requires_action' ? 'requires_action' : 'clean',
      })
      this.index.setRun(next)
      if (status === 'queued' || status === 'running') this.reopenItemWrites(runId)
      this.events.runBus.publish(runId, structuredClone(next))
      await this.persistDerivedThreadRunStatusProjection(run, status, next.updatedAt)
      return next
    })
  }

  async complete(runId: string, status: string): Promise<AnalysisRun> {
    this.beginItemRunClosure(runId)
    try {
      return await this.serializeStateMutation(runId, async () => {
        // A previously queued updateStatus(running) may have committed after
        // complete() installed its immediate fence. Reassert closure inside
        // the authoritative per-run state order before awaiting item writes.
        this.closedItemRuns.add(runId)
        await this.itemMutationTails.get(runId)
        const run = this.get(runId)
        const next = { ...run, status: status as AnalysisRun['status'], updatedAt: nowUtc() }
        await this.repository.saveRunWithCheckpoint(next, {
          recoveryStatus: next.status === 'waiting_approval' || next.status === 'requires_action'
            ? 'requires_action'
            : 'clean',
        })
        await this.payloadStore.flush()
        this.index.setRun(next)
        this.durableRunningItems.delete(runId)
        this.itemStreams.delete(runId)
        this.events.runBus.publish(runId, structuredClone(next))
        await this.persistDerivedThreadRunStatusProjection(run, next.status, next.updatedAt)
        // Commit the durable fence inside the same ordered mutation. A later
        // updateStatus(running) can then reopen it without being overwritten
        // by complete()'s outer promise continuation.
        this.committedItemRunClosures.add(runId)
        return next
      })
    } finally {
      this.finishItemRunClosure(runId)
    }
  }

  async saveCheckpoint(
    runId: string,
    fields: Partial<Pick<RunCheckpoint, 'activeEntryId' | 'pendingToolCallIds' | 'recoveryStatus'>> = {},
  ): Promise<void> {
    this.get(runId)
    await this.repository.saveRunCheckpoint(runId, fields)
  }

  async getCheckpoint(runId: string): Promise<RunCheckpoint> {
    this.get(runId)
    return this.repository.getRunCheckpoint(runId)
  }

  async appendAgentTranscript(runId: string, agentId: string, record: Record<string, unknown>): Promise<void> {
    this.get(runId)
    await this.payloadStore.appendAgentTranscript(runId, agentId, record)
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
    this.get(runId)
    return this.objectPublication.publish(async () => {
      const reference = await this.payloadStore.putObject(
        serializedEnvelope,
        'application/vnd.geo-agent-platform.agents-checkpoint+json',
      )
      return this.repository.saveAgentsSdkCheckpoint(runId, {
        contentHash: reference.hash,
        agentsSdkVersion: metadata.agentsSdkVersion,
        runtimeConfigDigest: metadata.runtimeConfigDigest,
        sdkStateSchemaVersion: AGENTS_SDK_STATE_SCHEMA_VERSION,
        inputLeaseId: metadata.inputLeaseId ?? null,
        terminalToolCallIds: metadata.terminalToolCallIds ?? [],
        checkpointModelRequestStepId: metadata.checkpointModelRequestStepId ?? null,
      })
    })
  }

  async readAgentsSdkCheckpointEnvelope(runId: string): Promise<string> {
    this.get(runId)
    const checkpoint = await this.repository.getRunCheckpoint(runId)
    const hash = checkpoint.sdkStateContentHash
    if (!hash) throw new Error(`run '${runId}' 缺少 Agents SDK checkpoint envelope，不能恢复`)
    const bytes = await this.payloadStore.readObjectByHash(hash)
    return Buffer.from(bytes).toString('utf8')
  }

  async publishModelRequestSnapshot(
    serializedRequest: string,
    input: Omit<CommitModelRequestInput, 'inputObjectHash'>,
  ): Promise<CommitModelRequestResult> {
    this.get(input.runId)
    return this.objectPublication.publish(async () => {
      const reference = await this.payloadStore.putObject(
        serializedRequest,
        'application/vnd.geo-agent-platform.model-request+json',
      )
      return this.repository.commitModelRequest({
        ...input,
        inputObjectHash: reference.hash,
      })
    })
  }

  async readModelRequestSnapshot(record: ModelRequestRecord): Promise<string> {
    this.get(record.runId)
    const bytes = await this.payloadStore.readObjectByHash(record.inputObjectHash)
    return Buffer.from(bytes).toString('utf8')
  }

  async getActiveModelRequest(runId: string): Promise<ModelRequestRecord | null> {
    this.get(runId)
    return this.repository.getActiveModelRequest(runId)
  }

  async listModelRequests(runId: string): Promise<ModelRequestRecord[]> {
    this.get(runId)
    return this.repository.listModelRequests(runId)
  }

  async appendToolValue(runId: string, value: ToolValueRef): Promise<void> {
    this.get(runId)
    await this.repository.appendToolValue(runId, value)
  }

  async appendEvent(runId: string, event: RunEvent): Promise<void> {
    this.get(runId)
    await this.repository.appendRunEvent(event)
    this.events.eventBus.publish(runId, event)
  }

  async listEvents(runId: string): Promise<RunEvent[]> {
    this.get(runId)
    return this.repository.listRunEvents(runId)
  }

  async appendItem(update: ConversationItemStoreUpdate): Promise<void> {
    const runId = isConversationItemWrite(update)
      ? update.updateType === 'append_body' ? update.runId : update.item.runId
      : update.runId
    if (this.closedItemRuns.has(runId)) {
      throw new Error(`Run '${runId}' 已封口，不能继续写入 ConversationItem`)
    }
    return this.serializeItemMutation(runId, () => this.applyItemUpdate(update, true))
  }

  // Repository 已在 run_input 状态事务内追加 item record/outbox；这里只更新
  // 当前进程投影与事件总线，不能再次写 PostgreSQL。
  async projectPersistedItems(items: readonly ConversationItem[]): Promise<void> {
    if (!items.length) return
    const runId = items[0]!.runId
    if (items.some(item => item.runId !== runId)) {
      throw new Error('批量 ConversationItem 投影必须属于同一 Run')
    }
    if (this.closedItemRuns.has(runId)) {
      throw new Error(`Run '${runId}' 已封口，不能继续投影 ConversationItem`)
    }
    await this.serializeItemMutation(runId, async () => {
      for (const item of items) await this.applyItemUpdate(item, false)
    })
  }

  async listItems(runId: string): Promise<ConversationItem[]> {
    return (await this.listItemSnapshot(runId)).items
  }

  async listItemSnapshot(runId: string): Promise<{
    items: ConversationItem[]
    itemStream: RunItemStreamSnapshot
  }> {
    const snapshot = await this.listPresentationSnapshot(runId)
    return { items: snapshot.items, itemStream: snapshot.itemStream }
  }

  async listPresentationSnapshot(runId: string): Promise<{
    items: ConversationItem[]
    events: RunEvent[]
    itemStream: RunItemStreamSnapshot
    sourceSequence: number
  }> {
    this.get(runId)
    return this.serializeItemMutation(runId, async () => {
      const captured = this.captureItemStream(runId)
      const persisted = await this.repository.loadRunPresentation(runId)
      const byItemId = new Map<string, ConversationItem>()
      for (const item of persisted.items) {
        byItemId.set(item.itemId, item)
      }
      const cursors = new Map<string, { sequence: number; utf16Offset: number }>()
      for (const item of persisted.items) {
        cursors.set(item.itemId, { sequence: 0, utf16Offset: (item.body ?? '').length })
      }
      for (const [itemId, live] of captured.items) {
        const item = materializeStreamedItem(live)
        byItemId.set(item.itemId, item)
        cursors.set(itemId, { sequence: live.sequence, utf16Offset: live.utf16Length })
      }
      return {
        items: orderConversationItems([...byItemId.values()]),
        events: persisted.events,
        itemStream: {
          streamId: captured.streamId,
          cursors: [...cursors].map(([itemId, cursor]) => ({ itemId, ...cursor })),
        },
        sourceSequence: persisted.sourceSequence,
      }
    })
  }

  private appendItemBody(update: AppendConversationItemBody): void {
    this.get(update.runId)
    if (!update.text) throw new Error('ConversationItem 文本增量不能为空')
    const stream = this.itemStreams.get(update.runId)
    const current = stream?.items.get(update.itemId)
    if (!stream || !current) {
      throw new Error(`ConversationItem '${update.itemId}' 缺少 replace_item start，不能应用文本增量`)
    }
    if (current.item.status !== 'running') {
      throw new Error(`ConversationItem '${update.itemId}' 已结束，不能继续追加文本`)
    }
    if (current.item.itemType !== 'message' && current.item.itemType !== 'reasoning') {
      throw new Error(`ConversationItem '${update.itemId}' 类型 '${current.item.itemType}' 不支持正文增量`)
    }
    const sequence = current.sequence + 1
    const utf16Offset = current.utf16Length
    current.textChunks.push(update.text)
    current.sequence = sequence
    current.utf16Length += update.text.length
    current.hasBodyDeltas = true
    const delta: ConversationItemTextDelta = {
      updateType: 'text_delta',
      schemaVersion: 1,
      streamId: stream.streamId,
      runId: update.runId,
      threadId: update.threadId,
      itemId: update.itemId,
      sequence,
      utf16Offset,
      text: update.text,
    }
    this.events.itemDeltaBus.publish(update.runId, delta)
  }

  private async applyItemUpdate(
    update: ConversationItemStoreUpdate,
    persist: boolean,
  ): Promise<void> {
    if (isConversationItemWrite(update) && update.updateType === 'append_body') {
      if (!persist) throw new Error('已持久化 item 投影不接受正文增量')
      this.appendItemBody(update)
      return
    }
    const item = isConversationItemWrite(update) ? update.item : update
    this.get(item.runId)
    const stream = this.getOrCreateActiveItemStream(item.runId)
    const previous = stream.items.get(item.itemId)
    if (previous && isTerminalItemStatus(previous.item.status)) {
      if (item.status === 'running') {
        throw new Error(`ConversationItem '${item.itemId}' 已结束，不能重新进入 running`)
      }
      const previousBody = materializeStreamedItem(previous).body
      if (item.status !== previous.item.status || item.body !== previousBody) {
        throw new Error(
          `ConversationItem '${item.itemId}' 的终态正文和状态不可改写：`
          + `${previous.item.status}/${JSON.stringify(previousBody)} -> `
          + `${item.status}/${JSON.stringify(item.body)}`,
        )
      }
    }
    if (previous && previous.item.status === 'running' && previous.hasBodyDeltas) {
      const streamedBody = materializeStreamedItem(previous).body
      if (item.body !== streamedBody) {
        throw new Error(`ConversationItem '${item.itemId}' terminal body 与已发布文本增量不一致`)
      }
    }
    if (persist && this.shouldPersistItem(item)) {
      await this.repository.appendConversationItem(item)
    }
    const body = item.body ?? ''
    const current: StreamedConversationItem = {
      item,
      textChunks: body ? [body] : [],
      utf16Length: body.length,
      sequence: previous ? previous.sequence + 1 : 0,
      hasBodyDeltas: false,
    }
    stream.items.set(item.itemId, current)
    this.events.itemBus.publish(item.runId, item)
    this.events.itemUpsertBus.publish(item.runId, {
      updateType: 'item_upsert',
      schemaVersion: 1,
      streamId: stream.streamId,
      cursor: { sequence: current.sequence, utf16Offset: current.utf16Length },
      item,
    })
    if (item.status !== 'running') this.updateThreadProjectionFromItem(item)
  }

  private async persistThreadRunStatus(run: AnalysisRun, status: AnalysisRun['status'], updatedAt: string): Promise<void> {
    if (!run.threadId) return
    const thread = this.index.getThreadOrNull(run.threadId)
    if (!thread) return
    const nextThread = { ...thread, latestRunStatus: status, updatedAt }
    await this.threadWriter.saveThread(nextThread)
    this.index.setThread(nextThread)
  }

  // PostgreSQL run records are the durable fact source. Thread latest status is
  // a derived navigation projection and must never replace the run fact.
  private async persistDerivedThreadRunStatusProjection(run: AnalysisRun, status: AnalysisRun['status'], updatedAt: string): Promise<void> {
    try {
      await this.persistThreadRunStatus(run, status, updatedAt)
    } catch (error) {
      logger.warn({
        error: errorLogPayload(error),
        runId: run.id,
        threadId: run.threadId,
        status,
      }, 'thread run-status projection failed')
    }
  }

  private updateThreadProjectionFromItem(item: ConversationItem): void {
    if (!item.threadId) return
    const thread = this.index.getThreadOrNull(item.threadId)
    if (!thread) return

    let next = thread
    if (item.itemType === 'message' && item.role === 'assistant') {
      const summary = summarizeAssistantText(item.body ?? '')
      if (summary && thread.latestAssistantSummary !== summary) {
        next = { ...next, latestAssistantSummary: summary }
      }
    }
    if (item.itemType === 'result') {
      const run = this.index.getRunOrNull(item.runId)
      if (run && thread.latestRunStatus !== run.status) {
        next = { ...next, latestRunStatus: run.status }
      }
    }

    if (next === thread) return
    next = { ...next, updatedAt: nowUtc() }
    this.index.setThread(next)
  }

  private updateThreadProjectionFromArtifacts(
    run: AnalysisRun,
    artifacts: readonly ArtifactRef[],
  ): void {
    const latest = [...artifacts].reverse().find(artifact => !artifact.isIntermediate)
    if (!latest || !run.threadId) return
    const thread = this.index.getThreadOrNull(run.threadId)
    if (!thread) return
    this.index.setThread({
      ...thread,
      latestArtifactId: latest.artifactId,
      latestArtifactName: latest.name,
      updatedAt: nowUtc(),
    })
  }

  private getOrCreateActiveItemStream(runId: string): RunItemStreamState {
    const existing = this.itemStreams.get(runId)
    if (existing) return existing
    const stream = { streamId: makeId('itemstream'), items: new Map<string, StreamedConversationItem>() }
    this.itemStreams.set(runId, stream)
    return stream
  }

  private captureItemStream(runId: string): RunItemStreamState {
    const existing = this.itemStreams.get(runId)
    if (existing) {
      return {
        streamId: existing.streamId,
        items: new Map([...existing.items].map(([itemId, item]) => [itemId, {
          item: structuredClone(item.item),
          textChunks: [...item.textChunks],
          utf16Length: item.utf16Length,
          sequence: item.sequence,
          hasBodyDeltas: item.hasBodyDeltas,
        }])),
      }
    }
    const run = this.get(runId)
    if (run.status !== 'completed' && run.status !== 'failed' && run.status !== 'cancelled') {
      const active = this.getOrCreateActiveItemStream(runId)
      return { streamId: active.streamId, items: new Map() }
    }
    return {
      streamId: `snapshot:${run.id}:${run.updatedAt}`,
      items: new Map(),
    }
  }

  private shouldPersistItem(item: ConversationItem): boolean {
    if (item.status !== 'running') {
      this.durableRunningItems.get(item.runId)?.delete(item.itemId)
      return true
    }

    let itemIds = this.durableRunningItems.get(item.runId)
    if (!itemIds) {
      itemIds = new Set<string>()
      this.durableRunningItems.set(item.runId, itemIds)
    }
    if (itemIds.has(item.itemId)) return false
    itemIds.add(item.itemId)
    return true
  }

  private async serializeStateMutation<T>(runId: string, mutation: () => Promise<T>): Promise<T> {
    const previous = this.stateMutationTails.get(runId) ?? Promise.resolve()
    const pending = previous.then(mutation, mutation)
    const tail = pending.then(() => undefined, () => undefined)
    this.stateMutationTails.set(runId, tail)
    try {
      return await pending
    } finally {
      if (this.stateMutationTails.get(runId) === tail) this.stateMutationTails.delete(runId)
    }
  }

  private async serializeItemMutation<T>(runId: string, mutation: () => Promise<T>): Promise<T> {
    const previous = this.itemMutationTails.get(runId) ?? Promise.resolve()
    const pending = previous.then(mutation, mutation)
    const tail = pending.then(() => undefined, () => undefined)
    this.itemMutationTails.set(runId, tail)
    try {
      return await pending
    } finally {
      if (this.itemMutationTails.get(runId) === tail) this.itemMutationTails.delete(runId)
    }
  }

  private beginItemRunClosure(runId: string): void {
    this.pendingItemRunClosures.set(runId, (this.pendingItemRunClosures.get(runId) ?? 0) + 1)
    this.closedItemRuns.add(runId)
  }

  private finishItemRunClosure(runId: string): void {
    const remaining = Math.max(0, (this.pendingItemRunClosures.get(runId) ?? 1) - 1)
    if (remaining > 0) this.pendingItemRunClosures.set(runId, remaining)
    else this.pendingItemRunClosures.delete(runId)
    this.refreshItemWriteFence(runId)
  }

  private reopenItemWrites(runId: string): void {
    this.committedItemRunClosures.delete(runId)
    this.refreshItemWriteFence(runId)
  }

  private refreshItemWriteFence(runId: string): void {
    if (this.committedItemRunClosures.has(runId) || (this.pendingItemRunClosures.get(runId) ?? 0) > 0) {
      this.closedItemRuns.add(runId)
      return
    }
    this.closedItemRuns.delete(runId)
  }
}

function modelTokenDelta(
  before: Record<string, number>,
  after: Record<string, number>,
): number {
  const previous = normalizedModelTokens(before.modelTotalTokens)
  const current = normalizedModelTokens(after.modelTotalTokens)
  if (current < previous) throw new Error('模型累计词元不能回退')
  return current - previous
}

function normalizedModelTokens(value: number | undefined): number {
  if (value === undefined) return 0
  if (!Number.isInteger(value) || value < 0) throw new Error('模型累计词元必须是非负整数')
  return value
}

function materializeStreamedItem(live: StreamedConversationItem): ConversationItem {
  const text = live.textChunks.length > 0 ? live.textChunks.join('') : live.item.body
  return {
    ...live.item,
    body: text,
  }
}

function isTerminalItemStatus(status: string | null): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function orderConversationItems(items: ConversationItem[]): ConversationItem[] {
  const ordered = [...items].sort((left, right) => left.timestamp.localeCompare(right.timestamp))
  const positions = new Map(ordered.map((item, index) => [item.itemId, index]))
  const firstToolIdByCall = new Map<string, string>()
  for (const item of ordered) {
    if (item.itemType === 'function_call' && item.callId && !firstToolIdByCall.has(item.callId)) {
      firstToolIdByCall.set(item.callId, item.itemId)
    }
  }

  // Chat Completions 的一条 assistant 输出可以同时包含可见正文和 tool_call。
  // 用显式关系构建一次线性投影，避免为每条正文重复 findIndex/splice。
  const preamblesByToolId = new Map<string, ConversationItem[]>()
  const movedItemIds = new Set<string>()
  for (const item of ordered) {
    const callId = item.metadata.assistantContentForCallId
    const toolId = item.itemType === 'message' && typeof callId === 'string'
      ? firstToolIdByCall.get(callId)
      : undefined
    if (!toolId || (positions.get(item.itemId) ?? -1) < (positions.get(toolId) ?? -1)) continue
    const preambles = preamblesByToolId.get(toolId) ?? []
    preambles.push(item)
    preamblesByToolId.set(toolId, preambles)
    movedItemIds.add(item.itemId)
  }

  const projected: ConversationItem[] = []
  for (const item of ordered) {
    if (movedItemIds.has(item.itemId)) continue
    projected.push(...preamblesByToolId.get(item.itemId) ?? [], item)
  }
  return projected
}
