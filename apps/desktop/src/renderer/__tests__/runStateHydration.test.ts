// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运行快照世代屏障测试
//
//   文件:       runStateHydration.test.ts
//
//   日期:       2026年08月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
  analysisRunSchema,
  conversationItemSchema,
  runEventSchema,
  runSnapshotSchema,
  type DirectToolRunResponse,
  type RunSnapshot,
  type SessionRecord,
  type ThreadDetailSnapshot,
  type ThreadHistoryPage,
  type ToolDescriptor,
} from '@geo-agent-platform/shared-types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useRunState, type RunState } from '../features/runs/useRunState'
import {
  useWorkspaceRunProjection,
  type WorkspaceRunProjectionOptions,
} from '../app/controllers/useWorkspaceRunProjection'
import {
  useThreadLifecycleActions,
  type ThreadLifecycleOptions,
} from '../app/controllers/useThreadLifecycleActions'
import {
  useToolExecutionAction,
  type ToolExecutionActionOptions,
} from '../app/controllers/useToolExecutionAction'

const reducerHarness = vi.hoisted(() => ({
  state: undefined as unknown,
  actions: [] as Array<Record<string, unknown>>,
  reducer: undefined as ((state: unknown, action: Record<string, unknown>) => unknown) | undefined,
  refs: [] as Array<{ current: unknown }>,
  refCursor: 0,
  effectCleanups: [] as Array<(() => void) | undefined>,
  effectCursor: 0,
}))

const pendingSubscriptions = vi.hoisted(() => ({
  calls: [] as string[],
  requests: new Map<string, {
    resolve: (snapshot: unknown) => void
    reject: (error: Error) => void
  }>(),
}))

const wsHarness = vi.hoisted(() => ({
  listeners: new Set<(message: unknown) => void>(),
}))

vi.mock('react', () => ({
  useReducer: (
    reducer: (state: unknown, action: Record<string, unknown>) => unknown,
    initialArg: unknown,
    initializer: (value: unknown) => unknown,
  ) => {
    if (reducerHarness.state === undefined) reducerHarness.state = initializer(initialArg)
    reducerHarness.reducer = reducer
    return [reducerHarness.state, (action: Record<string, unknown>) => {
      reducerHarness.actions.push(action)
      reducerHarness.state = reducer(reducerHarness.state, action)
    }]
  },
  useRef: <T>(initialValue: T) => {
    const index = reducerHarness.refCursor
    reducerHarness.refCursor += 1
    if (!reducerHarness.refs[index]) reducerHarness.refs[index] = { current: initialValue }
    return reducerHarness.refs[index] as { current: T }
  },
  useCallback: <T>(callback: T) => callback,
  useEffect: (effect: () => void | (() => void)) => {
    const index = reducerHarness.effectCursor
    reducerHarness.effectCursor += 1
    reducerHarness.effectCleanups[index]?.()
    const cleanup = effect()
    reducerHarness.effectCleanups[index] = typeof cleanup === 'function' ? cleanup : undefined
  },
  startTransition: (callback: () => void) => callback(),
}))

vi.mock('../api/client', () => ({
  subscribeRun: (runId: string) => new Promise((resolve, reject) => {
    pendingSubscriptions.calls.push(runId)
    pendingSubscriptions.requests.set(runId, { resolve, reject })
  }),
  unsubscribeRun: async () => undefined,
}))

vi.mock('../ws/client', () => ({
  wsClient: {
    on: (listener: (message: unknown) => void) => {
      wsHarness.listeners.add(listener)
      return () => wsHarness.listeners.delete(listener)
    },
  },
}))

describe('useRunState hydration generation barrier', () => {
  beforeEach(() => {
    for (const cleanup of reducerHarness.effectCleanups) cleanup?.()
    reducerHarness.state = undefined
    reducerHarness.actions = []
    reducerHarness.reducer = undefined
    reducerHarness.refs = []
    reducerHarness.refCursor = 0
    reducerHarness.effectCleanups = []
    reducerHarness.effectCursor = 0
    pendingSubscriptions.calls = []
    pendingSubscriptions.requests.clear()
    wsHarness.listeners.clear()
  })

  it('快速水合 A/B 时不让迟到 A 快照 dispatch 或覆盖 B', async () => {
    const hook = renderRunStateHook()
    const staleA = hook.hydrateRun('run_a')
    const currentB = hook.hydrateRun('run_b')

    pendingSubscriptions.requests.get('run_b')?.resolve(snapshot('run_b'))
    await expect(currentB).resolves.toMatchObject({ status: 'applied', run: { id: 'run_b' } })
    const actionCountAfterB = reducerHarness.actions.length
    expect((reducerHarness.state as RunState).run?.id).toBe('run_b')

    pendingSubscriptions.requests.get('run_a')?.resolve(snapshot('run_a'))
    await expect(staleA).resolves.toEqual({ status: 'superseded' })

    expect(reducerHarness.actions).toHaveLength(actionCountAfterB)
    expect((reducerHarness.state as RunState).run?.id).toBe('run_b')
    expect((reducerHarness.state as RunState).expectedRunId).toBe('run_b')
    expect((reducerHarness.state as RunState).projectionGeneration).toBe(1)
  })

  it('不允许同一 opaque selection token 被复用到不同 run', async () => {
    const hook = renderRunStateHook()
    const selection = hook.beginRunSelection()
    const selectedA = hook.hydrateRun('run_a', selection)

    await expect(hook.hydrateRun('run_b', selection)).resolves.toEqual({ status: 'superseded' })
    expect(pendingSubscriptions.requests.has('run_b')).toBe(false)

    pendingSubscriptions.requests.get('run_a')?.resolve(snapshot('run_a'))
    await expect(selectedA).resolves.toMatchObject({ status: 'applied', run: { id: 'run_a' } })
    expect((reducerHarness.state as RunState).run?.id).toBe('run_a')
  })

  it('当前 run 刷新不签发新选择，且导航意图可使在途刷新失效', async () => {
    const hook = renderRunStateHook()
    const activeA = hook.hydrateRun('run_a')
    pendingSubscriptions.requests.get('run_a')?.resolve(snapshot('run_a', '原始 A'))
    await expect(activeA).resolves.toMatchObject({ status: 'applied' })

    const continuation = hook.captureRunSelection('run_a')
    expect(continuation).not.toBeNull()
    const staleRefresh = hook.refreshActiveRun('run_a', continuation!)
    hook.beginRunSelection()
    pendingSubscriptions.requests.get('run_a')?.resolve(snapshot('run_a', '迟到刷新'))

    await expect(staleRefresh).resolves.toEqual({ status: 'superseded' })
    expect((reducerHarness.state as RunState).items.map(item => item.body)).toEqual(['原始 A'])
  })

  it('同一 run 的 current refresh 按 FIFO 串行取快照', async () => {
    const hook = renderRunStateHook()
    const activeA = hook.hydrateRun('run_a')
    pendingSubscriptions.requests.get('run_a')?.resolve(snapshot('run_a'))
    await activeA
    const continuation = hook.captureRunSelection('run_a')!

    const firstRefresh = hook.refreshActiveRun('run_a', continuation)
    const secondRefresh = hook.refreshActiveRun('run_a', continuation)
    await flushMicrotasks()
    expect(pendingSubscriptions.calls.filter(runId => runId === 'run_a')).toHaveLength(2)

    pendingSubscriptions.requests.get('run_a')?.resolve(snapshot('run_a', '第一次刷新'))
    await firstRefresh
    await flushMicrotasks()
    expect(pendingSubscriptions.calls.filter(runId => runId === 'run_a')).toHaveLength(3)
    pendingSubscriptions.requests.get('run_a')?.resolve(snapshot('run_a', '第二次刷新'))
    await expect(secondRefresh).resolves.toMatchObject({ status: 'applied', run: { id: 'run_a' } })
  })

  it('superseded hydrate 的迟到 transport reject 是取消结果而不是新 run 错误', async () => {
    const hook = renderRunStateHook()
    const staleA = hook.hydrateRun('run_a')
    const currentB = hook.hydrateRun('run_b')
    pendingSubscriptions.requests.get('run_a')?.reject(new Error('A transport failed late'))
    await expect(staleA).resolves.toEqual({ status: 'superseded' })
    pendingSubscriptions.requests.get('run_b')?.resolve(snapshot('run_b'))
    await expect(currentB).resolves.toMatchObject({ status: 'applied', run: { id: 'run_b' } })
  })

  it('abort 只能回滚当前 pending intent，且会恢复新的 active A lease', async () => {
    const hook = renderRunStateHook()
    const activeA = hook.hydrateRun('run_a')
    pendingSubscriptions.requests.get('run_a')?.resolve(
      snapshot('run_a', undefined, 'thread_1', 'completed'),
    )
    await activeA
    const oldActiveASelection = hook.captureRunSelection('run_a')!

    const pendingB = hook.beginRunSelection()
    expect(hook.abortRunSelection(oldActiveASelection)).toBe(false)
    expect(hook.captureRunSelection('run_a')).toBeNull()
    expect(hook.abortRunSelection(pendingB)).toBe(true)
    expect(hook.abortRunSelection(pendingB)).toBe(false)

    const restoredASelection = hook.captureRunSelection('run_a')
    expect(restoredASelection).not.toBeNull()
    expect(restoredASelection).not.toBe(oldActiveASelection)
  })

  it('submitting owner 不会被旧 start 迟到清除，pending 失败会收敛未提交的 owner', async () => {
    const hook = renderRunStateHook()
    const activeA = hook.hydrateRun('run_a')
    pendingSubscriptions.requests.get('run_a')?.resolve(
      snapshot('run_a', undefined, 'thread_1', 'completed'),
    )
    await activeA

    const staleStart = hook.beginRunSelection()
    expect(hook.startRun(staleStart)).toBe(true)
    const failedNavigation = hook.beginRunSelection()
    expect(hook.abortRunSelection(failedNavigation)).toBe(true)
    expect(hook.stopSubmitting(staleStart)).toBe(false)
    expect((reducerHarness.state as RunState).isSubmitting).toBe(false)
    expect(hook.captureRunSelection('run_a')).not.toBeNull()

    const lateStart = hook.beginRunSelection()
    expect(hook.startRun(lateStart)).toBe(true)
    const lateRun = hook.hydrateRun('run_late', lateStart)
    const currentB = hook.beginRunSelection()
    const hydrateB = hook.hydrateRun('run_b', currentB)
    pendingSubscriptions.requests.get('run_b')?.resolve(snapshot('run_b'))
    await hydrateB
    pendingSubscriptions.requests.get('run_late')?.resolve(snapshot('run_late'))
    await expect(lateRun).resolves.toEqual({ status: 'superseded' })

    expect(hook.stopSubmitting(lateStart)).toBe(false)
    expect((reducerHarness.state as RunState).run?.id).toBe('run_b')
    expect((reducerHarness.state as RunState).isSubmitting).toBe(true)
    expect(hook.stopSubmitting(currentB)).toBe(true)
    expect((reducerHarness.state as RunState).isSubmitting).toBe(false)
  })

  it('pending submit C 优先于旧 committed A 的迟到 snapshot/event owner', async () => {
    let hook = renderRunStateHook()
    const activeA = hook.hydrateRun('run_a')
    pendingSubscriptions.requests.get('run_a')?.resolve(snapshot('run_a'))
    await activeA
    hook = renderRunStateHook()

    const pendingC = hook.beginRunSelection()
    expect(hook.startRun(pendingC)).toBe(true)
    emitPush({
      type: 'run.snapshot',
      id: null,
      payload: { data: snapshot('run_a', undefined, 'thread_1', 'completed') },
    })
    expect((reducerHarness.state as RunState).isSubmitting).toBe(true)

    emitPush({
      type: 'run.event',
      id: null,
      payload: { data: completedEvent('run_a') },
    })
    expect((reducerHarness.state as RunState).isSubmitting).toBe(true)
  })

  it('非 submit 的 pending B 不阻止 committed A terminal 清理 A owner', async () => {
    let hook = renderRunStateHook()
    const activeA = hook.hydrateRun('run_a')
    pendingSubscriptions.requests.get('run_a')?.resolve(snapshot('run_a'))
    await activeA
    hook = renderRunStateHook()
    const pendingB = hook.beginRunSelection()

    emitPush({
      type: 'run.event',
      id: null,
      payload: { data: completedEvent('run_a') },
    })
    expect((reducerHarness.state as RunState).isSubmitting).toBe(false)
    expect(hook.abortRunSelection(pendingB)).toBe(true)
  })

  it('水合 B 失败时保留已激活 A 的 effect 与实时投影', async () => {
    let hook = renderRunStateHook()
    const activeA = hook.hydrateRun('run_a')
    pendingSubscriptions.requests.get('run_a')?.resolve(snapshot('run_a'))
    await expect(activeA).resolves.toMatchObject({ status: 'applied', run: { id: 'run_a' } })
    hook = renderRunStateHook()
    expect(wsHarness.listeners.size).toBe(1)
    const oldActiveASelection = hook.captureRunSelection('run_a')
    expect(oldActiveASelection).not.toBeNull()

    const failedBSelection = hook.beginRunSelection()
    const failedB = hook.hydrateRun('run_b', failedBSelection).then(
      () => null,
      error => error,
    )
    pendingSubscriptions.requests.get('run_b')?.reject(new Error('B snapshot unavailable'))
    await expect(failedB).resolves.toMatchObject({ message: 'B snapshot unavailable' })
    expect(hook.isRunSelectionCurrent(failedBSelection)).toBe(true)
    expect(hook.isRunSelectionCurrent(oldActiveASelection!)).toBe(false)

    const restoredASelection = hook.captureRunSelection('run_a')
    expect(restoredASelection).not.toBeNull()
    expect(restoredASelection).not.toBe(oldActiveASelection)
    const restoredARefresh = hook.refreshActiveRun('run_a', restoredASelection!)
    await flushMicrotasks()
    pendingSubscriptions.requests.get('run_a')?.resolve(snapshot('run_a'))
    await expect(restoredARefresh).resolves.toMatchObject({
      status: 'applied',
      run: { id: 'run_a' },
    })

    const event = runEventSchema.parse({
      eventId: 'event_a_after_b_failure',
      runId: 'run_a',
      threadId: 'thread_1',
      type: 'step.completed',
      message: 'A 仍在投影',
      timestamp: '2026-08-08T00:00:01.000Z',
    })
    emitPush({
      type: 'run.snapshot',
      id: null,
      payload: { data: snapshot('run_a', '失败 B 之后的 A 快照') },
    })
    emitPush({ type: 'run.event', id: null, payload: { data: event } })

    const state = reducerHarness.state as RunState
    expect(state.run?.id).toBe('run_a')
    expect(state.expectedRunId).toBe('run_a')
    expect(state.items.map(item => item.body)).toEqual(['失败 B 之后的 A 快照'])
    expect(state.events.map(current => current.eventId)).toContain(event.eventId)
  })

  it('bootstrap A 迟到取消不会清除已成功的 history B 或改写 URL', async () => {
    const hook = renderRunStateHook()
    const clearRun = vi.fn()
    const clearArtifacts = vi.fn()
    const clearCanonicalThreadItems = vi.fn()
    const setActiveThreadId = vi.fn()
    const setModel = vi.fn()
    const setProvider = vi.fn()
    const setSelectedArtifactId = vi.fn()
    const setThreadRuns = vi.fn()
    const setToolRunResult = vi.fn()
    const syncUrl = vi.fn()
    const projection = WorkspaceRunProjectionHarness({
      abortRunSelection: hook.abortRunSelection,
      beginRunSelection: hook.beginRunSelection,
      captureRunSelection: hook.captureRunSelection,
      clearArtifacts,
      clearCanonicalThreadItems,
      clearRun,
      hydrateRun: hook.hydrateRun,
      isRunSelectionCurrent: hook.isRunSelectionCurrent,
      setActiveThreadId,
      setModel,
      setProvider,
      setSelectedArtifactId,
      setThreadRuns,
      setToolRunResult,
      syncUrl,
    })
    const bootstrapA = projection.hydrateRunState('run_a').catch(error => {
      projection.clearActiveRunState()
      throw error
    })
    const historyB = projection.hydrateRunState('run_b')

    pendingSubscriptions.requests.get('run_b')?.resolve(snapshot('run_b'))
    await expect(historyB).resolves.toMatchObject({ status: 'applied', run: { id: 'run_b' } })
    pendingSubscriptions.requests.get('run_a')?.resolve(snapshot('run_a'))
    await expect(bootstrapA).resolves.toEqual({ status: 'superseded' })

    expect((reducerHarness.state as RunState).run?.id).toBe('run_b')
    expect(clearRun).not.toHaveBeenCalled()
    expect(clearArtifacts).not.toHaveBeenCalled()
    expect(clearCanonicalThreadItems).not.toHaveBeenCalled()
    expect(setToolRunResult).not.toHaveBeenCalled()
    expect(setActiveThreadId).toHaveBeenCalledTimes(1)
    expect(syncUrl).toHaveBeenCalledTimes(1)
    expect(syncUrl).toHaveBeenCalledWith('session_1', 'run_b', 'thread_1')
  })

  it('thread A/B 的 getThread 乱序完成时只允许最新 B 水合与导航', async () => {
    const hook = renderRunStateHook()
    const setActiveThreadId = vi.fn()
    const setCanonicalThreadItems = vi.fn()
    const setThreadRuns = vi.fn()
    const syncUrl = vi.fn()
    const projection = WorkspaceRunProjectionHarness({
      abortRunSelection: hook.abortRunSelection,
      beginRunSelection: hook.beginRunSelection,
      captureRunSelection: hook.captureRunSelection,
      clearArtifacts: vi.fn(),
      clearCanonicalThreadItems: vi.fn(),
      clearRun: vi.fn(),
      hydrateRun: hook.hydrateRun,
      isRunSelectionCurrent: hook.isRunSelectionCurrent,
      setActiveThreadId,
      setModel: vi.fn(),
      setProvider: vi.fn(),
      setSelectedArtifactId: vi.fn(),
      setThreadRuns,
      setToolRunResult: vi.fn(),
      syncUrl,
    })
    const detailA = deferred<ThreadDetailSnapshot>()
    const detailB = deferred<ThreadDetailSnapshot>()
    const historyA = deferred<ThreadHistoryPage>()
    const historyB = deferred<ThreadHistoryPage>()
    const details = new Map([
      ['thread_a', detailA],
      ['thread_b', detailB],
    ])
    const histories = new Map([
      ['thread_a', historyA],
      ['thread_b', historyB],
    ])
    const actions = ThreadLifecycleHarness({
      ...projection,
      session: { id: 'session_1' } as SessionRecord,
      currentThreadId: null,
      clearUploads: vi.fn(),
      focusQueryInput: vi.fn(),
      forkFromMessage: vi.fn(),
      getThread: threadId => details.get(threadId)!.promise,
      getThreadHistory: threadId => histories.get(threadId)!.promise,
      hasMoreRunHistory: false,
      isRunHistoryLoading: false,
      loadRunHistory: vi.fn(),
      purgeTrashedThread: vi.fn(),
      refreshMemoryEntries: vi.fn(),
      refreshTrash: vi.fn(),
      removeThread: vi.fn(),
      renameThread: vi.fn(),
      restoreTrashedThread: vi.fn(),
      setActiveNav: vi.fn(),
      setActiveSidebarItem: vi.fn(),
      setActiveThreadId,
      setCanonicalThreadItems,
      setPanelMode: vi.fn(),
      setQuery: vi.fn(),
      setThreadRuns,
      setUiError: vi.fn(),
      syncUrl,
    })

    const selectA = actions.handleSelectThread('thread_a')
    const selectB = actions.handleSelectThread('thread_b')
    const runB = snapshot('run_b', undefined, 'thread_b').run
    detailB.resolve(threadDetail('thread_b', runB))
    historyB.resolve({ entries: [], nextCursor: null })
    await flushMicrotasks()
    expect(pendingSubscriptions.requests.has('run_b')).toBe(true)
    expect(setActiveThreadId).not.toHaveBeenCalled()
    expect(setThreadRuns).not.toHaveBeenCalled()
    pendingSubscriptions.requests.get('run_b')?.resolve(snapshot('run_b', undefined, 'thread_b'))
    await selectB

    const runA = snapshot('run_a', undefined, 'thread_a').run
    detailA.resolve(threadDetail('thread_a', runA))
    historyA.resolve({ entries: [], nextCursor: null })
    await selectA

    expect(pendingSubscriptions.requests.has('run_a')).toBe(false)
    expect((reducerHarness.state as RunState).run?.id).toBe('run_b')
    expect(setCanonicalThreadItems).toHaveBeenCalledTimes(1)
    expect(setCanonicalThreadItems).toHaveBeenCalledWith('thread_b', [])
    expect(setActiveThreadId).not.toHaveBeenCalledWith('thread_a')
    expect(syncUrl.mock.calls.every(([, runId]) => runId === 'run_b')).toBe(true)
  })

  it('tool API 迟到时不会越过更新的用户导航去水合旧 run', async () => {
    const hook = renderRunStateHook()
    const syncUrl = vi.fn()
    const projection = WorkspaceRunProjectionHarness({
      abortRunSelection: hook.abortRunSelection,
      beginRunSelection: hook.beginRunSelection,
      captureRunSelection: hook.captureRunSelection,
      clearArtifacts: vi.fn(),
      clearCanonicalThreadItems: vi.fn(),
      clearRun: vi.fn(),
      hydrateRun: hook.hydrateRun,
      isRunSelectionCurrent: hook.isRunSelectionCurrent,
      setActiveThreadId: vi.fn(),
      setModel: vi.fn(),
      setProvider: vi.fn(),
      setSelectedArtifactId: vi.fn(),
      setThreadRuns: vi.fn(),
      setToolRunResult: vi.fn(),
      syncUrl,
    })
    const toolResponse = deferred<DirectToolRunResponse>()
    const setToolRunResult = vi.fn()
    const runTool = ToolExecutionHarness({
      ...projection,
      sessionId: 'session_1',
      threadId: 'thread_tool',
      runId: 'run_active',
      runTool: () => toolResponse.promise,
      setIsToolSubmitting: vi.fn(),
      setToolRunResult,
      setUiError: vi.fn(),
      syncUrl,
    })

    const staleTool = runTool({
      name: 'buffer',
      label: '缓冲区',
      toolKind: 'analysis',
    } as ToolDescriptor, {})
    toolResponse.resolve({
      result: {
        message: '已完成',
        payload: {},
        warnings: [],
        resultId: 'tool_result_1',
        source: 'test',
      },
      run: snapshot('run_tool', undefined, 'thread_tool').run,
    })
    await flushMicrotasks()
    expect(pendingSubscriptions.requests.has('run_tool')).toBe(true)
    expect(setToolRunResult).not.toHaveBeenCalled()

    const navigationB = projection.hydrateRunState('run_b')
    pendingSubscriptions.requests.get('run_b')?.resolve(snapshot('run_b'))
    await expect(navigationB).resolves.toMatchObject({ status: 'applied', run: { id: 'run_b' } })
    pendingSubscriptions.requests.get('run_tool')?.resolve(snapshot('run_tool', undefined, 'thread_tool'))
    await staleTool

    expect(setToolRunResult).not.toHaveBeenCalled()
    expect((reducerHarness.state as RunState).run?.id).toBe('run_b')
    expect(syncUrl.mock.calls.some(([, runId]) => runId === 'run_tool')).toBe(false)
  })

  it('thread/tool 的 hydrate 前 API 失败会 abort pending 并恢复 active A capability', async () => {
    const hook = renderRunStateHook()
    const activeA = hook.hydrateRun('run_a')
    pendingSubscriptions.requests.get('run_a')?.resolve(
      snapshot('run_a', undefined, 'thread_1', 'completed'),
    )
    await activeA
    const projection = WorkspaceRunProjectionHarness({
      abortRunSelection: hook.abortRunSelection,
      beginRunSelection: hook.beginRunSelection,
      captureRunSelection: hook.captureRunSelection,
      clearArtifacts: vi.fn(),
      clearCanonicalThreadItems: vi.fn(),
      clearRun: vi.fn(),
      hydrateRun: hook.hydrateRun,
      isRunSelectionCurrent: hook.isRunSelectionCurrent,
      setActiveThreadId: vi.fn(),
      setModel: vi.fn(),
      setProvider: vi.fn(),
      setSelectedArtifactId: vi.fn(),
      setThreadRuns: vi.fn(),
      setToolRunResult: vi.fn(),
      syncUrl: vi.fn(),
    })
    const threadError = vi.fn()
    const threadActions = ThreadLifecycleHarness({
      ...projection,
      session: { id: 'session_1' } as SessionRecord,
      getThread: async () => { throw new Error('thread fetch failed') },
      getThreadHistory: async () => ({ entries: [], nextCursor: null }),
      setActiveThreadId: vi.fn(),
      setCanonicalThreadItems: vi.fn(),
      setThreadRuns: vi.fn(),
      setUiError: threadError,
      syncUrl: vi.fn(),
    } as unknown as ThreadLifecycleOptions)

    await threadActions.handleSelectThread('thread_b')
    expect(threadError).toHaveBeenLastCalledWith('thread fetch failed')
    expect(hook.captureRunSelection('run_a')).not.toBeNull()

    const toolError = vi.fn()
    const runTool = ToolExecutionHarness({
      ...projection,
      sessionId: 'session_1',
      runTool: async () => { throw new Error('tool start failed') },
      setIsToolSubmitting: vi.fn(),
      setToolRunResult: vi.fn(),
      setUiError: toolError,
      syncUrl: vi.fn(),
    })
    await runTool({ name: 'buffer', label: '缓冲区', toolKind: 'analysis' } as ToolDescriptor, {})

    expect(toolError).toHaveBeenLastCalledWith('tool start failed')
    expect(hook.captureRunSelection('run_a')).not.toBeNull()
  })
})

function renderRunStateHook() {
  reducerHarness.refCursor = 0
  reducerHarness.effectCursor = 0
  return RunStateHookHarness()
}

function RunStateHookHarness() {
  return useRunState()
}

function WorkspaceRunProjectionHarness(options: WorkspaceRunProjectionOptions) {
  return useWorkspaceRunProjection(options)
}

function ThreadLifecycleHarness(options: ThreadLifecycleOptions) {
  return useThreadLifecycleActions(options)
}

function ToolExecutionHarness(options: ToolExecutionActionOptions) {
  return useToolExecutionAction(options)
}

function emitPush(message: unknown): void {
  for (const listener of wsHarness.listeners) listener(message)
}

function snapshot(
  runId: string,
  body?: string,
  threadId = 'thread_1',
  status: RunSnapshot['run']['status'] = 'running',
): RunSnapshot {
  const run = analysisRunSchema.parse({
    id: runId,
    threadId,
    sessionId: 'session_1',
    visibility: 'workspace',
    userQuery: '测试',
    status,
    createdAt: '2026-08-08T00:00:00.000Z',
    updatedAt: '2026-08-08T00:00:00.000Z',
    state: {
      sessionId: 'session_1',
      threadId: 'thread_1',
      userQuery: '测试',
    },
  })
  const items = body === undefined
    ? []
    : [conversationItemSchema.parse({
        itemId: `item_${runId}`,
        itemType: 'message',
        runId,
        threadId,
        role: 'assistant',
        body,
        status: 'completed',
        timestamp: '2026-08-08T00:00:01.000Z',
      })]
  return runSnapshotSchema.parse({
    run,
    items,
    events: [],
    itemStream: {
      streamId: `stream_${runId}`,
      cursors: items.map(item => ({
        itemId: item.itemId,
        sequence: 0,
        utf16Offset: (item.body ?? '').length,
      })),
    },
  })
}

function threadDetail(
  threadId: string,
  run: RunSnapshot['run'],
): ThreadDetailSnapshot {
  return {
    thread: {
      id: threadId,
      sessionId: run.sessionId,
      latestRunId: run.id,
    } as ThreadDetailSnapshot['thread'],
    manifest: {} as ThreadDetailSnapshot['manifest'],
  }
}

function completedEvent(runId: string) {
  return runEventSchema.parse({
    eventId: `event_completed_${runId}`,
    runId,
    threadId: 'thread_1',
    type: 'run.completed',
    message: '运行完成',
    timestamp: '2026-08-08T00:00:02.000Z',
  })
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}
