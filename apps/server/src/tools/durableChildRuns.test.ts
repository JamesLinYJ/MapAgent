import { describe, expect, it, vi } from 'vitest'

import type { ChildRunManager } from '../agent-runtime/children/ChildRunManager.js'
import { ToolRegistry } from '../framework/registry.js'
import type { ToolContext } from '../framework/types.js'
import type { AuthContext } from '../security/types.js'
import { createDurableChildRunsProvider } from './durableChildRuns.js'

describe('durable child run tools', () => {
  it('uses the current Turn and tool call as canonical spawn identity', async () => {
    const manager = fakeManager()
    const registry = new ToolRegistry()
    registry.register(createDurableChildRunsProvider(manager as unknown as ChildRunManager))

    const output = await registry.execute('spawn_child_run', {
      task_name: 'district_audit',
      role: '核验区划数据',
      message: '独立核验当前区划数据。',
      fork_turns: '3',
      reasoning: 'none',
      max_model_tokens: 4_000,
    }, context())

    expect(manager.spawn).toHaveBeenCalledWith(expect.objectContaining({
      parentRunId: 'run_root',
      parentTurnId: 'turn_current',
      rootTurnId: 'turn_root',
      spawnCallId: 'call_spawn',
      taskName: 'district_audit',
      forkTurns: 3,
      reasoningOverride: 'none',
      maxModelTokens: 4_000,
      auth: expect.objectContaining({ userId: 'user_1' }),
    }))
    expect(output.payload.child).toEqual(expect.objectContaining({ runId: 'run_child' }))
  })

  it('keeps queue-only messages separate from trigger-turn input', async () => {
    const manager = fakeManager()
    const registry = new ToolRegistry()
    registry.register(createDurableChildRunsProvider(manager as unknown as ChildRunManager))

    await registry.execute('send_child_message', {
      child_run_id: 'run_child',
      message: '仅同步状态。',
    }, context())
    expect(manager.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      senderRunId: 'run_root',
      receiverRunId: 'run_child',
      messageId: 'agent_message_call_spawn',
      triggerTurn: false,
    }))
    expect(manager.sendInput).not.toHaveBeenCalled()

    await registry.execute('send_child_input', {
      child_run_id: 'run_child',
      message: '现在继续核验。',
    }, { ...context(), toolCallId: 'call_input' })
    expect(manager.sendInput).toHaveBeenCalledWith(expect.objectContaining({
      messageId: 'agent_message_call_input',
      content: '现在继续核验。',
    }))
  })

  it('rejects calls outside an Agent execution context and exposes reads as shared', async () => {
    const manager = fakeManager()
    const registry = new ToolRegistry()
    registry.register(createDurableChildRunsProvider(manager as unknown as ChildRunManager))

    const invalid = context()
    delete invalid.toolCallId
    await expect(registry.execute('list_child_runs', {}, invalid))
      .rejects.toThrow(/稳定 Turn\/Call 身份/u)

    expect(registry.get('list_child_runs')).toMatchObject({
      isReadOnly: true,
      parallelSafe: true,
      runtimePolicy: { effect: 'read', parallelism: 'shared', replayPolicy: 'safe' },
    })
    expect(registry.get('spawn_child_run')).toMatchObject({
      isReadOnly: false,
      requiresApproval: false,
      runtimePolicy: {
        effect: 'world_write',
        parallelism: 'exclusive',
        replayPolicy: 'idempotency_key',
      },
    })
  })
})

function fakeManager() {
  const child = {
    runId: 'run_child',
    rootRunId: 'run_root',
    parentRunId: 'run_root',
    parentTurnId: 'turn_current',
    rootTurnId: 'turn_root',
    spawnCallId: 'call_spawn',
    agentPath: '/root/district_audit',
    taskName: 'district_audit',
    role: '核验区划数据',
    status: 'queued',
    spawnDepth: 1,
    forkMode: 'last_n_turns',
    forkTurnCount: 3,
    modelOverride: null,
    reasoningOverride: 'none',
    budget: {
      maxModelTokens: 4_000,
      maxWallClockMs: null,
      usedModelTokens: 0,
      startedAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:00.000Z',
    },
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
  }
  const message = {
    messageId: 'agent_message_call_spawn',
    rootRunId: 'run_root',
    senderRunId: 'run_root',
    receiverRunId: 'run_child',
    parentTurnId: 'turn_current',
    rootTurnId: 'turn_root',
    sequence: 1,
    kind: 'message',
    content: '仅同步状态。',
    triggerTurn: false,
    status: 'queued',
    createdAt: '2026-08-24T00:00:00.000Z',
    deliveredAt: null,
    checkpointedAt: null,
  }
  return {
    spawn: vi.fn().mockResolvedValue(child),
    list: vi.fn().mockResolvedValue([child]),
    sendInput: vi.fn().mockResolvedValue({ ...message, kind: 'input', triggerTurn: true }),
    sendMessage: vi.fn().mockResolvedValue(message),
    wait: vi.fn().mockResolvedValue({ timedOut: false, children: [child], messages: [message] }),
    interrupt: vi.fn().mockResolvedValue({ ...child, status: 'cancelled' }),
    resume: vi.fn().mockResolvedValue({ ...child, status: 'queued' }),
  }
}

function context(): ToolContext {
  return {
    runId: 'run_root',
    sessionId: 'session_1',
    threadId: 'thread_1',
    turnId: 'turn_current',
    rootTurnId: 'turn_root',
    toolCallId: 'call_spawn',
    signal: new AbortController().signal,
    auth: {
      userId: 'user_1',
      authSessionId: 'auth_session_1',
      roles: [],
    } as AuthContext,
    state: new Map(),
    resolveValueRef: () => { throw new Error('测试未使用 valueRef') },
    invokeStructuredModel: async () => { throw new Error('测试未调用模型') },
    log: () => undefined,
  }
}
