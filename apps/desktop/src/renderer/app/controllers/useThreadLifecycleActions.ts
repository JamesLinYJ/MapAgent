// +-------------------------------------------------------------------------
//
//   地理智能平台 - Thread 生命周期动作
//
//   文件:       useThreadLifecycleActions.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { useCallback } from 'react'
import type {
  AgentThreadRecord,
  AnalysisRun,
  ConversationItem,
  SessionRecord,
  ThreadDetailSnapshot,
  ThreadHistoryPage,
} from '@geo-agent-platform/shared-types'

import { formatUiError, transcriptEntriesToConversationItems } from '../bootstrap'
import type { PanelMode, PrimaryNav, SidebarItemId } from '../types'
import type { RunHydrationCapability } from './useWorkspaceRunProjection'

type ListUpdater<T> = T[] | ((current: T[]) => T[])

export interface ThreadLifecycleOptions extends RunHydrationCapability {
  session?: SessionRecord
  currentThreadId?: string | null
  clearActiveRunState: () => void
  clearUploads: () => void
  focusQueryInput: () => void
  forkFromMessage: (threadId: string, entryId: string) => Promise<AgentThreadRecord>
  getThread: (threadId: string) => Promise<ThreadDetailSnapshot>
  getThreadHistory: (threadId: string, cursor?: string | null, limit?: number) => Promise<ThreadHistoryPage>
  hasMoreRunHistory: boolean
  isRunHistoryLoading: boolean
  loadRunHistory: (sessionId: string, append?: boolean) => Promise<unknown>
  purgeTrashedThread: (threadId: string) => Promise<void>
  refreshMemoryEntries: () => Promise<unknown>
  refreshTrash: () => Promise<unknown>
  removeThread: (threadId: string) => Promise<SessionRecord | null>
  renameThread: (threadId: string, title: string) => Promise<AgentThreadRecord>
  restoreTrashedThread: (threadId: string) => Promise<AgentThreadRecord>
  setActiveNav: (nav: PrimaryNav) => void
  setActiveSidebarItem: (item: SidebarItemId) => void
  setActiveThreadId: (threadId?: string) => void
  setCanonicalThreadItems: (threadId: string, value: ListUpdater<ConversationItem>) => void
  setPanelMode: (mode: PanelMode) => void
  setQuery: (query: string) => void
  setThreadRuns: (value: ListUpdater<AnalysisRun>) => void
  setUiError: (message?: string) => void
  syncUrl: (sessionId: string, runId?: string, threadId?: string) => void
}

export function useThreadLifecycleActions(options: ThreadLifecycleOptions) {
  const {
    session,
    abortRunSelection,
    beginRunSelection,
    currentThreadId,
    clearActiveRunState,
    clearUploads,
    focusQueryInput,
    forkFromMessage,
    getThread,
    getThreadHistory,
    hasMoreRunHistory,
    hydrateRunState,
    isRunSelectionCurrent,
    isRunHistoryLoading,
    loadRunHistory,
    purgeTrashedThread,
    refreshMemoryEntries,
    refreshTrash,
    removeThread,
    renameThread,
    restoreTrashedThread,
    setActiveNav,
    setActiveSidebarItem,
    setActiveThreadId,
    setCanonicalThreadItems,
    setPanelMode,
    setQuery,
    setThreadRuns,
    setUiError,
    syncUrl,
  } = options
  const sessionId = session?.id

  const handleNewConversation = useCallback(() => {
    setQuery('')
    clearActiveRunState()
    clearUploads()
    setActiveNav('analysis')
    setPanelMode('summary')
    setActiveSidebarItem('assistant')
    if (sessionId) syncUrl(sessionId)
    focusQueryInput()
  }, [
    clearActiveRunState,
    clearUploads,
    focusQueryInput,
    sessionId,
    setActiveNav,
    setActiveSidebarItem,
    setPanelMode,
    setQuery,
    syncUrl,
  ])

  const handleSelectThread = useCallback(async (threadId: string) => {
    const selection = beginRunSelection()
    try {
      setUiError(undefined)
      const [threadPayload, historyPage] = await Promise.all([
        getThread(threadId),
        getThreadHistory(threadId, null, 200),
      ])
      if (!isRunSelectionCurrent(selection)) return
      const canonicalItems = transcriptEntriesToConversationItems(historyPage.entries)
      const latestRunId = threadPayload.thread.latestRunId
      if (latestRunId) {
        const hydration = await hydrateRunState(latestRunId, selection)
        if (hydration.status === 'superseded' || !isRunSelectionCurrent(selection)) return
        setActiveThreadId(threadPayload.thread.id)
        setThreadRuns([hydration.run])
        setCanonicalThreadItems(threadPayload.thread.id, canonicalItems)
        if (sessionId) {
          syncUrl(sessionId, latestRunId, threadPayload.thread.id)
        }
        return
      }
      clearActiveRunState()
      setActiveThreadId(threadPayload.thread.id)
      setCanonicalThreadItems(threadPayload.thread.id, canonicalItems)
      if (sessionId) syncUrl(sessionId, undefined, threadPayload.thread.id)
    } catch (error) {
      if (!isRunSelectionCurrent(selection)) return
      abortRunSelection(selection)
      setUiError(formatUiError(error, '历史记录加载失败，请稍后重试。'))
    }
  }, [
    clearActiveRunState,
    abortRunSelection,
    beginRunSelection,
    getThread,
    getThreadHistory,
    hydrateRunState,
    isRunSelectionCurrent,
    sessionId,
    setActiveThreadId,
    setCanonicalThreadItems,
    setThreadRuns,
    setUiError,
    syncUrl,
  ])

  const handleRenameThread = useCallback(async (threadId: string, title: string) => {
    const nextTitle = title.trim()
    if (!nextTitle) {
      setUiError('任务标题不能为空。')
      return
    }
    try {
      setUiError(undefined)
      await renameThread(threadId, nextTitle)
    } catch (error) {
      setUiError(formatUiError(error, '标题更新失败，请再试一次。'))
    }
  }, [renameThread, setUiError])

  const handleDeleteThread = useCallback(async (threadId: string) => {
    if (!sessionId) return
    try {
      setUiError(undefined)
      await removeThread(threadId)
      if (currentThreadId === threadId) {
        clearActiveRunState()
        syncUrl(sessionId)
      }
    } catch (error) {
      setUiError(formatUiError(error, '任务删除失败，请再试一次。'))
    }
  }, [clearActiveRunState, currentThreadId, removeThread, sessionId, setUiError, syncUrl])

  const handleRefreshMemories = useCallback(async () => {
    try {
      setUiError(undefined)
      await refreshMemoryEntries()
    } catch (error) {
      setUiError(formatUiError(error, '记忆索引刷新失败。'))
    }
  }, [refreshMemoryEntries, setUiError])

  const handleForkMessage = useCallback(async (entryId: string) => {
    if (!currentThreadId || !sessionId) return
    try {
      setUiError(undefined)
      const forked = await forkFromMessage(currentThreadId, entryId)
      const history = await getThreadHistory(forked.id, null, 200)
      clearActiveRunState()
      setActiveThreadId(forked.id)
      setThreadRuns([])
      setCanonicalThreadItems(forked.id, transcriptEntriesToConversationItems(history.entries))
      syncUrl(sessionId, undefined, forked.id)
    } catch (error) {
      setUiError(formatUiError(error, '消息分支创建失败。'))
    }
  }, [
    clearActiveRunState,
    currentThreadId,
    forkFromMessage,
    getThreadHistory,
    sessionId,
    setActiveThreadId,
    setCanonicalThreadItems,
    setThreadRuns,
    setUiError,
    syncUrl,
  ])

  const handleRestoreThread = useCallback(async (threadId: string) => {
    try {
      await restoreTrashedThread(threadId)
    } catch (error) {
      setUiError(formatUiError(error, '线程恢复失败。'))
    }
  }, [restoreTrashedThread, setUiError])

  const handlePurgeThread = useCallback(async (threadId: string) => {
    try {
      await purgeTrashedThread(threadId)
    } catch (error) {
      setUiError(formatUiError(error, '线程永久删除失败。'))
    }
  }, [purgeTrashedThread, setUiError])

  const handleLoadMoreHistory = useCallback(() => {
    if (!sessionId || !hasMoreRunHistory || isRunHistoryLoading) return
    void loadRunHistory(sessionId, true).catch(error => {
      setUiError(formatUiError(error, '更多运行历史加载失败。'))
    })
  }, [hasMoreRunHistory, isRunHistoryLoading, loadRunHistory, sessionId, setUiError])

  const handleRefreshTrash = useCallback(async () => {
    await refreshTrash()
  }, [refreshTrash])

  return {
    handleDeleteThread,
    handleForkMessage,
    handleLoadMoreHistory,
    handleNewConversation,
    handlePurgeThread,
    handleRefreshMemories,
    handleRefreshTrash,
    handleRenameThread,
    handleRestoreThread,
    handleSelectThread,
  }
}
