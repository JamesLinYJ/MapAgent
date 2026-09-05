// +-------------------------------------------------------------------------
//
//   地理智能平台 - 持久子运行控制面
//
//   文件:       ChildRunManager.ts
//
//   日期:       2026年08月24日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type {
  AgentMessage,
  AgentMessageKind,
  ChildRunDescriptor,
} from '@geo-agent-platform/shared-types/child-run'

import type { RunTaskCompletionTarget } from '../../agent/runTaskManager.js'
import type { RunOptions } from '../../agent/runtimeTypes.js'
import type { AnalysisRun, AgentThreadRecord, ThreadManifest } from '../../schemas/types.js'
import type { AuthContext } from '../../security/types.js'
import type {
  AppendAgentMessageInput,
  PostgresChildRunRepository,
} from '../../store/postgres/childRunRepository.js'

type ChildRunRepository = Pick<PostgresChildRunRepository,
  | 'appendMessage'
  | 'checkpointDeliveredMessages'
  | 'findBySpawn'
  | 'getDescriptor'
  | 'listChildren'
  | 'listDescendants'
  | 'listTerminalChildren'
  | 'listMessages'
  | 'markMessageDelivered'
>

interface ChildRunStore {
  getRun(runId: string): AnalysisRun
  getThreadManifest(threadId: string): Promise<ThreadManifest>
  createThread(sessionId: string, title?: string | null): Promise<AgentThreadRecord>
  deleteThread(threadId: string): Promise<void>
  forkThread(
    sourceThreadId: string,
    sourceEntryId: string,
    title?: string | null,
    lastNTurns?: number | null,
  ): Promise<AgentThreadRecord>
  createRun(sessionId: string, query: string, options: {
    threadId: string
    modelProvider: string | null
    modelName: string | null
    runProfile: AnalysisRun['state']['runProfile']
    runtimeConfigSnapshot: AnalysisRun['runtimeConfigSnapshot']
    childIdentity: {
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
  }): Promise<AnalysisRun>
  updateRunStatus(runId: string, status: AnalysisRun['status']): Promise<AnalysisRun>
}

interface ChildRunTasks {
  activeRunIds(): string[]
  startDetached(options: RunOptions, target?: RunTaskCompletionTarget): void
  startDetachedIfIdle(options: RunOptions, target?: RunTaskCompletionTarget): boolean
  cancel(runId: string): Promise<AnalysisRun>
  steer(runId: string, steeringId: string, content: string): Promise<unknown>
}

export interface SpawnChildRunInput {
  parentRunId: string
  parentTurnId: string
  rootTurnId: string
  spawnCallId: string
  taskName: string
  role: string
  message: string
  forkTurns: 'none' | 'all' | number
  modelOverride?: string | null
  reasoningOverride?: string | null
  maxModelTokens?: number | null
  maxWallClockMs?: number | null
  auth: AuthContext
}

export interface SendAgentMessageInput {
  senderRunId: string
  receiverRunId: string
  parentTurnId: string
  rootTurnId: string
  messageId: string
  kind: AgentMessageKind
  content: string
  triggerTurn: boolean
  auth: AuthContext
}

export interface WaitChildRunsResult {
  timedOut: boolean
  children: ChildRunDescriptor[]
  messages: AgentMessage[]
}

/**
 * 根 Run 作用域内的持久控制面。它创建独立 Run/Thread，运行任务仍只通过
 * RunTaskManager 启动；跨 Run 通信先写 mailbox，再决定是否触发目标 Turn。
 */
export class ChildRunManager {
  private readonly waiters = new Map<string, Set<() => void>>()

  constructor(private readonly dependencies: {
    store: ChildRunStore
    repository: ChildRunRepository
    tasks: ChildRunTasks
  }) {}

  async spawn(input: SpawnChildRunInput): Promise<ChildRunDescriptor> {
    const normalized = normalizeSpawn(input)
    const parent = this.dependencies.store.getRun(input.parentRunId)
    requireRunAuthorization(parent, input.auth)
    const existing = await this.dependencies.repository.findBySpawn(parent.id, input.spawnCallId)
    if (existing) {
      assertSameSpawn(existing, this.dependencies.store.getRun(existing.runId), normalized)
      return existing
    }
    if (parent.status !== 'running') throw new Error(`父运行 '${parent.id}' 当前不能生成 child Run`)
    if (!parent.threadId) throw new Error(`父运行 '${parent.id}' 缺少 threadId`)
    const rootRunId = parent.rootRunId ?? parent.id
    const rootTurnId = parent.runKind === 'child' ? parent.rootTurnId : normalized.rootTurnId
    if (!rootTurnId || rootTurnId !== normalized.rootTurnId) {
      throw new Error('spawn 的 rootTurnId 与父 child 身份不一致')
    }
    const fork = resolveFork(normalized.forkTurns)
    const thread = await this.createChildThread(parent, normalized.taskName, fork)
    let child: AnalysisRun
    try {
      child = await this.dependencies.store.createRun(parent.sessionId, normalized.message, {
        threadId: thread.id,
        modelProvider: parent.modelProvider,
        modelName: normalized.modelOverride ?? parent.modelName,
        runProfile: parent.state.runProfile,
        runtimeConfigSnapshot: parent.runtimeConfigSnapshot,
        childIdentity: {
          rootRunId,
          parentRunId: parent.id,
          parentTurnId: normalized.parentTurnId,
          rootTurnId,
          spawnCallId: normalized.spawnCallId,
          agentPath: `${parent.agentPath}/${normalized.taskName}`,
          taskName: normalized.taskName,
          agentRole: normalized.role,
          spawnDepth: parent.spawnDepth + 1,
          forkMode: fork.mode,
          forkTurnCount: fork.turnCount,
          modelOverride: normalized.modelOverride,
          reasoningOverride: normalized.reasoningOverride,
          maxModelTokens: normalized.maxModelTokens,
          maxWallClockMs: normalized.maxWallClockMs,
        },
      })
    } catch (error) {
      await this.dependencies.store.deleteThread(thread.id)
      throw error
    }
    const descriptor = await this.requireDescriptor(child.id)
    this.dependencies.tasks.startDetached(
      this.runOptions(child, input.auth, false),
      { onComplete: runId => this.onChildSettled(runId) },
    )
    this.notify(rootRunId)
    return descriptor
  }

  list(parentRunId: string, recursive = false): Promise<ChildRunDescriptor[]> {
    const parent = this.dependencies.store.getRun(parentRunId)
    const rootRunId = parent.rootRunId ?? parent.id
    return recursive
      ? this.dependencies.repository.listDescendants(rootRunId)
      : this.dependencies.repository.listChildren(parentRunId)
  }

  async sendInput(input: Omit<SendAgentMessageInput, 'kind' | 'triggerTurn'>): Promise<AgentMessage> {
    return this.sendMessage({ ...input, kind: 'input', triggerTurn: true })
  }

  async sendMessage(input: SendAgentMessageInput): Promise<AgentMessage> {
    const sender = this.dependencies.store.getRun(input.senderRunId)
    const receiver = this.dependencies.store.getRun(input.receiverRunId)
    requireRunAuthorization(sender, input.auth)
    requireRunAuthorization(receiver, input.auth)
    if ((sender.rootRunId ?? sender.id) !== (receiver.rootRunId ?? receiver.id)) {
      throw new Error('智能体消息不能跨根运行发送')
    }
    if (input.triggerTurn) assertTriggerable(receiver, this.isActive(receiver.id))
    const message = await this.dependencies.repository.appendMessage(messageRequest(input))
    this.notify(message.rootRunId)
    if (!input.triggerTurn || message.status !== 'queued') return message
    if (this.isActive(receiver.id)) {
      await this.dependencies.tasks.steer(receiver.id, message.messageId, modelMessage(message))
      return this.dependencies.repository.markMessageDelivered(receiver.id, message.messageId)
    }
    const resume = receiver.status === 'interrupted'
    const started = this.dependencies.tasks.startDetachedIfIdle(
      this.runOptions(receiver, input.auth, resume),
      receiver.runKind === 'child' ? { onComplete: runId => this.onChildSettled(runId) } : {},
    )
    if (!started) throw new Error(`运行 '${receiver.id}' 的 trigger-turn 启动发生竞争`)
    return message
  }

  async wait(input: {
    callerRunId: string
    childRunIds?: readonly string[]
    afterMessageSequence?: number
    timeoutMs?: number
    signal?: AbortSignal
  }): Promise<WaitChildRunsResult> {
    const caller = this.dependencies.store.getRun(input.callerRunId)
    const rootRunId = caller.rootRunId ?? caller.id
    const timeoutMs = Math.min(60_000, Math.max(100, input.timeoutMs ?? 10_000))
    const snapshot = await this.waitSnapshot(caller.id, rootRunId, input)
    if (hasWaitActivity(snapshot, input.afterMessageSequence ?? 0)) return { timedOut: false, ...snapshot }
    const timedOut = await this.waitForNotification(rootRunId, timeoutMs, input.signal)
    return {
      timedOut,
      ...await this.waitSnapshot(caller.id, rootRunId, input),
    }
  }

  async interrupt(callerRunId: string, childRunId: string, auth: AuthContext): Promise<ChildRunDescriptor> {
    const caller = this.dependencies.store.getRun(callerRunId)
    const child = this.dependencies.store.getRun(childRunId)
    requireRunAuthorization(caller, auth)
    requireRunAuthorization(child, auth)
    if (child.runKind !== 'child') throw new Error('根 Run 不能作为 interrupt_child_run 目标')
    if ((caller.rootRunId ?? caller.id) !== child.rootRunId) throw new Error('不能中断其它根运行的 child')
    if (this.isActive(child.id)) {
      await this.dependencies.tasks.cancel(child.id)
    } else if (!isTerminal(child.status)) {
      await this.dependencies.store.updateRunStatus(child.id, 'cancelled')
    }
    this.notify(child.rootRunId!)
    return this.requireDescriptor(child.id)
  }

  async resume(callerRunId: string, childRunId: string, auth: AuthContext): Promise<ChildRunDescriptor> {
    const caller = this.dependencies.store.getRun(callerRunId)
    const child = this.dependencies.store.getRun(childRunId)
    requireRunAuthorization(caller, auth)
    requireRunAuthorization(child, auth)
    if (child.runKind !== 'child') throw new Error('只有 child Run 可以独立恢复')
    if ((caller.rootRunId ?? caller.id) !== child.rootRunId) throw new Error('不能恢复其它根运行的 child')
    if (child.status !== 'interrupted') throw new Error(`child Run '${child.id}' 当前不能恢复`)
    const started = this.dependencies.tasks.startDetachedIfIdle(
      this.runOptions(child, auth, true),
      { onComplete: runId => this.onChildSettled(runId) },
    )
    if (!started) throw new Error(`child Run '${child.id}' 已有活动执行器`)
    this.notify(child.rootRunId!)
    return this.requireDescriptor(child.id)
  }

  async checkpointMailbox(runId: string): Promise<AgentMessage[]> {
    return this.dependencies.repository.checkpointDeliveredMessages(runId)
  }

  async reconcileTerminalCompletions(): Promise<number> {
    const terminalChildren = await this.dependencies.repository.listTerminalChildren()
    for (const descriptor of terminalChildren) {
      await this.publishCompletion(this.dependencies.store.getRun(descriptor.runId), descriptor)
    }
    return terminalChildren.length
  }

  private async createChildThread(
    parent: AnalysisRun,
    taskName: string,
    fork: { mode: 'none' | 'full_history' | 'last_n_turns'; turnCount: number | null },
  ): Promise<AgentThreadRecord> {
    if (fork.mode === 'none') return this.dependencies.store.createThread(parent.sessionId, taskName)
    const manifest = await this.dependencies.store.getThreadManifest(parent.threadId!)
    if (!manifest.activeLeafEntryId) throw new Error('父线程没有可 fork 的 canonical history')
    return this.dependencies.store.forkThread(
      parent.threadId!,
      manifest.activeLeafEntryId,
      taskName,
      fork.turnCount,
    )
  }

  private async onChildSettled(runId: string): Promise<void> {
    const child = this.dependencies.store.getRun(runId)
    const descriptor = await this.requireDescriptor(runId)
    this.notify(descriptor.rootRunId)
    if (!isTerminal(child.status)) return
    await this.publishCompletion(child, descriptor)
  }

  private async publishCompletion(child: AnalysisRun, descriptor: ChildRunDescriptor): Promise<void> {
    await this.dependencies.repository.appendMessage({
      messageId: `child_completion_${child.id}`,
      senderRunId: child.id,
      receiverRunId: descriptor.parentRunId,
      parentTurnId: descriptor.parentTurnId,
      rootTurnId: descriptor.rootTurnId,
      kind: 'completion',
      content: childCompletion(child),
      triggerTurn: false,
    })
    this.notify(descriptor.rootRunId)
  }

  private async requireDescriptor(runId: string): Promise<ChildRunDescriptor> {
    const descriptor = await this.dependencies.repository.getDescriptor(runId)
    if (!descriptor) throw new Error(`child Run '${runId}' 缺少持久描述`)
    return descriptor
  }

  private runOptions(run: AnalysisRun, auth: AuthContext, resume: boolean): RunOptions {
    if (!run.threadId) throw new Error(`运行 '${run.id}' 缺少 threadId`)
    if (!run.modelProvider) throw new Error(`运行 '${run.id}' 缺少模型 provider`)
    if (!run.runtimeConfigSnapshot) throw new Error(`运行 '${run.id}' 缺少运行时配置快照`)
    return {
      runId: run.id,
      threadId: run.threadId,
      sessionId: run.sessionId,
      query: run.userQuery,
      provider: run.modelProvider,
      modelName: run.modelOverride ?? run.modelName,
      runtimeConfig: run.runtimeConfigSnapshot,
      executionMode: run.state.planMode ? 'plan' : 'auto',
      runProfile: run.state.runProfile,
      reasoning: run.reasoningOverride !== 'none',
      resume,
      auth,
    }
  }

  private async waitSnapshot(
    callerRunId: string,
    rootRunId: string,
    input: { childRunIds?: readonly string[]; afterMessageSequence?: number },
  ): Promise<{ children: ChildRunDescriptor[]; messages: AgentMessage[] }> {
    const selected = input.childRunIds?.length ? new Set(input.childRunIds) : null
    const children = (await this.dependencies.repository.listDescendants(rootRunId))
      .filter(child => !selected || selected.has(child.runId))
    if (selected && children.length !== selected.size) throw new Error('wait_child_runs 包含未知或越权 child Run')
    return {
      children,
      messages: (await this.dependencies.repository.listMessages(callerRunId))
        .filter(message => message.sequence > (input.afterMessageSequence ?? 0)),
    }
  }

  private waitForNotification(rootRunId: string, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new Error('等待 child Run 已取消'))
        return
      }
      const listeners = this.waiters.get(rootRunId) ?? new Set<() => void>()
      this.waiters.set(rootRunId, listeners)
      const cleanup = (): void => {
        clearTimeout(timer)
        listeners.delete(onActivity)
        if (!listeners.size) this.waiters.delete(rootRunId)
        signal?.removeEventListener('abort', onAbort)
      }
      const onActivity = (): void => {
        cleanup()
        resolve(false)
      }
      const onAbort = (): void => {
        cleanup()
        reject(signal?.reason ?? new Error('等待 child Run 已取消'))
      }
      const timer = setTimeout(() => {
        cleanup()
        resolve(true)
      }, timeoutMs)
      listeners.add(onActivity)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  private notify(rootRunId: string): void {
    for (const listener of [...(this.waiters.get(rootRunId) ?? [])]) listener()
  }

  private isActive(runId: string): boolean {
    return this.dependencies.tasks.activeRunIds().includes(runId)
  }
}

function normalizeSpawn(input: SpawnChildRunInput): Required<Omit<SpawnChildRunInput, 'auth'>> {
  const taskName = input.taskName.trim()
  if (!/^[a-z0-9_]+$/u.test(taskName)) throw new Error('taskName 只能包含小写字母、数字和下划线')
  const role = input.role.trim()
  const message = input.message.trim()
  if (!role) throw new Error('child Run role 不能为空')
  if (!message) throw new Error('child Run message 不能为空')
  if (!input.parentTurnId.trim() || !input.rootTurnId.trim() || !input.spawnCallId.trim()) {
    throw new Error('child Run 缺少 parent/root turn 或 spawn call 身份')
  }
  return {
    parentRunId: input.parentRunId,
    parentTurnId: input.parentTurnId,
    rootTurnId: input.rootTurnId,
    spawnCallId: input.spawnCallId,
    taskName,
    role,
    message,
    forkTurns: input.forkTurns,
    modelOverride: input.modelOverride?.trim() || null,
    reasoningOverride: input.reasoningOverride?.trim() || null,
    maxModelTokens: input.maxModelTokens ?? null,
    maxWallClockMs: input.maxWallClockMs ?? null,
  }
}

function resolveFork(value: SpawnChildRunInput['forkTurns']): {
  mode: 'none' | 'full_history' | 'last_n_turns'
  turnCount: number | null
} {
  if (value === 'none') return { mode: 'none', turnCount: null }
  if (value === 'all') return { mode: 'full_history', turnCount: null }
  if (!Number.isInteger(value) || value <= 0) throw new Error('forkTurns 必须是 none、all 或正整数')
  return { mode: 'last_n_turns', turnCount: value }
}

function assertSameSpawn(
  descriptor: ChildRunDescriptor,
  run: AnalysisRun,
  input: Required<Omit<SpawnChildRunInput, 'auth'>>,
): void {
  const fork = resolveFork(input.forkTurns)
  const same = descriptor.taskName === input.taskName
    && descriptor.role === input.role
    && descriptor.parentTurnId === input.parentTurnId
    && descriptor.rootTurnId === input.rootTurnId
    && descriptor.forkMode === fork.mode
    && descriptor.forkTurnCount === fork.turnCount
    && descriptor.modelOverride === input.modelOverride
    && descriptor.reasoningOverride === input.reasoningOverride
    && descriptor.budget.maxModelTokens === input.maxModelTokens
    && descriptor.budget.maxWallClockMs === input.maxWallClockMs
    && run.userQuery === input.message
  if (!same) throw new Error(`spawnCallId '${descriptor.spawnCallId}' 已用于不同 child Run 请求`)
}

function messageRequest(input: SendAgentMessageInput): AppendAgentMessageInput {
  return {
    messageId: input.messageId,
    senderRunId: input.senderRunId,
    receiverRunId: input.receiverRunId,
    parentTurnId: input.parentTurnId,
    rootTurnId: input.rootTurnId,
    kind: input.kind,
    content: input.content,
    triggerTurn: input.triggerTurn,
  }
}

function requireRunAuthorization(run: AnalysisRun, auth: AuthContext): void {
  if (!run.workspaceId) throw new Error(`运行 '${run.id}' 缺少 workspaceId`)
  const roles = auth.roles
    .filter(binding => binding.workspaceId === run.workspaceId)
    .map(binding => binding.role)
  if (!roles.length) throw new Error('不能控制其它工作区的 Run')
  if (run.createdByUserId !== auth.userId
    && !roles.some(role => role === 'workspace_admin' || role === 'platform_admin')) {
    throw new Error('当前身份不能控制该 Run')
  }
}

function assertTriggerable(run: AnalysisRun, active: boolean): void {
  if (active) return
  if (run.status !== 'queued' && run.status !== 'interrupted') {
    throw new Error(`运行 '${run.id}' 当前状态 '${run.status}' 不能由智能体消息触发 Turn`)
  }
}

function modelMessage(message: AgentMessage): string {
  return `来自运行 '${message.senderRunId}' 的智能体消息：${message.content}`
}

function childCompletion(run: AnalysisRun): string {
  return JSON.stringify({
    childRunId: run.id,
    status: run.status,
    summary: run.state.failure?.message ?? run.state.runLifecycle.reason ?? run.userQuery,
    artifactIds: run.state.artifacts.map(artifact => artifact.artifactId),
    valueRefIds: run.state.toolValueRefs.map(value => value.refId),
  })
}

function hasWaitActivity(
  snapshot: { children: ChildRunDescriptor[]; messages: AgentMessage[] },
  afterMessageSequence: number,
): boolean {
  return snapshot.messages.some(message => message.sequence > afterMessageSequence)
    || snapshot.children.some(child => isTerminal(child.status))
}

function isTerminal(status: AnalysisRun['status']): boolean {
  return ['completed', 'failed', 'cancelled', 'requires_action'].includes(status)
}
