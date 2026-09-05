// +-------------------------------------------------------------------------
//
//   地理智能平台 - Run 生命周期动作
//
//   文件:       useRunLifecycleActions.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { startTransition, useCallback } from 'react'
import type {
  AgentExecutionMode,
  AgentRunProfile,
  AnalysisRun,
  ConversationItem,
  ModelProviderDescriptor,
  RunGoalInput,
  RunAttachmentInput,
  SessionRecord,
} from '@geo-agent-platform/shared-types'

import { supportsAgentSdkLiveSupervisor } from '../../shared/providerCapabilities'
import { projectTimeline } from '../../features/conversation/timelineProjector'
import type { RunSelectionToken } from '../../features/runs/useRunState'
import { formatUiError, reportNonBlockingError } from '../bootstrap'
import { mergeThreadRuns } from '../derivedState'
import type { PanelMode, PrimaryNav, SidebarItemId } from '../types'
import type { RunHydrationCapability } from './useWorkspaceRunProjection'

type ListUpdater<T> = T[] | ((current: T[]) => T[])

export interface RunLifecycleOptions extends RunHydrationCapability {
  captureRunSelection: (runId: string) => RunSelectionToken | null
  session?: SessionRecord
  currentThreadId?: string | null
  query: string
  items: ConversationItem[]
  providers: ModelProviderDescriptor[]
  provider: string
  model: string
  run?: AnalysisRun
  acceptRun: (run: AnalysisRun, selection?: RunSelectionToken) => boolean
  cancelRun: (runId: string) => Promise<AnalysisRun>
  clearArtifacts: () => void
  clearCanonicalThreadItems: () => void
  refreshCanonicalThreadHistory: (threadId: string) => Promise<unknown>
  refreshSessionHistory: (sessionId: string) => Promise<unknown>
  respondDecision: (
    runId: string,
    decisionId: string,
    optionId?: string | null,
    text?: string | null,
  ) => Promise<AnalysisRun>
  steerRun: (runId: string, content: string, steeringId: string) => Promise<unknown>
  setActiveNav: (nav: PrimaryNav) => void
  setActiveThreadId: (threadId?: string) => void
  setActiveSidebarItem: (item: SidebarItemId) => void
  setCanonicalThreadItems: (threadId: string, value: ListUpdater<ConversationItem>) => void
  setModel: (model: string) => void
  setPanelMode: (mode: PanelMode) => void
  setProvider: (provider: string) => void
  setQuery: (query: string) => void
  setThreadRuns: (value: ListUpdater<AnalysisRun>) => void
  setToolRunResult: (result: Record<string, unknown> | null) => void
  setUiError: (message?: string) => void
  startAnalysis: (
    sessionId: string,
    query: string,
    provider?: string,
    model?: string,
    executionMode?: AgentExecutionMode,
    runProfile?: AgentRunProfile,
    goal?: RunGoalInput | null,
    attachments?: RunAttachmentInput[],
  ) => Promise<AnalysisRun>
  startRun: (selection: RunSelectionToken) => boolean
  startThreadRun: (
    threadId: string,
    query: string,
    provider?: string,
    model?: string,
    executionMode?: AgentExecutionMode,
    runProfile?: AgentRunProfile,
    goal?: RunGoalInput | null,
    attachments?: RunAttachmentInput[],
  ) => Promise<AnalysisRun>
  stopSubmitting: (selection: RunSelectionToken) => boolean
  syncUrl: (sessionId: string, runId?: string, threadId?: string) => void
}

export function useRunLifecycleActions(options: RunLifecycleOptions) {
  const {
    session,
    abortRunSelection,
    beginRunSelection,
    captureRunSelection,
    currentThreadId,
    query,
    items,
    providers,
    provider,
    model,
    run,
    acceptRun,
    cancelRun,
    clearArtifacts,
    clearCanonicalThreadItems,
    hydrateRunState,
    isRunSelectionCurrent,
    refreshCanonicalThreadHistory,
    refreshSessionHistory,
    respondDecision,
    steerRun,
    setActiveNav,
    setActiveThreadId,
    setActiveSidebarItem,
    setCanonicalThreadItems,
    setModel,
    setPanelMode,
    setProvider,
    setQuery,
    setThreadRuns,
    setToolRunResult,
    setUiError,
    startAnalysis,
    startRun,
    startThreadRun,
    stopSubmitting,
    syncUrl,
  } = options

  const submitMessage = useCallback(async ({
    text,
    forceNewThread = false,
    executionMode = 'auto',
    runProfile = 'standard',
    goal = null,
    attachments = [],
  }: {
    text?: string
    forceNewThread?: boolean
    executionMode?: AgentExecutionMode
    runProfile?: AgentRunProfile
    goal?: RunGoalInput | null
    attachments?: RunAttachmentInput[]
  } = {}) => {
    if (!session) return false
    const submittedQuery = (text ?? query).trim()
    if (!submittedQuery) return false

    if (!forceNewThread && run?.status === 'running') {
      const selection = captureRunSelection(run.id)
      if (!selection) return false
      try {
        setUiError(undefined)
        await steerRun(run.id, submittedQuery, `steer_${crypto.randomUUID()}`)
        if (!isRunSelectionCurrent(selection)) return false
        setQuery('')
        return true
      } catch (error) {
        if (!isRunSelectionCurrent(selection)) return false
        setUiError(formatUiError(error, '引导消息提交失败，请重试。'))
        return false
      }
    }

    const targetThreadId = forceNewThread ? undefined : currentThreadId
    let selection: RunSelectionToken | null = null
    try {
      const selectedProvider = providers.find(item => item.provider === provider)
      if (selectedProvider && !selectedProvider.configured) {
        setUiError(`${selectedProvider.displayName} 还没配置好，暂时没法提交分析。`)
        return false
      }
      if (selectedProvider && !supportsAgentSdkLiveSupervisor(selectedProvider)) {
        setUiError(`${selectedProvider.displayName} 当前不是 Agent SDK 主路径，不能提交分析。`)
        return false
      }

      selection = beginRunSelection()
      setUiError(undefined)
      startRun(selection)
      setActiveNav('analysis')
      setPanelMode('summary')
      setActiveSidebarItem('assistant')
      if (forceNewThread) {
        clearArtifacts()
        setToolRunResult(null)
        clearCanonicalThreadItems()
      } else if (targetThreadId) {
        setCanonicalThreadItems(targetThreadId, current => projectTimeline(
          current,
          items.filter(item => item.status !== 'running' && [
            'message', 'function_call', 'function_call_output',
          ].includes(item.itemType)),
        ))
      }

      const createdRun = targetThreadId
        ? await startThreadRun(targetThreadId, submittedQuery, provider, model || undefined, executionMode, runProfile, goal, attachments)
        : await startAnalysis(session.id, submittedQuery, provider, model || undefined, executionMode, runProfile, goal, attachments)
      if (!isRunSelectionCurrent(selection)) return true
      const acceptedSelection = selection
      setQuery('')
      const nextThreadId = createdRun.threadId ?? targetThreadId
      startTransition(() => {
        acceptRun(createdRun, acceptedSelection)
        setProvider(createdRun.modelProvider ?? provider)
        setModel(createdRun.modelName ?? model)
        setActiveThreadId(nextThreadId ?? undefined)
        setThreadRuns(current => (nextThreadId && !forceNewThread
          ? mergeThreadRuns(current, createdRun)
          : [createdRun]))
      })
      void refreshSessionHistory(session.id).catch(error => {
        reportNonBlockingError('refreshSessionHistory:submitMessage', error)
      })
      syncUrl(session.id, createdRun.id, nextThreadId ?? undefined)
      return true
    } catch (error) {
      if (selection && !isRunSelectionCurrent(selection)) return false
      if (selection) abortRunSelection(selection)
      setUiError(formatUiError(error, '任务提交失败，请重试。'))
      if (selection) stopSubmitting(selection)
      return false
    }
  }, [
    acceptRun,
    abortRunSelection,
    beginRunSelection,
    captureRunSelection,
    clearArtifacts,
    clearCanonicalThreadItems,
    currentThreadId,
    items,
    isRunSelectionCurrent,
    model,
    provider,
    providers,
    query,
    refreshSessionHistory,
    run?.id,
    run?.status,
    session,
    setActiveNav,
    setActiveSidebarItem,
    setActiveThreadId,
    setCanonicalThreadItems,
    setModel,
    setPanelMode,
    setProvider,
    setQuery,
    setThreadRuns,
    setToolRunResult,
    setUiError,
    startAnalysis,
    startRun,
    startThreadRun,
    steerRun,
    stopSubmitting,
    syncUrl,
  ])

  const handleSubmit = useCallback(async (
    executionMode: AgentExecutionMode = 'auto',
    runProfile: AgentRunProfile = 'standard',
    goal: RunGoalInput | null = null,
    attachments: RunAttachmentInput[] = [],
  ) => {
    if (!query.trim()) return false
    return submitMessage({ executionMode, runProfile, goal, attachments })
  }, [query, submitMessage])

  const handleInterruptRun = useCallback(async () => {
    if (!run?.id) return
    const selection = beginRunSelection()
    try {
      setUiError(undefined)
      const cancelledRun = await cancelRun(run.id)
      if (!isRunSelectionCurrent(selection)) return
      acceptRun(cancelledRun, selection)
      if (cancelledRun.sessionId) {
        void refreshSessionHistory(cancelledRun.sessionId).catch(error => {
          reportNonBlockingError('refreshSessionHistory:cancelRun', error)
        })
      }
    } catch (error) {
      if (!isRunSelectionCurrent(selection)) return
      abortRunSelection(selection)
      setUiError(formatUiError(error, '中断运行失败，请稍后再试。'))
    } finally {
      stopSubmitting(selection)
    }
  }, [
    acceptRun,
    abortRunSelection,
    beginRunSelection,
    cancelRun,
    isRunSelectionCurrent,
    refreshSessionHistory,
    run?.id,
    setUiError,
    stopSubmitting,
  ])

  const handleRespondDecision = useCallback(async (
    decisionId: string,
    optionId?: string | null,
    text?: string | null,
  ) => {
    if (!run?.id) return
    const selection = beginRunSelection()
    let decisionSubmitted = false
    try {
      setUiError(undefined)
      startRun(selection)
      const nextRun = await respondDecision(run.id, decisionId, optionId, text)
      decisionSubmitted = true
      if (!isRunSelectionCurrent(selection)) return
      const nextThreadId = nextRun.threadId ?? currentThreadId
      if (nextThreadId) await refreshCanonicalThreadHistory(nextThreadId)
      if (!isRunSelectionCurrent(selection)) return
      if (!acceptRun(nextRun, selection)) return
      startTransition(() => {
        setProvider(nextRun.modelProvider ?? provider)
        setModel(nextRun.modelName ?? model)
        setActiveThreadId(nextThreadId ?? undefined)
        setThreadRuns(current => (nextThreadId ? mergeThreadRuns(current, nextRun) : current))
      })
      if (nextRun.sessionId) {
        void refreshSessionHistory(nextRun.sessionId).catch(error => {
          reportNonBlockingError('refreshSessionHistory:respondDecision', error)
        })
      }
      syncUrl(nextRun.sessionId, nextRun.id, nextThreadId ?? undefined)
      const hydration = await hydrateRunState(nextRun.id, selection)
      if (hydration.status === 'superseded') return
    } catch (error) {
      if (!isRunSelectionCurrent(selection)) return
      abortRunSelection(selection)
      if (decisionSubmitted) {
        reportNonBlockingError('hydrateConversation:respondDecision', error)
        setUiError('决策已经提交，但完整对话历史恢复失败。请刷新页面重新加载记录，不要重复提交决策。')
      } else {
        setUiError(formatUiError(error, '决策提交失败，请重试。'))
      }
      stopSubmitting(selection)
    }
  }, [
    acceptRun,
    abortRunSelection,
    beginRunSelection,
    currentThreadId,
    hydrateRunState,
    isRunSelectionCurrent,
    model,
    provider,
    refreshCanonicalThreadHistory,
    refreshSessionHistory,
    respondDecision,
    run?.id,
    setActiveThreadId,
    setModel,
    setProvider,
    setThreadRuns,
    setUiError,
    startRun,
    stopSubmitting,
    syncUrl,
  ])

  return { handleInterruptRun, handleRespondDecision, handleSubmit, submitMessage }
}
