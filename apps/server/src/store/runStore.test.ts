// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运行资源存储测试
//
//   文件:       runStore.test.ts
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'

import type {
  AgentThreadRecord,
  AnalysisRun,
  ConversationItem,
  ConversationItemTextDelta,
  RunItemUpsert,
  SessionRecord,
} from '../schemas/types.js'
import type { AppendConversationItemBody } from '../conversation/itemUpdates.js'
import { ConversationProjectionIndex } from './conversationProjectionIndex.js'
import { InMemoryEventBus } from './eventBus.js'
import type { ConversationPayloadStore } from './conversationPayloadStore.js'
import { RunStore } from './runStore.js'
import type { SessionStore } from './sessionStore.js'
import type { ConversationPersistence } from './postgres/conversationPersistencePorts.js'

function createRunStore(overrides: Partial<ConversationPayloadStore> = {}) {
  const index = new ConversationProjectionIndex()
  const session: SessionRecord = {
    id: 'session_1',
    title: '测试会话',
    status: 'active',
    createdAt: '2026-07-09T00:00:00.000Z',
    updatedAt: '2026-07-09T00:00:00.000Z',
    latestThreadId: 'thread_1',
    latestRunId: 'run_1',
    workspaceId: 'workspace_1',
    createdByUserId: 'user_1',
    visibility: 'workspace',
    latestMeteorologicalDatasetId: null,
  } as SessionRecord
  const thread: AgentThreadRecord = {
    id: 'thread_1',
    sessionId: 'session_1',
    title: '测试线程',
    status: 'active',
    createdAt: '2026-07-09T00:00:00.000Z',
    updatedAt: '2026-07-09T00:00:00.000Z',
    runCount: 1,
    latestRunId: 'run_1',
    latestRunStatus: 'running',
    latestUserQuery: '测试',
    latestAssistantSummary: null,
    workspaceId: 'workspace_1',
    createdByUserId: 'user_1',
    visibility: 'workspace',
    latestMeteorologicalDatasetId: null,
  } as AgentThreadRecord
  const run: AnalysisRun = {
    id: 'run_1',
    sessionId: 'session_1',
    threadId: 'thread_1',
    workspaceId: 'workspace_1',
    createdByUserId: 'user_1',
    visibility: 'workspace',
    userQuery: '测试',
    modelProvider: 'deepseek',
    modelName: null,
    status: 'running',
    createdAt: '2026-07-09T00:00:00.000Z',
    updatedAt: '2026-07-09T00:00:00.000Z',
    conversationPath: null,
    runtimeConfigSnapshot: null,
    state: {
      sessionId: 'session_1',
      threadId: 'thread_1',
      userQuery: '测试',
      modelProvider: 'deepseek',
      modelName: null,
      parsedIntent: null,
      clarification: null,
      placeResolution: null,
      contextReferences: [],
      contextResolution: null,
      runLifecycle: { status: 'created', reason: null, updatedAt: null },
      agentWorkflow: null,
      currentStep: 0,
      loopIteration: 0,
      loopPhase: 'idle',
      loopTrace: [],
      todos: [],
      tasks: [],
      planMode: false,
      subAgents: [],
      activeSkills: [],
      activeMcpServers: [],
      decisions: [],
      approvals: [],
      toolResults: [],
      toolValueRefs: [],
      artifacts: [],
      selectedDataSources: [],
      warnings: [],
      errors: [],
      failedStepId: null,
      failedTool: null,
      denialCounts: {},
      runtimeStats: {},
      planRepairAttempts: 0,
    },
  } as AnalysisRun
  index.load({ sessions: [session], threads: [thread], runs: [run] })
  const payloadStore = {
    flush: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as ConversationPayloadStore
  const repository = {
    saveRun: vi.fn().mockResolvedValue(undefined),
    saveRunWithModelUsage: vi.fn().mockResolvedValue(undefined),
    saveRunWithCheckpoint: vi.fn().mockResolvedValue(undefined),
    saveRunCheckpoint: vi.fn().mockResolvedValue(undefined),
    getRunCheckpoint: vi.fn().mockResolvedValue({
      pendingToolCallIds: [],
      recoveryStatus: 'clean',
    }),
    saveThread: vi.fn().mockRejectedValue(new Error('projection unavailable')),
    appendConversationItem: vi.fn().mockResolvedValue(undefined),
    listConversationItems: vi.fn().mockResolvedValue([]),
    loadRunPresentation: vi.fn().mockResolvedValue({
      schemaVersion: 1,
      runId: 'run_1',
      sourceSequence: 0,
      items: [],
      events: [],
      values: [],
    }),
  } as unknown as ConversationPersistence
  const itemBus = new InMemoryEventBus<ConversationItem>()
  const itemUpsertBus = new InMemoryEventBus<RunItemUpsert>()
  const itemDeltaBus = new InMemoryEventBus<ConversationItemTextDelta>()
  const store = new RunStore(
    index,
    payloadStore,
    {} as SessionStore,
    repository,
    repository,
    {
      runBus: new InMemoryEventBus<AnalysisRun>(),
      eventBus: new InMemoryEventBus(),
      itemBus,
      itemUpsertBus,
      itemDeltaBus,
    },
  )
  return { store, index, payloadStore, repository, itemBus, itemUpsertBus, itemDeltaBus }
}

describe('RunStore projections', () => {
  it('serializes concurrent state read-modify-write operations for one run', async () => {
    const { store, index, repository } = createRunStore()
    let releaseFirstSave: (() => void) | null = null
    vi.mocked(repository.saveRun)
      .mockImplementationOnce(() => new Promise<void>(resolve => { releaseFirstSave = resolve }))
      .mockResolvedValue(undefined)

    const first = store.updateState('run_1', { warnings: ['第一条警告'] })
    await vi.waitFor(() => expect(repository.saveRun).toHaveBeenCalledTimes(1))
    const second = store.updateState('run_1', { errors: ['第二条错误'] })
    await Promise.resolve()

    expect(repository.saveRun).toHaveBeenCalledTimes(1)
    if (!releaseFirstSave) throw new Error('首个状态写入没有进入等待态')
    releaseFirstSave()
    await Promise.all([first, second])

    expect(index.getRun('run_1').state).toMatchObject({
      warnings: ['第一条警告'],
      errors: ['第二条错误'],
    })
    expect(repository.saveRun).toHaveBeenCalledTimes(2)
  })

  it('applies atomic mutations against the latest serialized state', async () => {
    const { store, index } = createRunStore()

    await Promise.all([
      store.mutateState('run_1', state => ({ warnings: [...state.warnings, 'A'] })),
      store.mutateState('run_1', state => ({ warnings: [...state.warnings, 'B'] })),
    ])

    expect(index.getRun('run_1').state.warnings).toEqual(['A', 'B'])
  })

  it('commits model token growth through the atomic budget transaction', async () => {
    const { store, index, repository } = createRunStore()

    await store.updateState('run_1', {
      runtimeStats: { modelInputTokens: 9, modelOutputTokens: 3, modelTotalTokens: 12 },
    })

    expect(repository.saveRunWithModelUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        usedModelTokens: 12,
        state: expect.objectContaining({
          runtimeStats: expect.objectContaining({ modelTotalTokens: 12 }),
        }),
      }),
      12,
    )
    expect(repository.saveRun).not.toHaveBeenCalled()
    expect(index.getRun('run_1').usedModelTokens).toBe(12)

    await store.updateState('run_1', { warnings: ['用量后普通状态写入'] })
    expect(repository.saveRun).toHaveBeenCalledWith(expect.objectContaining({ usedModelTokens: 12 }))
    expect(index.getRun('run_1').usedModelTokens).toBe(12)
    await expect(store.updateState('run_1', {
      runtimeStats: { modelTotalTokens: 11 },
    })).rejects.toThrow(/累计词元不能回退/u)
  })

  it('marks an orphaned active run as interrupted during startup recovery', async () => {
    const { store, index, repository } = createRunStore()

    const recovered = await store.recoverOrphanedRuns()

    expect(recovered).toHaveLength(1)
    expect(index.getRun('run_1')).toMatchObject({
      status: 'interrupted',
      state: {
        runLifecycle: { status: 'interrupted' },
        warnings: [expect.stringContaining('服务进程重启')],
      },
    })
    expect(repository.saveRunWithCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'interrupted' }),
      { pendingToolCallIds: [], recoveryStatus: 'interrupted' },
    )
  })

  it('requires manual action when an orphaned run has an unknown tool state', async () => {
    const { store, index, repository } = createRunStore()
    vi.mocked(repository.getRunCheckpoint).mockResolvedValue({
      pendingToolCallIds: ['call_unknown'],
      recoveryStatus: 'requires_action',
    } as never)

    await store.recoverOrphanedRuns()

    expect(index.getRun('run_1').status).toBe('requires_action')
    expect(repository.saveRunWithCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'requires_action' }),
      { pendingToolCallIds: ['call_unknown'], recoveryStatus: 'requires_action' },
    )
  })

  it('persists terminal run status even when thread status projection fails', async () => {
    const { store, index, payloadStore, repository } = createRunStore()

    const completed = await store.complete('run_1', 'completed')

    expect(completed.status).toBe('completed')
    expect(index.getRun('run_1').status).toBe('completed')
    expect(repository.saveRunWithCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed' }),
      { recoveryStatus: 'clean' },
    )
    expect(repository.saveThread).toHaveBeenCalled()
  })

  it('updates the in-memory thread summary after the repository transaction commits', async () => {
    const { store, index, repository } = createRunStore()

    await expect(store.appendItem({
      itemId: 'item_1',
      itemType: 'message',
      runId: 'run_1',
      threadId: 'thread_1',
      role: 'assistant',
      body: '最终回答',
      name: null,
      arguments: null,
      output: null,
      turnId: null,
      callId: null,
      phase: null,
      status: 'completed',
      isError: false,
      metadata: {},
      timestamp: '2026-07-09T00:00:01.000Z',
    })).resolves.toBeUndefined()

    expect(repository.appendConversationItem).toHaveBeenCalledWith(expect.objectContaining({ itemId: 'item_1' }))
    expect(index.getThread('thread_1').latestAssistantSummary).toBe('最终回答')
  })

  it('persists only the first running snapshot and the terminal item state', async () => {
    const { store, repository, itemBus } = createRunStore()
    const liveItems: ConversationItem[] = []
    itemBus.subscribe('run_1', item => liveItems.push(item))
    const base: ConversationItem = {
      itemId: 'item_stream_1',
      itemType: 'message',
      runId: 'run_1',
      threadId: 'thread_1',
      role: 'assistant',
      body: '',
      name: null,
      arguments: null,
      output: null,
      turnId: null,
      callId: null,
      phase: null,
      status: 'running',
      isError: false,
      metadata: {},
      timestamp: '2026-07-09T00:00:01.000Z',
    }

    await store.appendItem(base)
    await store.appendItem({ ...base, body: '第一段' })
    await store.appendItem({ ...base, body: '第一段第二段' })
    await store.appendItem({ ...base, body: '最终回答', status: 'completed' })

    expect(repository.appendConversationItem).toHaveBeenCalledTimes(2)
    expect(repository.appendConversationItem).toHaveBeenNthCalledWith(1, base)
    expect(repository.appendConversationItem).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ body: '最终回答', status: 'completed' }),
    )
    expect(liveItems.map(item => item.body)).toEqual(['', '第一段', '第一段第二段', '最终回答'])
  })

  it('reconstructs live snapshots from strictly ordered deltas without persisting each frame', async () => {
    const { store, repository, itemBus, itemDeltaBus } = createRunStore()
    const fullItems: ConversationItem[] = []
    const deltas: ConversationItemTextDelta[] = []
    itemBus.subscribe('run_1', item => fullItems.push(item))
    itemDeltaBus.subscribe('run_1', delta => deltas.push(delta))
    const started: ConversationItem = {
      itemId: 'item_delta_1',
      itemType: 'message',
      runId: 'run_1',
      threadId: 'thread_1',
      role: 'assistant',
      body: '',
      name: null,
      arguments: null,
      output: null,
      turnId: null,
      callId: null,
      phase: null,
      status: 'running',
      isError: false,
      metadata: {},
      timestamp: '2026-07-09T00:00:01.000Z',
    }

    await store.appendItem(started)
    await store.appendItem(appendBody('杭州'))
    await store.appendItem(appendBody('有雨'))

    expect(repository.appendConversationItem).toHaveBeenCalledTimes(1)
    expect(fullItems).toEqual([started])
    expect(deltas).toEqual([
      expect.objectContaining({ sequence: 1, utf16Offset: 0, text: '杭州' }),
      expect.objectContaining({ sequence: 2, utf16Offset: 2, text: '有雨' }),
    ])
    expect(new Set(deltas.map(delta => delta.streamId)).size).toBe(1)
    const snapshot = await store.listItemSnapshot('run_1')
    expect(snapshot.items).toContainEqual(expect.objectContaining({
      itemId: 'item_delta_1',
      body: '杭州有雨',
      status: 'running',
    }))
    expect(snapshot.itemStream.cursors).toContainEqual({
      itemId: 'item_delta_1', sequence: 2, utf16Offset: 4,
    })
  })

  it('serializes concurrent item writers before assigning stream cursors', async () => {
    const { store, repository, itemUpsertBus } = createRunStore()
    const upserts: RunItemUpsert[] = []
    itemUpsertBus.subscribe('run_1', update => upserts.push(update))
    let unblockFirstWrite!: () => void
    const firstWrite = new Promise<void>(resolve => { unblockFirstWrite = resolve })
    vi.mocked(repository.appendConversationItem)
      .mockImplementationOnce(() => firstWrite)
      .mockResolvedValue(undefined)
    const started: ConversationItem = {
      itemId: 'item_concurrent_1', itemType: 'message', runId: 'run_1', threadId: 'thread_1',
      role: 'assistant', body: '', name: null, arguments: null, output: null,
      turnId: null, callId: null, phase: null, status: 'running', isError: false,
      metadata: {}, timestamp: '2026-07-09T00:00:01.000Z',
    }

    const startWrite = store.appendItem(started)
    await vi.waitFor(() => expect(repository.appendConversationItem).toHaveBeenCalledTimes(1))
    const terminalWrite = store.appendItem({ ...started, status: 'completed' })
    await Promise.resolve()

    expect(repository.appendConversationItem).toHaveBeenCalledTimes(1)
    unblockFirstWrite()
    await Promise.all([startWrite, terminalWrite])
    expect(upserts.map(update => update.cursor.sequence)).toEqual([0, 1])
  })

  it('captures a presentation snapshot only after an in-flight item commit is projected', async () => {
    const { store, repository } = createRunStore()
    let releaseWrite!: () => void
    const blockedWrite = new Promise<void>(resolve => { releaseWrite = resolve })
    vi.mocked(repository.appendConversationItem).mockImplementationOnce(() => blockedWrite)
    const started: ConversationItem = {
      itemId: 'item_snapshot_barrier', itemType: 'message', runId: 'run_1', threadId: 'thread_1',
      role: 'assistant', body: '', name: null, arguments: null, output: null,
      turnId: null, callId: null, phase: null, status: 'running', isError: false,
      metadata: {}, timestamp: '2026-07-09T00:00:01.000Z',
    }

    const write = store.appendItem(started)
    await vi.waitFor(() => expect(repository.appendConversationItem).toHaveBeenCalledOnce())
    const snapshot = store.listPresentationSnapshot('run_1')
    await Promise.resolve()
    expect(repository.loadRunPresentation).not.toHaveBeenCalled()

    releaseWrite()
    await write
    expect((await snapshot).items).toContainEqual(started)
    expect(repository.loadRunPresentation).toHaveBeenCalledOnce()
  })

  it('atomically closes item writes before waiting for an in-flight durable item', async () => {
    const { store, repository } = createRunStore()
    let unblockFirstWrite!: () => void
    const firstWrite = new Promise<void>(resolve => { unblockFirstWrite = resolve })
    vi.mocked(repository.appendConversationItem).mockImplementationOnce(() => firstWrite)
    const started: ConversationItem = {
      itemId: 'item_closing_1', itemType: 'message', runId: 'run_1', threadId: 'thread_1',
      role: 'assistant', body: '', name: null, arguments: null, output: null,
      turnId: null, callId: null, phase: null, status: 'running', isError: false,
      metadata: {}, timestamp: '2026-07-09T00:00:01.000Z',
    }
    const itemWrite = store.appendItem(started)
    await vi.waitFor(() => expect(repository.appendConversationItem).toHaveBeenCalledOnce())

    const completion = store.complete('run_1', 'completed')
    await expect(store.appendItem({ ...started, itemId: 'item_too_late' }))
      .rejects.toThrow('已封口')
    expect(repository.saveRunWithCheckpoint).not.toHaveBeenCalled()

    unblockFirstWrite()
    await itemWrite
    await completion
    expect(repository.saveRunWithCheckpoint).toHaveBeenCalledOnce()
  })

  it('keeps the item fence closed when an older running-status write commits before completion', async () => {
    const { store, repository } = createRunStore()
    let releaseRunningSave!: () => void
    const runningSave = new Promise<void>(resolve => { releaseRunningSave = resolve })
    vi.mocked(repository.saveRunWithCheckpoint)
      .mockImplementationOnce(() => runningSave)
      .mockResolvedValue(undefined)

    const olderStatusWrite = store.updateStatus('run_1', 'running')
    await vi.waitFor(() => expect(repository.saveRunWithCheckpoint).toHaveBeenCalledOnce())
    const completion = store.complete('run_1', 'completed')
    releaseRunningSave()
    await Promise.all([olderStatusWrite, completion])

    await expect(store.appendItem({
      itemId: 'item_after_completion', itemType: 'message', runId: 'run_1', threadId: 'thread_1',
      role: 'assistant', body: '迟到正文', name: null, arguments: null, output: null,
      turnId: null, callId: null, phase: null, status: 'completed', isError: false,
      metadata: {}, timestamp: '2026-07-09T00:00:02.000Z',
    })).rejects.toThrow('已封口')
    expect(repository.appendConversationItem).not.toHaveBeenCalled()
  })

  it('reopens item writes only after a later running status commits', async () => {
    const { store, repository } = createRunStore()
    let releaseCompletionSave!: () => void
    const completionSave = new Promise<void>(resolve => { releaseCompletionSave = resolve })
    vi.mocked(repository.saveRunWithCheckpoint)
      .mockImplementationOnce(() => completionSave)
      .mockResolvedValue(undefined)
    const item: ConversationItem = {
      itemId: 'item_after_resume', itemType: 'message', runId: 'run_1', threadId: 'thread_1',
      role: 'assistant', body: '恢复后的正文', name: null, arguments: null, output: null,
      turnId: null, callId: null, phase: null, status: 'completed', isError: false,
      metadata: {}, timestamp: '2026-07-09T00:00:03.000Z',
    }

    const completion = store.complete('run_1', 'waiting_approval')
    await vi.waitFor(() => expect(repository.saveRunWithCheckpoint).toHaveBeenCalledOnce())
    const reopen = store.updateStatus('run_1', 'running')
    await expect(store.appendItem(item)).rejects.toThrow('已封口')
    releaseCompletionSave()
    await Promise.all([completion, reopen])

    await expect(store.appendItem(item)).resolves.toBeUndefined()
  })

  it('rejects text without a start or after terminal, and keeps terminal metadata replacements versioned', async () => {
    const { store, itemUpsertBus } = createRunStore()
    const upserts: RunItemUpsert[] = []
    itemUpsertBus.subscribe('run_1', update => upserts.push(update))
    const started: ConversationItem = {
      itemId: 'item_delta_1', itemType: 'message', runId: 'run_1', threadId: 'thread_1',
      role: 'assistant', body: '', name: null, arguments: null, output: null,
      turnId: null, callId: null, phase: null, status: 'running', isError: false,
      metadata: {}, timestamp: '2026-07-09T00:00:01.000Z',
    }
    await expect(store.appendItem(appendBody('缺失'))).rejects.toThrow('缺少 replace_item start')
    await store.appendItem(started)
    await store.appendItem(appendBody('杭州'))
    await store.appendItem({ ...started, body: '杭州', status: 'completed' })
    await expect(store.appendItem(appendBody('迟到'))).rejects.toThrow('已结束')
    await store.appendItem({
      ...started,
      body: '杭州',
      status: 'completed',
      metadata: { transcriptEntryId: 'entry_1' },
    })

    expect(upserts.map(update => update.cursor.sequence)).toEqual([0, 2, 3])
    expect((await store.listItemSnapshot('run_1')).itemStream.cursors).toContainEqual({
      itemId: 'item_delta_1', sequence: 3, utf16Offset: 2,
    })
    await expect(store.appendItem({ ...started, body: '杭州', status: 'running' }))
      .rejects.toThrow('不能重新进入 running')
    await expect(store.appendItem({ ...started, body: '上海', status: 'completed' }))
      .rejects.toThrow('终态正文和状态不可改写')
  })
})

function appendBody(text: string): AppendConversationItemBody {
  return {
    updateType: 'append_body',
    runId: 'run_1',
    threadId: 'thread_1',
    itemId: 'item_delta_1',
    text,
  }
}
