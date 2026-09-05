import { describe, expect, it, vi } from 'vitest'

import {
  agentMessageSchema,
  childRunDescriptorSchema,
  type AgentMessage,
  type ChildRunDescriptor,
} from '@geo-agent-platform/shared-types/child-run'

import { defaultRuntimeConfig } from '../../agent/defaultRuntimeConfig.js'
import type { RunTaskCompletionTarget } from '../../agent/runTaskManager.js'
import type { RunOptions } from '../../agent/runtimeTypes.js'
import { agentStateSchema, analysisRunSchema, type AnalysisRun } from '../../schemas/types.js'
import type { AuthContext } from '../../security/types.js'
import { ChildRunManager } from './ChildRunManager.js'

describe('ChildRunManager', () => {
  it('spawns one independent Run per stable call and reconciles terminal completion idempotently', async () => {
    const harness = createHarness()
    const input = {
      parentRunId: 'run_root',
      parentTurnId: 'turn_parent',
      rootTurnId: 'turn_root',
      spawnCallId: 'call_spawn_child',
      taskName: 'district_audit',
      role: '区划核验',
      message: '核验区划数据。',
      forkTurns: 2 as const,
      maxModelTokens: 4_000,
      auth: harness.auth,
    }

    const first = await harness.manager.spawn(input)
    const replay = await harness.manager.spawn(input)

    expect(replay).toEqual(first)
    expect(first).toMatchObject({
      parentRunId: 'run_root',
      rootRunId: 'run_root',
      rootTurnId: 'turn_root',
      forkMode: 'last_n_turns',
      forkTurnCount: 2,
    })
    expect(harness.store.forkThread).toHaveBeenCalledWith(
      'thread_root',
      'entry_parent',
      'district_audit',
      2,
    )
    expect(harness.tasks.startDetached).toHaveBeenCalledOnce()

    harness.updateStatus(first.runId, 'completed')
    await harness.completionTarget?.onComplete?.(first.runId)
    expect(harness.messages).toHaveLength(1)
    expect(harness.messages[0]).toMatchObject({
      messageId: `child_completion_${first.runId}`,
      senderRunId: first.runId,
      receiverRunId: 'run_root',
      kind: 'completion',
      triggerTurn: false,
    })

    expect(await harness.manager.reconcileTerminalCompletions()).toBe(1)
    expect(harness.messages).toHaveLength(1)

    const afterCompletion = await harness.manager.wait({
      callerRunId: 'run_root',
      afterMessageSequence: harness.messages[0]!.sequence,
      timeoutMs: 100,
    })
    expect(afterCompletion.timedOut).toBe(false)
    expect(afterCompletion.messages).toEqual([])
  })

  it('separates queue-only delivery, active steering, interrupt and root-scoped resume', async () => {
    const harness = createHarness()
    const child = await harness.manager.spawn({
      parentRunId: 'run_root',
      parentTurnId: 'turn_parent',
      rootTurnId: 'turn_root',
      spawnCallId: 'call_spawn_messages',
      taskName: 'message_target',
      role: '消息目标',
      message: '等待消息。',
      forkTurns: 'none',
      auth: harness.auth,
    })

    const queued = await harness.manager.sendMessage({
      senderRunId: 'run_root',
      receiverRunId: child.runId,
      parentTurnId: 'turn_parent',
      rootTurnId: 'turn_root',
      messageId: 'message_queue_only',
      kind: 'message',
      content: '仅同步状态。',
      triggerTurn: false,
      auth: harness.auth,
    })
    expect(queued.status).toBe('queued')
    expect(harness.tasks.steer).not.toHaveBeenCalled()

    const delivered = await harness.manager.sendInput({
      senderRunId: 'run_root',
      receiverRunId: child.runId,
      parentTurnId: 'turn_parent',
      rootTurnId: 'turn_root',
      messageId: 'message_trigger',
      content: '立即继续。',
      auth: harness.auth,
    })
    expect(harness.tasks.steer).toHaveBeenCalledWith(
      child.runId,
      'message_trigger',
      expect.stringContaining('立即继续。'),
    )
    expect(delivered.status).toBe('delivered')

    await harness.manager.interrupt('run_root', child.runId, harness.auth)
    expect(harness.tasks.cancel).toHaveBeenCalledWith(child.runId)
    expect(harness.tasks.cancel).not.toHaveBeenCalledWith('run_root')

    harness.updateStatus(child.runId, 'interrupted')
    await harness.manager.resume('run_root', child.runId, harness.auth)
    expect(harness.tasks.startDetachedIfIdle).toHaveBeenCalledWith(
      expect.objectContaining({ runId: child.runId, resume: true }),
      expect.objectContaining({ onComplete: expect.any(Function) }),
    )
  })
})

function createHarness() {
  const runs = new Map<string, AnalysisRun>()
  const messages: AgentMessage[] = []
  const active = new Set<string>()
  let childSequence = 0
  let threadSequence = 0
  let completionTarget: RunTaskCompletionTarget | undefined
  runs.set('run_root', run({
    id: 'run_root',
    rootRunId: 'run_root',
    threadId: 'thread_root',
    status: 'running',
    userQuery: '协调任务',
  }))

  type ChildIdentity = {
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
  type CreateRunOptions = {
    threadId: string
    modelProvider: string | null
    modelName: string | null
    runProfile: AnalysisRun['state']['runProfile']
    runtimeConfigSnapshot: AnalysisRun['runtimeConfigSnapshot']
    childIdentity: ChildIdentity
  }

  const store = {
    getRun: (runId: string) => requireRun(runs, runId),
    getThreadManifest: vi.fn(async () => ({ activeLeafEntryId: 'entry_parent' })),
    createThread: vi.fn(async (sessionId: string, title?: string | null) => ({
      id: `thread_child_${++threadSequence}`,
      sessionId,
      title: title ?? 'child',
    })),
    deleteThread: vi.fn(async () => undefined),
    forkThread: vi.fn(async (sourceThreadId: string, _entryId: string, title?: string | null) => ({
      id: `thread_child_${++threadSequence}`,
      sessionId: requireRun(runs, 'run_root').sessionId,
      title: title ?? sourceThreadId,
    })),
    createRun: vi.fn(async (sessionId: string, query: string, options: CreateRunOptions) => {
      const identity = options.childIdentity
      const created = run({
        id: `run_child_${++childSequence}`,
        rootRunId: identity.rootRunId,
        parentRunId: identity.parentRunId,
        parentTurnId: identity.parentTurnId,
        rootTurnId: identity.rootTurnId,
        spawnCallId: identity.spawnCallId,
        agentPath: identity.agentPath,
        taskName: identity.taskName,
        agentRole: identity.agentRole,
        spawnDepth: identity.spawnDepth,
        forkMode: identity.forkMode,
        forkTurnCount: identity.forkTurnCount,
        modelOverride: identity.modelOverride,
        reasoningOverride: identity.reasoningOverride,
        maxModelTokens: identity.maxModelTokens,
        maxWallClockMs: identity.maxWallClockMs,
        threadId: options.threadId,
        sessionId,
        status: 'queued',
        userQuery: query,
      })
      runs.set(created.id, created)
      return created
    }),
    updateRunStatus: vi.fn(async (runId: string, status: AnalysisRun['status']) => {
      const updated = { ...requireRun(runs, runId), status }
      runs.set(runId, updated)
      return updated
    }),
  }

  const repository = {
    appendMessage: vi.fn(async (input: {
      messageId: string
      senderRunId: string
      receiverRunId: string
      parentTurnId: string
      rootTurnId: string
      kind: AgentMessage['kind']
      content: string
      triggerTurn: boolean
    }) => {
      const existing = messages.find(message => message.messageId === input.messageId)
      if (existing) return existing
      const message = agentMessageSchema.parse({
        ...input,
        rootRunId: requireRun(runs, input.senderRunId).rootRunId,
        sequence: messages.filter(item => item.receiverRunId === input.receiverRunId).length + 1,
        status: 'queued',
        createdAt: '2026-08-24T00:00:00.000Z',
        deliveredAt: null,
        checkpointedAt: null,
      })
      messages.push(message)
      return message
    }),
    checkpointDeliveredMessages: vi.fn(async () => []),
    findBySpawn: vi.fn(async (parentRunId: string, spawnCallId: string) => {
      const found = [...runs.values()].find(candidate => (
        candidate.runKind === 'child'
        && candidate.parentRunId === parentRunId
        && candidate.spawnCallId === spawnCallId
      ))
      return found ? descriptor(found) : null
    }),
    getDescriptor: vi.fn(async (runId: string) => {
      const found = runs.get(runId)
      return found?.runKind === 'child' ? descriptor(found) : null
    }),
    listChildren: vi.fn(async (parentRunId: string) => [...runs.values()]
      .filter(candidate => candidate.parentRunId === parentRunId)
      .map(descriptor)),
    listDescendants: vi.fn(async (rootRunId: string) => [...runs.values()]
      .filter(candidate => candidate.runKind === 'child' && candidate.rootRunId === rootRunId)
      .map(descriptor)),
    listTerminalChildren: vi.fn(async () => [...runs.values()]
      .filter(candidate => candidate.runKind === 'child' && isTerminal(candidate.status))
      .map(descriptor)),
    listMessages: vi.fn(async (receiverRunId: string) => messages
      .filter(message => message.receiverRunId === receiverRunId)),
    markMessageDelivered: vi.fn(async (receiverRunId: string, messageId: string) => {
      const index = messages.findIndex(message => (
        message.receiverRunId === receiverRunId && message.messageId === messageId
      ))
      if (index < 0) throw new Error('message missing')
      const updated = agentMessageSchema.parse({
        ...messages[index]!,
        status: 'delivered',
        deliveredAt: '2026-08-24T00:00:01.000Z',
      })
      messages[index] = updated
      return updated
    }),
  }

  const tasks = {
    activeRunIds: vi.fn(() => [...active]),
    startDetached: vi.fn((options: RunOptions, target?: RunTaskCompletionTarget) => {
      active.add(options.runId)
      completionTarget = target
    }),
    startDetachedIfIdle: vi.fn((options: RunOptions, target?: RunTaskCompletionTarget) => {
      if (active.has(options.runId)) return false
      active.add(options.runId)
      completionTarget = target
      return true
    }),
    cancel: vi.fn(async (runId: string) => {
      active.delete(runId)
      const updated = { ...requireRun(runs, runId), status: 'cancelled' as const }
      runs.set(runId, updated)
      return updated
    }),
    steer: vi.fn(async () => ({})),
  }

  const auth: AuthContext = {
    userId: 'user_1',
    subject: 'user_1',
    email: 'user_1@example.test',
    displayName: '测试用户',
    authSessionId: 'auth_session_1',
    authSessionExpiresAt: null,
    csrfToken: 'csrf',
    defaultWorkspaceId: 'workspace_1',
    roles: [{ workspaceId: 'workspace_1', role: 'analyst' }],
  }

  return {
    auth,
    manager: new ChildRunManager({ store: store as never, repository: repository as never, tasks }),
    messages,
    repository,
    store,
    tasks,
    get completionTarget() { return completionTarget },
    updateStatus(runId: string, status: AnalysisRun['status']) {
      const current = requireRun(runs, runId)
      runs.set(runId, { ...current, status })
      active.delete(runId)
    },
  }
}

function run(input: {
  id: string
  rootRunId: string
  parentRunId?: string | null
  parentTurnId?: string | null
  rootTurnId?: string | null
  spawnCallId?: string | null
  agentPath?: string
  taskName?: string | null
  agentRole?: string | null
  spawnDepth?: number
  forkMode?: 'none' | 'full_history' | 'last_n_turns'
  forkTurnCount?: number | null
  modelOverride?: string | null
  reasoningOverride?: string | null
  maxModelTokens?: number | null
  maxWallClockMs?: number | null
  threadId: string
  sessionId?: string
  status: AnalysisRun['status']
  userQuery: string
}): AnalysisRun {
  const child = Boolean(input.parentRunId)
  return analysisRunSchema.parse({
    id: input.id,
    runKind: child ? 'child' : 'root',
    rootRunId: input.rootRunId,
    parentRunId: input.parentRunId ?? null,
    parentTurnId: input.parentTurnId ?? null,
    rootTurnId: input.rootTurnId ?? null,
    spawnCallId: input.spawnCallId ?? null,
    agentPath: input.agentPath ?? '/root',
    taskName: input.taskName ?? null,
    agentRole: input.agentRole ?? null,
    spawnDepth: input.spawnDepth ?? 0,
    forkMode: input.forkMode ?? 'none',
    forkTurnCount: input.forkTurnCount ?? null,
    modelOverride: input.modelOverride ?? null,
    reasoningOverride: input.reasoningOverride ?? null,
    maxModelTokens: input.maxModelTokens ?? null,
    maxWallClockMs: input.maxWallClockMs ?? null,
    usedModelTokens: 0,
    threadId: input.threadId,
    sessionId: input.sessionId ?? 'session_1',
    workspaceId: 'workspace_1',
    createdByUserId: 'user_1',
    visibility: 'private',
    userQuery: input.userQuery,
    modelProvider: 'deepseek',
    modelName: 'deepseek-v4-flash',
    status: input.status,
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
    state: agentStateSchema.parse({
      sessionId: input.sessionId ?? 'session_1',
      threadId: input.threadId,
      userQuery: input.userQuery,
    }),
    runtimeConfigSnapshot: defaultRuntimeConfig(),
  })
}

function descriptor(run: AnalysisRun): ChildRunDescriptor {
  return childRunDescriptorSchema.parse({
    runId: run.id,
    rootRunId: run.rootRunId,
    parentRunId: run.parentRunId,
    parentTurnId: run.parentTurnId,
    rootTurnId: run.rootTurnId,
    spawnCallId: run.spawnCallId,
    agentPath: run.agentPath,
    taskName: run.taskName,
    role: run.agentRole,
    status: run.status,
    spawnDepth: run.spawnDepth,
    forkMode: run.forkMode,
    forkTurnCount: run.forkTurnCount,
    modelOverride: run.modelOverride,
    reasoningOverride: run.reasoningOverride,
    budget: {
      maxModelTokens: run.maxModelTokens,
      maxWallClockMs: run.maxWallClockMs,
      usedModelTokens: run.usedModelTokens,
      startedAt: run.createdAt,
      updatedAt: run.updatedAt,
    },
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  })
}

function requireRun(runs: Map<string, AnalysisRun>, runId: string): AnalysisRun {
  const found = runs.get(runId)
  if (!found) throw new Error(`run '${runId}' missing`)
  return found
}

function isTerminal(status: AnalysisRun['status']): boolean {
  return ['completed', 'failed', 'cancelled', 'requires_action'].includes(status)
}
