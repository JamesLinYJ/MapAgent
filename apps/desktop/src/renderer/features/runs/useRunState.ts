// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运行状态 Hook
//
//   文件:       useRunState.ts
//
//   日期:       2026年05月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { useCallback, useEffect, useReducer, useRef, startTransition } from 'react'
import type {
  AgentState,
  AnalysisRun,
  ArtifactRef,
  AgentWorkflow,
  RunEvent,
  UserIntent,
  ConversationItem,
  ConversationItemTextDelta,
  RunItemUpsert,
  RunSnapshot,
} from '@geo-agent-platform/shared-types'
import {
  ConversationProjectionIndex,
  isSuccessfulRunStreamResult,
  RunStreamProjection,
} from '@geo-agent-platform/conversation-presentation'
import {
  subscribeRun,
  unsubscribeRun,
} from '../../api/client'
import { wsClient } from '../../ws/client'
import { isRecord } from '../../shared/utils/guards'
import { reportClientDiagnostic } from '../../shared/utils/clientDiagnostics'
import {
  FrameProjectionPublisher,
  shouldPublishRunProjectionImmediately,
} from './frameProjectionPublisher'

// 运行状态所有权
//
// 这个 hook 只持有服务端 run 的 UI 投影：完成态通过 hydrate 获取事实快照，
// 聊天态通过 ConversationItem 追加；切换 run 时必须清理旧 item，避免历史串台。

export interface RunState {
  run?: AnalysisRun
  projectionGeneration: number
  expectedRunId: string | null
  agentState?: AgentState
  intent?: UserIntent
  agentWorkflow?: AgentWorkflow
  events: RunEvent[]
  artifacts: ArtifactRef[]
  isSubmitting: boolean
  uiError?: string
  seenEventIds: Set<string>
  placeResolution?: { status: string; selected?: { latitude?: number | null; longitude?: number | null } | null } | null
  featureCount?: number
  items: ConversationItem[]
}

const MAX_EVENTS = 1000

interface RunProjectionIdentity {
  runId: string
  generation: number
}

export type RunHydrationResult =
  | { status: 'applied'; run: AnalysisRun }
  | { status: 'superseded' }

const runSelectionTokenBrand = Symbol('run-selection-token')

export interface RunSelectionToken {
  readonly [runSelectionTokenBrand]: true
}

export interface RunSelectionCapability {
  abortRunSelection: (selection: RunSelectionToken) => boolean
  beginRunSelection: () => RunSelectionToken
  captureRunSelection: (runId: string) => RunSelectionToken | null
  isRunSelectionCurrent: (selection: RunSelectionToken) => boolean
}

interface ActiveRunSelection {
  runId: string
  selection: RunSelectionToken
}

interface SubmittingRunSelection {
  runId: string | null
  selection: RunSelectionToken
}

function createRunSelectionToken(): RunSelectionToken {
  return Object.freeze({
    [runSelectionTokenBrand]: true as const,
  })
}

function initialState(): RunState {
  return {
    projectionGeneration: 0,
    expectedRunId: null,
    events: [],
    items: [],
    artifacts: [],
    isSubmitting: false,
    seenEventIds: new Set(),
  }
}

function formatHydrationError(error: unknown) {
  // hydrate 错误必须显式浮出到 UI。
  //
  // 完成态快照是最终结果和 artifact 的事实来源；失败时不能静默吞掉。
  if (error instanceof Error && error.message.trim()) {
    return error.message
  }
  if (typeof error === 'string' && error.trim()) {
    return error
  }
  return '刷新运行状态失败。'
}

function mergeConversationItems(current: ConversationItem[], incoming: ConversationItem[]) {
  // ConversationItem 是聊天事实源。
  //
  // started/delta/completed 可能反复更新同一个 itemId；索引负责 upsert、
  // transcript 去重和稳定排序，避免直播与刷新后的展示规则分叉。
  const projection = new ConversationProjectionIndex(current, 'live')
  projection.upsertMany(incoming, 'live')
  return projection.toArray()
}

// Reducer 只做纯状态转移
//
// 网络订阅、hydrate 和提交态收敛都在 hook 层完成，避免 render 期间写 ref
// 或由 effect 同步派生 React 本身已经能表达的状态。

export type RunAction =
  | { type: 'SET_RUN'; runId: string; generation: number; run: AnalysisRun; agentState: AgentState; intent?: UserIntent; plan?: AgentWorkflow; artifacts: ArtifactRef[]; isSubmitting?: boolean }
  | { type: 'CLEAR_RUN'; generation: number }
  | { type: 'APPEND_EVENT'; runId: string; generation: number; event: RunEvent; isSubmitting?: boolean }
  | { type: 'SET_EVENTS'; runId: string; generation: number; events: RunEvent[] }
  | { type: 'SET_PROJECTED_ITEMS'; runId: string; generation: number; items: ConversationItem[] }
  | { type: 'SET_SUBMITTING'; value: boolean }
  | { type: 'SET_ERROR'; error?: string }
  | { type: 'SET_INTENT'; intent: UserIntent }
  | { type: 'SET_PLAN'; plan: AgentWorkflow }
  | { type: 'APPEND_ARTIFACT'; artifact: ArtifactRef }
  | { type: 'SET_ITEMS'; items: ConversationItem[] }
  | { type: 'SET_PLACE_RESOLUTION'; placeResolution: RunState['placeResolution'] }

// 导出 reducer 以便测试直接验证 CLEAR_RUN / SET_RUN 等状态转移；
// 不依赖 React 渲染环境。
export function runReducer(state: RunState, action: RunAction): RunState {
  switch (action.type) {
    case 'SET_RUN': {
      if (
        action.run.id !== action.runId
        || action.generation < state.projectionGeneration
        || (
          action.generation === state.projectionGeneration
          && state.expectedRunId !== null
          && state.expectedRunId !== action.runId
        )
      ) return state
      const isDifferentRun = state.run?.id !== action.run.id
      const run = isDifferentRun
        ? action.run
        : mergeRunLifecycleProjection(state.run, action.run)
      const isRunning = run.status === 'running'
      return {
        ...state,
        projectionGeneration: action.generation,
        expectedRunId: action.runId,
        run,
        agentState: run === action.run ? action.agentState : state.agentState,
        intent: run === action.run ? action.intent : state.intent,
        agentWorkflow: run === action.run ? action.plan : state.agentWorkflow,
        artifacts: run === action.run ? action.artifacts ?? [] : state.artifacts,
        placeResolution: run === action.run
          ? action.agentState.placeResolution ?? null
          : state.placeResolution,
        isSubmitting: action.isSubmitting
          ?? (isDifferentRun ? isRunning : isRunning ? state.isSubmitting : false),
        uiError: isDifferentRun ? undefined : state.uiError,
        events: isDifferentRun ? [] : state.events,
        seenEventIds: isDifferentRun ? new Set<string>() : state.seenEventIds,
        items: isDifferentRun ? [] : state.items,
      }
    }
    case 'SET_ITEMS':
      return { ...state, items: mergeConversationItems([], action.items) }
    case 'SET_PROJECTED_ITEMS':
      if (!isCurrentProjectionAction(state, action)) return state
      return { ...state, items: action.items }
    case 'CLEAR_RUN':
      if (action.generation < state.projectionGeneration) return state
      return {
        ...initialState(),
        projectionGeneration: action.generation,
        seenEventIds: new Set(),
      }
    case 'APPEND_EVENT': {
      if (!isCurrentProjectionAction(state, action) || action.event.runId !== action.runId) {
        return state
      }
      const currentEvents = state.events.filter(event => event.runId === action.runId)
      const duplicate = currentEvents.some(event => event.eventId === action.event.eventId)
      const events = duplicate
        ? currentEvents
        : [
            ...(currentEvents.length >= MAX_EVENTS
              ? currentEvents.slice(-(MAX_EVENTS - 1))
              : currentEvents),
            action.event,
          ]
      const terminalStatus = terminalStatusFromEvent(action.event)
      const appliedTerminalStatus = terminalStatus
      const run = appliedTerminalStatus && state.run
        ? {
            ...state.run,
            status: appliedTerminalStatus,
            updatedAt: action.event.timestamp,
          }
        : state.run
      if (duplicate && run === state.run && currentEvents.length === state.events.length) return state
      return {
        ...state,
        run,
        events,
        seenEventIds: duplicate
          ? state.seenEventIds
          : new Set(events.map((event) => event.eventId)),
        isSubmitting: action.isSubmitting
          ?? (appliedTerminalStatus ? false : state.isSubmitting),
      }
    }
    case 'SET_EVENTS': {
      if (!isCurrentProjectionAction(state, action)) return state
      const events = mergeRunEvents(
        state.events.filter(event => event.runId === action.runId),
        action.events.filter(event => event.runId === action.runId),
      ).slice(-MAX_EVENTS)
      return { ...state, events, seenEventIds: new Set(events.map((event) => event.eventId)) }
    }
    case 'SET_SUBMITTING':
      return { ...state, isSubmitting: action.value }
    case 'SET_ERROR':
      return { ...state, uiError: action.error }
    case 'SET_INTENT':
      return { ...state, intent: action.intent }
    case 'SET_PLAN':
      return { ...state, agentWorkflow: action.plan }
    case 'APPEND_ARTIFACT':
      return {
        ...state,
        artifacts: state.artifacts.some((a) => a.artifactId === action.artifact.artifactId)
          ? state.artifacts
          : [...state.artifacts, action.artifact],
      }
    case 'SET_PLACE_RESOLUTION':
      return { ...state, placeResolution: action.placeResolution }
    default:
      return state
  }
}

function isCurrentProjectionAction(
  state: RunState,
  action: { runId: string; generation: number },
): boolean {
  return state.projectionGeneration === action.generation
    && state.expectedRunId === action.runId
    && state.run?.id === action.runId
}

function mergeRunEvents(current: RunEvent[], incoming: RunEvent[]): RunEvent[] {
  const events = new Map(current.map(event => [event.eventId, event]))
  for (const event of incoming) events.set(event.eventId, event)
  return [...events.values()].sort((left, right) => (
    left.timestamp.localeCompare(right.timestamp) || left.eventId.localeCompare(right.eventId)
  ))
}

const FINAL_RUN_STATUSES = new Set<AnalysisRun['status']>([
  'completed',
  'failed',
  'cancelled',
])

function mergeRunLifecycleProjection(
  current: AnalysisRun | undefined,
  incoming: AnalysisRun,
): AnalysisRun {
  if (!current || current.id !== incoming.id) return incoming
  if (incoming.updatedAt < current.updatedAt) return current
  if (FINAL_RUN_STATUSES.has(current.status) && !FINAL_RUN_STATUSES.has(incoming.status)) {
    return current
  }
  return incoming
}

function terminalStatusFromEvent(event: RunEvent): AnalysisRun['status'] | null {
  if (event.type === 'run.completed') return 'completed'
  if (event.type !== 'run.failed') return null
  return event.payload.cancelled === true ? 'cancelled' : 'failed'
}

// Hook 入口
//
// 对外暴露稳定命令函数；内部根据 runId 管理 WebSocket 订阅与快照回放。

export function useRunState() {
  const [state, dispatch] = useReducer(runReducer, undefined, initialState)
  const runId = state.run?.id
  const subscribedRunIdRef = useRef<string | null>(null)
  const projectionGenerationRef = useRef(0)
  const pendingRunSelectionRef = useRef<RunSelectionToken | null>(null)
  const latestRunSelectionIntentRef = useRef<RunSelectionToken | null>(null)
  const committedRunSelectionRef = useRef<ActiveRunSelection | null>(null)
  const runSelectionTargetsRef = useRef(new WeakMap<RunSelectionToken, string>())
  const submittingRunSelectionRef = useRef<SubmittingRunSelection | null>(null)
  const activeRefreshTailRef = useRef<Promise<void>>(Promise.resolve())
  const requestedRunIdRef = useRef<string | null>(null)
  const expectedRunIdRef = useRef<string | null>(null)
  const projectionRunIdRef = useRef<string | null>(null)
  const liveProjectionRef = useRef<RunStreamProjection | null>(null)
  const projectionPublisherRef = useRef<FrameProjectionPublisher<RunProjectionIdentity> | null>(null)
  if (!projectionPublisherRef.current) {
    projectionPublisherRef.current = new FrameProjectionPublisher<RunProjectionIdentity>()
  }

  const resetLiveProjection = useCallback((runId: string | null, items: ReadonlyArray<ConversationItem>) => {
    projectionPublisherRef.current?.cancel()
    projectionRunIdRef.current = runId
    const projection = new RunStreamProjection()
    projection.beginSnapshot()
    const accepted = projection.acceptSnapshot(items, localItemStream(runId, items))
    liveProjectionRef.current = projection
    return accepted.items
  }, [])

  const activateProjection = useCallback((nextRunId: string): RunProjectionIdentity => {
    if (expectedRunIdRef.current !== nextRunId) {
      projectionGenerationRef.current += 1
      expectedRunIdRef.current = nextRunId
      resetLiveProjection(nextRunId, [])
    }
    return { runId: nextRunId, generation: projectionGenerationRef.current }
  }, [resetLiveProjection])

  const currentProjection = useCallback((expectedRunId: string): RunProjectionIdentity | null => {
    if (expectedRunIdRef.current !== expectedRunId) return null
    return { runId: expectedRunId, generation: projectionGenerationRef.current }
  }, [])

  const isCurrentProjection = useCallback((identity: RunProjectionIdentity): boolean => (
    expectedRunIdRef.current === identity.runId
    && projectionGenerationRef.current === identity.generation
  ), [])

  const publishProjectedItems = useCallback((identity: RunProjectionIdentity, immediate: boolean) => {
    const publish = (nextIdentity: RunProjectionIdentity) => {
      if (!isCurrentProjection(nextIdentity)) return
      // 快照物化也延迟到发布点；同一绘制帧的连续 delta 只扫描一次索引。
      const items = liveProjectionRef.current?.toArray() ?? []
      const action: RunAction = {
        type: 'SET_PROJECTED_ITEMS',
        ...nextIdentity,
        items,
      }
      if (immediate) dispatch(action)
      else startTransition(() => dispatch(action))
    }
    if (immediate) projectionPublisherRef.current?.publishNow(identity, publish)
    else projectionPublisherRef.current?.schedule(identity, publish)
  }, [isCurrentProjection])

  const beginRunSelection = useCallback((): RunSelectionToken => {
    const selection = createRunSelectionToken()
    pendingRunSelectionRef.current = selection
    latestRunSelectionIntentRef.current = selection
    requestedRunIdRef.current = null
    return selection
  }, [])

  const isRunSelectionCurrent = useCallback((selection: RunSelectionToken): boolean => {
    const pendingSelection = pendingRunSelectionRef.current
    if (pendingSelection) return pendingSelection === selection
    return latestRunSelectionIntentRef.current === selection
      || committedRunSelectionRef.current?.selection === selection
  }, [])

  const captureRunSelection = useCallback((selectedRunId: string): RunSelectionToken | null => {
    if (pendingRunSelectionRef.current || expectedRunIdRef.current !== selectedRunId) return null
    const activeSelection = committedRunSelectionRef.current
    if (!activeSelection || activeSelection.runId !== selectedRunId) return null
    return activeSelection.selection
  }, [])

  const rotateCommittedRunSelection = useCallback(() => {
    const committedSelection = committedRunSelectionRef.current
    if (!committedSelection) {
      return null
    }
    const selection = createRunSelectionToken()
    runSelectionTargetsRef.current.set(selection, committedSelection.runId)
    committedRunSelectionRef.current = { runId: committedSelection.runId, selection }
    return { previous: committedSelection.selection, selection }
  }, [])

  const abortRunSelection = useCallback((selection: RunSelectionToken): boolean => {
    if (pendingRunSelectionRef.current !== selection) return false
    pendingRunSelectionRef.current = null
    requestedRunIdRef.current = null
    const rotatedSelection = rotateCommittedRunSelection()
    const submitting = submittingRunSelectionRef.current
    if (submitting) {
      if (rotatedSelection?.previous === submitting.selection) {
        submittingRunSelectionRef.current = {
          ...submitting,
          selection: rotatedSelection.selection,
        }
      } else {
        submittingRunSelectionRef.current = null
        dispatch({ type: 'SET_SUBMITTING', value: false })
      }
    }
    return true
  }, [rotateCommittedRunSelection])

  const isRunSelectionOperationCurrent = useCallback((selection: RunSelectionToken): boolean => {
    const pendingSelection = pendingRunSelectionRef.current
    if (pendingSelection) return pendingSelection === selection
    return committedRunSelectionRef.current?.selection === selection
  }, [])

  const bindRunSelection = useCallback((
    selection: RunSelectionToken,
    selectedRunId: string,
  ): boolean => {
    if (!isRunSelectionOperationCurrent(selection)) return false
    const boundRunId = runSelectionTargetsRef.current.get(selection)
    if (boundRunId !== undefined && boundRunId !== selectedRunId) return false
    if (boundRunId === undefined) runSelectionTargetsRef.current.set(selection, selectedRunId)
    return true
  }, [isRunSelectionOperationCurrent])

  const commitRunSelection = useCallback((
    selection: RunSelectionToken,
    selectedRunId: string,
  ): boolean => {
    if (
      !isRunSelectionOperationCurrent(selection)
      || runSelectionTargetsRef.current.get(selection) !== selectedRunId
    ) return false
    if (pendingRunSelectionRef.current === selection) {
      pendingRunSelectionRef.current = null
    }
    committedRunSelectionRef.current = { runId: selectedRunId, selection }
    return true
  }, [isRunSelectionOperationCurrent])

  const beginLiveSnapshot = useCallback((identity: RunProjectionIdentity) => {
    if (!isCurrentProjection(identity)) return false
    projectionPublisherRef.current?.cancel()
    if (!liveProjectionRef.current || projectionRunIdRef.current !== identity.runId) {
      liveProjectionRef.current = new RunStreamProjection()
      projectionRunIdRef.current = identity.runId
    }
    liveProjectionRef.current.beginSnapshot()
    return true
  }, [isCurrentProjection])

  const appendLiveItem = useCallback((
    update: RunItemUpsert,
    identity: RunProjectionIdentity,
  ): boolean => {
    if (!isCurrentProjection(identity) || update.item.runId !== identity.runId) return true
    if (!liveProjectionRef.current) {
      liveProjectionRef.current = new RunStreamProjection()
      projectionRunIdRef.current = identity.runId
    }
    const result = liveProjectionRef.current.acceptItem(update)
    if (result === 'queued') return true
    if (!isSuccessfulRunStreamResult(result)) return false
    publishProjectedItems(identity, update.item.status !== 'running')
    return true
  }, [isCurrentProjection, publishProjectedItems])

  const appendLiveDelta = useCallback((
    delta: ConversationItemTextDelta,
    identity: RunProjectionIdentity,
  ): boolean => {
    if (!isCurrentProjection(identity) || delta.runId !== identity.runId) return true
    if (!liveProjectionRef.current) {
      liveProjectionRef.current = new RunStreamProjection()
      projectionRunIdRef.current = identity.runId
    }
    const result = liveProjectionRef.current.acceptDelta(delta)
    if (result === 'queued') return true
    if (!isSuccessfulRunStreamResult(result)) return false
    publishProjectedItems(identity, false)
    return true
  }, [isCurrentProjection, publishProjectedItems])

  const absorbSnapshot = useCallback((
    snapshot: RunSnapshot,
    identity: RunProjectionIdentity,
  ) => {
    if (!isCurrentProjection(identity) || snapshot.run.id !== identity.runId) return true
    projectionPublisherRef.current?.cancel()
    if (!liveProjectionRef.current || projectionRunIdRef.current !== snapshot.run.id) {
      liveProjectionRef.current = new RunStreamProjection()
      projectionRunIdRef.current = snapshot.run.id
      liveProjectionRef.current.beginSnapshot()
    }
    const committedSelection = committedRunSelectionRef.current
    const submitting = submittingRunSelectionRef.current
    if (
      committedSelection?.runId === snapshot.run.id
      && (
        !submitting
        || submitting.selection === committedSelection.selection
        || pendingRunSelectionRef.current === null
      )
    ) {
      submittingRunSelectionRef.current = snapshot.run.status === 'running'
        ? { runId: snapshot.run.id, selection: committedSelection.selection }
        : null
    }
    const accepted = liveProjectionRef.current.acceptSnapshot(snapshot.items, snapshot.itemStream)
    dispatch({
      type: 'SET_RUN',
      ...identity,
      run: snapshot.run,
      agentState: snapshot.run.state,
      intent: snapshot.run.state.parsedIntent ?? undefined,
      plan: snapshot.run.state.agentWorkflow ?? undefined,
      artifacts: snapshot.run.state.artifacts,
      isSubmitting: submittingRunSelectionRef.current !== null,
    })
    dispatch({ type: 'SET_PROJECTED_ITEMS', ...identity, items: accepted.items })
    dispatch({ type: 'SET_EVENTS', ...identity, events: snapshot.events })
    return accepted.consistent
  }, [isCurrentProjection])

  const clearRun = useCallback(() => {
    projectionPublisherRef.current?.cancel()
    beginRunSelection()
    pendingRunSelectionRef.current = null
    committedRunSelectionRef.current = null
    submittingRunSelectionRef.current = null
    requestedRunIdRef.current = null
    projectionGenerationRef.current += 1
    expectedRunIdRef.current = null
    projectionRunIdRef.current = null
    liveProjectionRef.current = null
    dispatch({ type: 'CLEAR_RUN', generation: projectionGenerationRef.current })
  }, [beginRunSelection])

  const hydrateRun = useCallback(async (
    runId: string,
    selection: RunSelectionToken = beginRunSelection(),
  ) => {
    if (!bindRunSelection(selection, runId)) return { status: 'superseded' } as const
    requestedRunIdRef.current = runId
    try {
      const snapshot = await subscribeRun(runId)
      if (
        !isRunSelectionOperationCurrent(selection)
        || requestedRunIdRef.current !== runId
      ) return { status: 'superseded' } as const
      if (snapshot.run.id !== runId) {
        throw new Error(`运行快照不匹配：请求 ${runId}，收到 ${snapshot.run.id}。`)
      }
      if (!commitRunSelection(selection, runId)) return { status: 'superseded' } as const
      const identity = activateProjection(runId)
      requestedRunIdRef.current = null
      subscribedRunIdRef.current = runId
      absorbSnapshot(snapshot, identity)
      return { status: 'applied', run: snapshot.run } as const
    } catch (error) {
      if (!isRunSelectionOperationCurrent(selection)) return { status: 'superseded' } as const
      const failedPendingSelection = pendingRunSelectionRef.current === selection
      if (
        requestedRunIdRef.current === runId
      ) requestedRunIdRef.current = null
      if (failedPendingSelection) {
        abortRunSelection(selection)
      }
      throw error
    }
  }, [
    absorbSnapshot,
    abortRunSelection,
    activateProjection,
    beginRunSelection,
    bindRunSelection,
    commitRunSelection,
    isRunSelectionOperationCurrent,
  ])

  const refreshActiveRun = useCallback((
    runId: string,
    selection: RunSelectionToken,
  ): Promise<RunHydrationResult> => {
    const scheduled = activeRefreshTailRef.current.then(async () => {
      if (captureRunSelection(runId) !== selection) {
        return { status: 'superseded' } as const
      }
      return hydrateRun(runId, selection)
    })
    activeRefreshTailRef.current = scheduled.then(
      () => undefined,
      () => undefined,
    )
    return scheduled
  }, [captureRunSelection, hydrateRun])

  const acceptRun = useCallback((
    latestRun: AnalysisRun,
    selection: RunSelectionToken = beginRunSelection(),
  ): boolean => {
    if (!bindRunSelection(selection, latestRun.id)) return false
    if (!commitRunSelection(selection, latestRun.id)) return false
    requestedRunIdRef.current = null
    submittingRunSelectionRef.current = latestRun.status === 'running'
      ? { runId: latestRun.id, selection }
      : null
    const identity = activateProjection(latestRun.id)
    dispatch({
      type: 'SET_RUN',
      ...identity,
      run: latestRun,
      agentState: latestRun.state,
      intent: latestRun.state.parsedIntent ?? undefined,
      plan: latestRun.state.agentWorkflow ?? undefined,
      artifacts: latestRun.state.artifacts,
      isSubmitting: submittingRunSelectionRef.current !== null,
    })
    return true
  }, [
    activateProjection,
    beginRunSelection,
    bindRunSelection,
    commitRunSelection,
  ])

  const startRun = useCallback((selection: RunSelectionToken) => {
    if (!isRunSelectionOperationCurrent(selection)) return false
    submittingRunSelectionRef.current = { runId: null, selection }
    dispatch({ type: 'SET_SUBMITTING', value: true })
    return true
  }, [isRunSelectionOperationCurrent])

  const stopSubmitting = useCallback((selection: RunSelectionToken) => {
    if (submittingRunSelectionRef.current?.selection !== selection) return false
    submittingRunSelectionRef.current = null
    dispatch({ type: 'SET_SUBMITTING', value: false })
    return true
  }, [])

  const finishRun = useCallback(async (runId: string) => {
    const selection = captureRunSelection(runId)
    if (!selection) return
    try {
      const hydration = await refreshActiveRun(runId, selection)
      if (hydration.status === 'superseded') return
    } catch (error) {
      dispatch({ type: 'SET_ERROR', error: formatHydrationError(error) })
    } finally {
      stopSubmitting(selection)
    }
  }, [captureRunSelection, refreshActiveRun, stopSubmitting])

  const setError = useCallback((error?: string) => {
    dispatch({ type: 'SET_ERROR', error })
  }, [])

  const setIntent = useCallback((intent: UserIntent) => {
    dispatch({ type: 'SET_INTENT', intent })
  }, [])

  const setPlan = useCallback((plan: AgentWorkflow) => {
    dispatch({ type: 'SET_PLAN', plan })
  }, [])

  const appendArtifact = useCallback((artifact: ArtifactRef) => {
    dispatch({ type: 'APPEND_ARTIFACT', artifact })
  }, [])

  // WebSocket 订阅是运行实时状态的唯一主线；重连后主动重订阅并吸收完整快照。
  useEffect(() => {
    if (!runId) return
    const identity = currentProjection(runId)
    if (!identity) return
    let disposed = false
    let synchronization: Promise<void> | null = null

    const absorbCurrentSnapshot = (snapshot: RunSnapshot) => {
      if (disposed || !isCurrentProjection(identity) || snapshot.run.id !== runId) return true
      subscribedRunIdRef.current = runId
      return absorbSnapshot(snapshot, identity)
    }

    const synchronize = () => {
      if (disposed || synchronization || !isCurrentProjection(identity)) return
      if (!beginLiveSnapshot(identity)) return
      synchronization = (async () => {
        const first = await subscribeRun(runId)
        if (absorbCurrentSnapshot(first)) return

        // offset/sequence 缺口只通过一次新的权威快照修复；第二次仍不一致时
        // 明确报错，不把不完整文本继续交给 UI。
        if (!beginLiveSnapshot(identity)) return
        const second = await subscribeRun(runId)
        if (!absorbCurrentSnapshot(second)) {
          throw new Error('实时文本流与运行快照连续两次不一致，已停止增量投影。')
        }
      })()
        .catch(error => {
          if (disposed || !isCurrentProjection(identity)) return
          const aborted = liveProjectionRef.current?.abortSnapshot()
          if (aborted) {
            dispatch({ type: 'SET_PROJECTED_ITEMS', ...identity, items: aborted.items })
          }
          dispatch({ type: 'SET_ERROR', error: formatHydrationError(error) })
        })
        .finally(() => {
          synchronization = null
        })
    }

    const unsubscribeMessages = wsClient.on(message => {
      if (disposed || !isCurrentProjection(identity)) return
      if (message.type === 'connected') {
        synchronize()
        return
      }
      if (message.type === 'run.item' && message.payload.data.item.runId === runId) {
        if (!appendLiveItem(message.payload.data, identity)) synchronize()
      }
      if (message.type === 'run.item.delta' && message.payload.data.runId === runId) {
        if (!appendLiveDelta(message.payload.data, identity)) synchronize()
      }
      if (message.type === 'run.event' && message.payload.data.runId === runId) {
        const event = message.payload.data
        const terminalStatus = terminalStatusFromEvent(event)
        const immediateProjectionBoundary = shouldPublishRunProjectionImmediately(event)
        const committedSelection = committedRunSelectionRef.current
        if (
          terminalStatus
          && committedSelection?.runId === runId
          && submittingRunSelectionRef.current?.selection === committedSelection.selection
        ) {
          submittingRunSelectionRef.current = null
        }
        if (immediateProjectionBoundary) publishProjectedItems(identity, true)
        const action: RunAction = {
          type: 'APPEND_EVENT',
          ...identity,
          event,
          isSubmitting: submittingRunSelectionRef.current !== null,
        }
        if (immediateProjectionBoundary) dispatch(action)
        else startTransition(() => dispatch(action))
      }
      if (message.type === 'run.snapshot' && isRunSnapshot(message.payload.data) && message.payload.data.run.id === runId) {
        if (!absorbCurrentSnapshot(message.payload.data)) synchronize()
      }
    })

    if (subscribedRunIdRef.current !== runId) {
      synchronize()
    }

    return () => {
      disposed = true
      projectionPublisherRef.current?.cancel()
      unsubscribeMessages()
      if (subscribedRunIdRef.current === runId) subscribedRunIdRef.current = null
      void unsubscribeRun(runId).catch(error => {
        reportClientDiagnostic('warn', { scope: 'unsubscribeRun', error, detail: { runId } })
      })
    }
  }, [
    absorbSnapshot,
    appendLiveDelta,
    appendLiveItem,
    beginLiveSnapshot,
    currentProjection,
    isCurrentProjection,
    publishProjectedItems,
    runId,
  ])

  const setItems = useCallback((items: ConversationItem[]) => {
    if (!runId) {
      if (expectedRunIdRef.current !== null) return
      resetLiveProjection(null, items)
      dispatch({ type: 'SET_ITEMS', items })
      return
    }
    const identity = currentProjection(runId)
    if (!identity) return
    resetLiveProjection(runId ?? null, items)
    dispatch({
      type: 'SET_PROJECTED_ITEMS',
      ...identity,
      items: liveProjectionRef.current?.toArray() ?? items,
    })
  }, [currentProjection, resetLiveProjection, runId])

  return {
    run: state.run,
    agentState: state.agentState,
    intent: state.intent,
    agentWorkflow: state.agentWorkflow,
    events: state.events,
    artifacts: state.artifacts,
    isSubmitting: state.isSubmitting,
    uiError: state.uiError,
    placeResolution: state.placeResolution,
    clearRun,
    items: state.items,
    abortRunSelection,
    beginRunSelection,
    captureRunSelection,
    isRunSelectionCurrent,
    hydrateRun,
    refreshActiveRun,
    acceptRun,
    startRun,
    finishRun,
    stopSubmitting,
    setError,
    setIntent,
    setPlan,
    appendArtifact,
    setItems,
  }
}
function isRunSnapshot(value: unknown): value is RunSnapshot {
  return isRecord(value)
    && isRecord(value.run)
    && Array.isArray(value.items)
    && Array.isArray(value.events)
    && isRecord(value.itemStream)
    && typeof value.itemStream.streamId === 'string'
    && Array.isArray(value.itemStream.cursors)
}

function localItemStream(
  runId: string | null,
  items: ReadonlyArray<ConversationItem>,
): RunSnapshot['itemStream'] {
  return {
    streamId: `local:${runId ?? 'none'}`,
    cursors: items.map(item => ({
      itemId: item.itemId,
      sequence: 0,
      utf16Offset: (item.body ?? '').length,
    })),
  }
}
