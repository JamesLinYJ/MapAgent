// +-------------------------------------------------------------------------
//
//   地理智能平台 - 本机 Agent 会话控制器测试
//
//   文件:       localAgentSession.test.ts
//
//   日期:       2026年07月27日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { EventEmitter } from 'node:events'

import {
  analysisRunSchema,
  conversationItemSchema,
  runEventSchema,
  runSnapshotSchema,
  workspaceBootstrapSnapshotSchema,
  type AnalysisRun,
  type WsControlCommand,
} from '@geo-agent-platform/shared-types'
import { describe, expect, it, vi } from 'vitest'
import type { z } from 'zod'

import type { LocalAgentPush } from '../transport/localAgentClient.js'
import {
  LocalAgentSession,
  type LocalAgentClientPort,
} from './localAgentSession.js'

describe('LocalAgentSession', () => {
  it('uses the server provider default without forwarding a host CLI model', async () => {
    const client = new TestClient()
    const session = new LocalAgentSession({ connectClient: async () => client })
    await session.initialize()

    await session.submit('杭州明天会下雨吗？')

    const start = client.requests.find(request => request.type === 'run:start')
    expect(start?.payload).toMatchObject({
      query: '杭州明天会下雨吗？',
      provider: 'deepseek',
      executionMode: 'auto',
    })
    expect(start?.payload).not.toHaveProperty('modelName')
    expect(session.snapshot().model).toBe('deepseek-v4-flash')
  })

  it('forwards an explicitly selected model only after provider capability validation', async () => {
    const client = new TestClient()
    const session = new LocalAgentSession({
      connectClient: async () => client,
      model: 'deepseek-v4-flash',
    })
    await session.initialize()

    await session.submit('分析杭州强降水风险')

    expect(client.requests.find(request => request.type === 'run:start')?.payload)
      .toMatchObject({ provider: 'deepseek', modelName: 'deepseek-v4-flash' })
  })

  it('rejects a model that is absent from the provider capability list before run creation', async () => {
    const client = new TestClient()
    const session = new LocalAgentSession({
      connectClient: async () => client,
      model: 'gpt-5.6-sol',
    })

    await expect(session.initialize()).rejects.toThrow('未通过本地能力预检')
    expect(client.requests.some(request => request.type === 'run:start')).toBe(false)
  })

  it('applies cursor-checked text deltas without duplicating the item', async () => {
    const client = new TestClient()
    const session = new LocalAgentSession({ connectClient: async () => client })
    await session.initialize()
    await session.submit('你好')

    client.push(itemPush('', 0))
    client.push(deltaPush('答', 1, 0))
    client.push(deltaPush('案', 2, 1))

    await vi.waitFor(() => {
      expect(session.snapshot().items).toHaveLength(1)
      expect(session.snapshot().items[0]?.body).toBe('答案')
    })
  })

  it('validates every text delta but publishes one UI update per terminal frame', async () => {
    const client = new TestClient()
    const session = new LocalAgentSession({ connectClient: async () => client })
    await session.initialize()
    await session.submit('连续输出')
    const listener = vi.fn()
    session.subscribe(listener)

    client.push(itemPush('', 0))
    client.push(deltaPush('甲', 1, 0))
    client.push(deltaPush('乙', 2, 1))
    client.push(deltaPush('丙', 3, 2))

    expect(session.snapshot().items[0]?.body).toBe('甲乙丙')
    expect(listener).not.toHaveBeenCalled()
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(listener).toHaveBeenCalledOnce()
    expect(listener.mock.calls[0]?.[0].items[0]?.body).toBe('甲乙丙')
  })

  it('resubscribes on a cursor gap and restores the exact authoritative body', async () => {
    const client = new TestClient()
    const session = new LocalAgentSession({ connectClient: async () => client })
    await session.initialize()
    await session.submit('你好')
    client.push(itemPush('', 0))
    const restored = conversationItemSchema.parse({
      itemId: 'item_answer', itemType: 'message', runId: 'run_1', threadId: 'thread_1',
      role: 'assistant', body: '完整答案', status: 'running',
      timestamp: '2026-07-27T00:00:01.000Z',
    })
    client.subscriptionSnapshot = runSnapshotSchema.parse({
      run: client.startRun,
      items: [restored],
      events: [],
      itemStream: {
        streamId: 'stream_1',
        cursors: [{ itemId: restored.itemId, sequence: 2, utf16Offset: 4 }],
      },
    })

    client.push(deltaPush('答案', 2, 2))

    await vi.waitFor(() => expect(session.snapshot().items[0]?.body).toBe('完整答案'))
    expect(client.requests.filter(request => request.type === 'run:subscribe')).toHaveLength(2)
  })

  it('uses a new stream snapshot as an authoritative reset instead of merging stale items', async () => {
    const client = new TestClient()
    const session = new LocalAgentSession({ connectClient: async () => client })
    await session.initialize()
    await session.submit('你好')
    client.push(itemPush('', 0))
    client.push(deltaPush('旧答案', 1, 0))
    expect(session.snapshot().items).toHaveLength(1)

    client.push({
      type: 'run.snapshot',
      id: null,
      payload: { data: runSnapshotSchema.parse({
        run: client.startRun,
        items: [],
        events: [],
        itemStream: { streamId: 'stream_restarted', cursors: [] },
      }) },
    })

    expect(session.snapshot().items).toEqual([])
  })

  it('leaves buffering after a failed resubscribe so later exact deltas can continue', async () => {
    const client = new TestClient()
    const session = new LocalAgentSession({ connectClient: async () => client })
    await session.initialize()
    await session.submit('你好')
    client.push(itemPush('', 0))
    client.subscriptionError = new Error('snapshot unavailable')

    client.push(deltaPush('缺口', 2, 1))
    await vi.waitFor(() => expect(session.snapshot().error).toContain('重同步失败'))
    client.push(deltaPush('恢复', 1, 0))

    await vi.waitFor(() => expect(session.snapshot().items[0]?.body).toBe('恢复'))
  })

  it('preserves a pushed event when authoritative snapshots are projected around it', async () => {
    const client = new TestClient()
    const session = new LocalAgentSession({ connectClient: async () => client })
    await session.initialize()
    await session.submit('事件账本不得回滚')
    const event = runEventSchema.parse({
      eventId: 'event_ledger', runId: 'run_1', threadId: 'thread_1',
      type: 'step.completed', message: '持久化事件',
      timestamp: '2026-07-27T00:00:02.000Z',
    })
    const snapshot = (events: unknown[]) => ({
      type: 'run.snapshot' as const,
      id: null,
      payload: { data: runSnapshotSchema.parse({
        run: client.startRun,
        items: [],
        events,
        itemStream: { streamId: 'stream_1', cursors: [] },
      }) },
    })

    client.push(snapshot([]))
    client.push({ type: 'run.event', id: null, payload: { data: event } })
    client.push(snapshot([event]))

    expect(session.snapshot().events.map(current => current.eventId)).toEqual([event.eventId])
  })

  it('switches to the new run returned by a clarification response', async () => {
    const client = new TestClient()
    const waiting = run('run_waiting', 'clarification_needed')
    waiting.state.decisions = [{
      decisionId: 'decision_place',
      kind: 'clarification',
      title: '补充地点',
      question: '请问是哪个城市？',
      description: '',
      options: [],
      allowFreeText: true,
      status: 'pending',
      payload: {},
      createdAt: '2026-07-27T00:00:00.000Z',
      resolvedAt: null,
    }]
    client.startRun = waiting
    const next = run('run_next', 'running')
    client.decisionRun = next
    client.onRespondDecision = () => client.push(itemPush('旧运行文本', 0, 'run_waiting'))
    const session = new LocalAgentSession({ connectClient: async () => client })
    await session.initialize()
    await session.submit('明天会下雨吗？')

    await session.respondDecision({ decisionId: 'decision_place', text: '杭州' })

    expect(session.snapshot().run?.id).toBe('run_next')
    expect(session.snapshot().items).toEqual([])
    expect(session.snapshot().error).toBeNull()
    expect(client.requests.find(request => request.type === 'run:respond-decision')).toMatchObject({
      type: 'run:respond-decision',
      payload: { runId: 'run_waiting', decisionId: 'decision_place', text: '杭州' },
    })
  })

  it('does not orphan a running or decision-waiting run when starting a new conversation', async () => {
    const client = new TestClient()
    client.startRun = run('run_waiting', 'waiting_approval')
    const session = new LocalAgentSession({ connectClient: async () => client })
    await session.initialize()
    await session.submit('执行受保护任务')

    expect(() => session.newConversation()).toThrow('当前运行尚未结束')
    expect(session.snapshot().run?.id).toBe('run_waiting')
    expect(session.snapshot().threadId).toBe('thread_1')
  })

  it('lists and opens a completed historical thread through authoritative commands', async () => {
    const client = new TestClient()
    client.startRun = run('run_completed', 'completed')
    const session = new LocalAgentSession({ connectClient: async () => client })
    await session.initialize()
    await session.submit('已完成运行')

    const threads = await session.listThreads()
    await session.openThread('thread_1')

    expect(threads[0]?.id).toBe('thread_1')
    expect(client.requests.map(request => request.type)).toContain('thread:list')
    expect(client.requests.map(request => request.type)).toContain('thread:get')
    expect(session.snapshot().run?.id).toBe('run_completed')
  })

  it('does not let a delayed reconnect subscription resurrect a cleared conversation', async () => {
    const firstClient = new TestClient()
    const secondClient = new TestClient()
    const completedRun = run('run_completed', 'completed')
    firstClient.startRun = completedRun
    secondClient.startRun = completedRun
    let releaseReconnect!: () => void
    secondClient.subscriptionBarrier = new Promise<void>(resolve => {
      releaseReconnect = resolve
    })
    let connections = 0
    const session = new LocalAgentSession({
      connectClient: async () => (connections++ === 0 ? firstClient : secondClient),
    })
    await session.initialize()
    await session.submit('已完成运行')

    const reconnect = (session as unknown as {
      connect(reconnecting: boolean): Promise<void>
    }).connect(true)
    await vi.waitFor(() => {
      expect(secondClient.requests.some(request => request.type === 'run:subscribe')).toBe(true)
    })

    session.newConversation()
    releaseReconnect()
    await reconnect

    expect(session.snapshot().run).toBeNull()
    expect(session.snapshot().threadId).toBeNull()
    expect(session.snapshot().items).toEqual([])
    expect(session.snapshot().events).toEqual([])
  })
})

class TestClient implements LocalAgentClientPort {
  readonly events = new EventEmitter()
  readonly requests: Array<{ type: WsControlCommand; payload: Record<string, unknown> }> = []
  startRun = run('run_1', 'running')
  decisionRun = this.startRun
  subscriptionSnapshot: z.infer<typeof runSnapshotSchema> | null = null
  subscriptionError: Error | null = null
  subscriptionBarrier: Promise<void> | null = null
  onRespondDecision: (() => void) | null = null

  async send<T>(
    type: WsControlCommand,
    payload: Record<string, unknown>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    this.requests.push({ type, payload })
    if (type === 'run:respond-decision') this.onRespondDecision?.()
    if (type === 'run:subscribe' && this.subscriptionError) {
      const error = this.subscriptionError
      this.subscriptionError = null
      throw error
    }
    if (type === 'run:subscribe' && this.subscriptionBarrier) {
      await this.subscriptionBarrier
    }
    const value: unknown = type === 'workspace:bootstrap'
      ? bootstrap()
      : type === 'thread:list'
        ? bootstrap().threads
        : type === 'thread:get'
          ? {
              thread: bootstrap().threads[0],
              manifest: {
                schemaVersion: 2,
                threadId: 'thread_1',
                sessionId: 'session_1',
                activeLeafEntryId: null,
                lastSequence: 0,
                transcriptEntryCount: 0,
                estimatedContextTokens: 0,
                latestCompactionId: null,
                memoryVersion: 0,
                memoryBasedOnTokens: 0,
                forkedFrom: null,
                quarantined: false,
                quarantineReason: null,
                createdAt: '2026-07-27T00:00:00.000Z',
                updatedAt: '2026-07-27T00:00:00.000Z',
              },
            }
      : type === 'run:start'
        ? this.startRun
        : type === 'run:respond-decision'
          ? this.decisionRun
          : type === 'run:subscribe' || type === 'run:get'
            ? type === 'run:subscribe' && this.subscriptionSnapshot
              ? this.subscriptionSnapshot
              : runSnapshotSchema.parse({
                run: type === 'run:subscribe' && this.decisionRun.id !== this.startRun.id
                  && payload.runId === this.decisionRun.id
                  ? this.decisionRun
                  : this.startRun,
                items: [],
                events: [],
                itemStream: { streamId: 'stream_1', cursors: [] },
              })
            : this.startRun
    return schema.parse(value)
  }

  onPush(listener: (message: LocalAgentPush) => void): () => void {
    this.events.on('push', listener)
    return () => this.events.off('push', listener)
  }

  onDisconnected(listener: (error: Error) => void): () => void {
    this.events.on('disconnected', listener)
    return () => this.events.off('disconnected', listener)
  }

  push(message: LocalAgentPush): void {
    this.events.emit('push', message)
  }

  close(): void {}
}

function bootstrap() {
  return workspaceBootstrapSnapshotSchema.parse({
    auth: {
      user: {
        userId: 'platform_local_agent',
        subject: 'auth_local_agent',
        email: 'agent@local-agent.geo-agent-platform.invalid',
        displayName: 'Platform Local Agent',
        status: 'active',
        lastLoginAt: null,
        createdAt: '2026-07-27T00:00:00.000Z',
        updatedAt: '2026-07-27T00:00:00.000Z',
      },
      defaultWorkspace: null,
      memberships: [],
      platformRoles: ['platform_admin'],
      csrfToken: 'csrf',
      permissions: [],
    },
    session: {
      id: 'session_1',
      workspaceId: 'workspace_1',
      createdByUserId: 'platform_local_agent',
      visibility: 'private',
      createdAt: '2026-07-27T00:00:00.000Z',
      status: 'active',
    },
    threads: [{
      id: 'thread_1',
      sessionId: 'session_1',
      workspaceId: 'workspace_1',
      createdByUserId: 'platform_local_agent',
      visibility: 'private',
      title: '杭州天气',
      status: 'active',
      createdAt: '2026-07-27T00:00:00.000Z',
      updatedAt: '2026-07-27T00:00:00.000Z',
      latestRunId: 'run_completed',
      latestUserQuery: '杭州明天会下雨吗？',
      latestAssistantSummary: '已完成。',
      latestRunStatus: 'completed',
      latestArtifactId: null,
      latestArtifactName: null,
      historyPreview: '杭州明天会下雨吗？',
      runCount: 1,
      conversationPath: null,
    }],
    providers: [{
      provider: 'deepseek',
      displayName: 'DeepSeek',
      configured: true,
      defaultModel: 'deepseek-v4-flash',
      availableModels: ['deepseek-v4-flash'],
      models: [{
        modelId: 'deepseek-v4-flash',
        contextWindowTokens: 1_000_000,
        capabilities: { reasoning: true, structuredOutput: true, toolCalls: true },
        modalities: ['text'],
      }],
      capabilities: ['agents_sdk_live_supervisor'],
      agentRuntime: {
        transport: 'deepseek_responses',
        structuredOutput: 'json_schema',
        functionTools: true,
        deferredTools: false,
        toolNamespaces: false,
        localMcp: true,
        hostedTools: false,
        handoffs: true,
        multiToolResponse: true,
        providerParallelToolControl: false,
        remoteConversation: false,
        serverCompaction: false,
      },
      contextWindowTokens: 1_000_000,
    }],
    tools: [],
  })
}

function run(id: string, status: AnalysisRun['status']): AnalysisRun {
  return analysisRunSchema.parse({
    id,
    threadId: 'thread_1',
    sessionId: 'session_1',
    workspaceId: 'workspace_1',
    createdByUserId: 'platform_local_agent',
    visibility: 'private',
    userQuery: '测试',
    modelProvider: 'deepseek',
    modelName: 'deepseek-v4-flash',
    status,
    createdAt: '2026-07-27T00:00:00.000Z',
    updatedAt: '2026-07-27T00:00:00.000Z',
    state: {
      sessionId: 'session_1',
      threadId: 'thread_1',
      userQuery: '测试',
    },
  })
}

function itemPush(body: string, sequence: number, runId = 'run_1'): LocalAgentPush {
  const item = conversationItemSchema.parse({
    itemId: 'item_answer',
    itemType: 'message',
    runId,
    threadId: 'thread_1',
    role: 'assistant',
    body,
    status: 'running',
    timestamp: '2026-07-27T00:00:01.000Z',
  })
  return {
    type: 'run.item',
    id: null,
    payload: {
      data: {
        updateType: 'item_upsert',
        schemaVersion: 1,
        streamId: 'stream_1',
        cursor: { sequence, utf16Offset: body.length },
        item,
      },
    },
  }
}

function deltaPush(text: string, sequence: number, utf16Offset: number): LocalAgentPush {
  return {
    type: 'run.item.delta',
    id: null,
    payload: {
      data: {
        updateType: 'text_delta', schemaVersion: 1, streamId: 'stream_1',
        runId: 'run_1', threadId: 'thread_1', itemId: 'item_answer',
        sequence, utf16Offset, text,
      },
    },
  }
}
