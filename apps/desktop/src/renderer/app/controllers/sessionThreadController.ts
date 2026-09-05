// +-------------------------------------------------------------------------
//
//   地理智能平台 - 会话线程控制器
//
//   文件:       sessionThreadController.ts
//
//   日期:       2026年06月18日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { startTransition,useCallback } from 'react'
import type { DesktopWorkspaceBootstrapSnapshot } from '../../../contracts/desktopIpc'
import {
bootstrapWorkspace,
createThread,
compactThread,
deleteThread,
forkThread,
getSession,
getThread,
getThreadHistory,
getThreadContext,
getThreadMemory,
listTrashedThreads,
listRunSummaries,
listSessionThreads,
purgeThread,
rebuildThreadMemory,
restoreThread,
updateThreadMemory,
updateThread,
} from '../../api/client'
import { useSessionStore } from '../stores/sessionStore'
import { ensureActiveThread as orchestrateActiveThread } from '../services/activeThreadOrchestrator'
import { projectTimeline } from '../../features/conversation/timelineProjector'
import { transcriptEntriesToConversationItems } from '../bootstrap'

// PostgreSQL 是 thread/run 结构化事实源；这里仅持有可重建的浏览器投影与当前选中态。
// 完整运行快照只由 run:subscribe 吸收，不再通过历史列表隐式水合。
export function useSessionThreadController() {
  const session = useSessionStore(state => state.session)
  const sessionRuns = useSessionStore(state => state.sessionRuns)
  const sessionThreads = useSessionStore(state => state.sessionThreads)
  const threadRuns = useSessionStore(state => state.threadRuns)
  const activeThreadId = useSessionStore(state => state.activeThreadId)
  const threadContext = useSessionStore(state => state.threadContext)
  const threadMemory = useSessionStore(state => state.threadMemory)
  const trashedThreads = useSessionStore(state => state.trashedThreads)
  const runHistoryCursor = useSessionStore(state => state.runHistoryCursor)
  const isRunHistoryLoading = useSessionStore(state => state.isRunHistoryLoading)
  const canonicalThreadId = useSessionStore(state => state.canonicalThreadId)
  const storedCanonicalThreadItems = useSessionStore(state => state.canonicalThreadItems)
  const applyBootstrapState = useSessionStore(state => state.applyBootstrap)
  const setSession = useSessionStore(state => state.setSession)
  const setSessionRuns = useSessionStore(state => state.setSessionRuns)
  const setSessionThreads = useSessionStore(state => state.setSessionThreads)
  const setThreadRuns = useSessionStore(state => state.setThreadRuns)
  const setActiveThreadId = useSessionStore(state => state.setActiveThreadId)
  const setThreadContext = useSessionStore(state => state.setThreadContext)
  const setThreadMemory = useSessionStore(state => state.setThreadMemory)
  const setTrashedThreads = useSessionStore(state => state.setTrashedThreads)
  const setRunHistoryState = useSessionStore(state => state.setRunHistoryState)
  const setRunHistoryLoading = useSessionStore(state => state.setRunHistoryLoading)
  const setCanonicalThreadItems = useSessionStore(state => state.setCanonicalThreadItems)
  const clearCanonicalThreadItems = useSessionStore(state => state.clearCanonicalThreadItems)
  const canonicalThreadItems = canonicalThreadId === activeThreadId ? storedCanonicalThreadItems : []

  const applyWorkspaceBootstrap = useCallback((snapshot: DesktopWorkspaceBootstrapSnapshot) => {
    startTransition(() => applyBootstrapState(snapshot))
  }, [applyBootstrapState])

  const loadWorkspaceBootstrap = useCallback(
    (sessionId?: string, workspaceId?: string) => bootstrapWorkspace(sessionId, workspaceId),
    [],
  )

  const refreshSessionHistory = useCallback(async (sessionId: string) => {
    const threads = await listSessionThreads(sessionId)
    setSessionThreads(threads ?? [])
    return { threads }
  }, [setSessionThreads])

  const refreshCanonicalThreadHistory = useCallback(async (threadId: string) => {
    const history = await getThreadHistory(threadId, null, 200)
    const projected = transcriptEntriesToConversationItems(history.entries)
    setCanonicalThreadItems(threadId, current => projectTimeline(current, projected))
    return history
  }, [setCanonicalThreadItems])

  const loadRunHistory = useCallback(async (sessionId: string, append = false) => {
    const current = useSessionStore.getState()
    if (current.isRunHistoryLoading) return null
    setRunHistoryLoading(true)
    try {
      const page = await listRunSummaries(sessionId, {
        cursor: append ? current.runHistoryCursor : null,
        limit: 20,
      })
      startTransition(() => {
        setSessionRuns(current => append
          ? [...current, ...page.items.filter(item => !current.some(existing => existing.id === item.id))]
          : page.items)
        setRunHistoryState(page.nextCursor, false)
      })
      return page
    } finally {
      if (useSessionStore.getState().isRunHistoryLoading) setRunHistoryLoading(false)
    }
  }, [setRunHistoryLoading, setRunHistoryState, setSessionRuns])

  const ensureActiveThread = useCallback(async (
    currentThreadId: string | null | undefined,
    syncUrl: (sessionId: string, runId?: string, threadId?: string) => void,
    title: string,
  ) => {
    return orchestrateActiveThread({
      currentThreadId,
      sessionId: session?.id,
      title,
    }, {
      createThread,
      activateThread: thread => setActiveThreadId(thread.id),
      addThreadToHistory: thread => setSessionThreads(current => (
        current.some(item => item.id === thread.id) ? current : [thread, ...current]
      )),
      syncLocation: (sessionId, threadId) => syncUrl(sessionId, undefined, threadId),
    })
  }, [session, setActiveThreadId, setSessionThreads])

  const renameThread = useCallback(async (threadId: string, title: string) => {
    const updated = await updateThread(threadId, title)
    setSessionThreads(current => current.map(item => item.id === threadId ? updated : item))
    return updated
  }, [setSessionThreads])

  const removeThread = useCallback(async (threadId: string) => {
    if (!session) return null
    await deleteThread(threadId)
    const sessionRecord = await getSession(session.id)
    await refreshSessionHistory(session.id)
    setSession(sessionRecord)
    setSessionRuns(current => current.filter(run => run.threadId !== threadId))
    return sessionRecord
  }, [refreshSessionHistory, session, setSession, setSessionRuns])

  const loadThreadContextState = useCallback(async (threadId: string) => {
    const [context, memory] = await Promise.all([
      getThreadContext(threadId),
      getThreadMemory(threadId),
    ])
    startTransition(() => {
      setThreadContext(context)
      setThreadMemory(memory)
    })
    return { context, memory }
  }, [setThreadContext, setThreadMemory])

  const compactCurrentThread = useCallback(async (threadId: string) => {
    const result = await compactThread(threadId)
    await loadThreadContextState(threadId)
    return result
  }, [loadThreadContextState])

  const saveThreadMemory = useCallback(async (threadId: string, content: string) => {
    const current = threadMemory?.threadId === threadId ? threadMemory : await getThreadMemory(threadId)
    const updated = await updateThreadMemory(threadId, content, current.version)
    setThreadMemory(updated)
    return updated
  }, [setThreadMemory, threadMemory])

  const rebuildCurrentThreadMemory = useCallback(async (threadId: string) => {
    const updated = await rebuildThreadMemory(threadId)
    setThreadMemory(updated)
    await loadThreadContextState(threadId)
    return updated
  }, [loadThreadContextState, setThreadMemory])

  const forkFromMessage = useCallback(async (threadId: string, entryId: string) => {
    const forked = await forkThread(threadId, entryId)
    setSessionThreads(current => [forked, ...current.filter(thread => thread.id !== forked.id)])
    setActiveThreadId(forked.id)
    return forked
  }, [setActiveThreadId, setSessionThreads])

  const refreshTrash = useCallback(async () => {
    if (!session) return []
    const entries = await listTrashedThreads(session.id)
    setTrashedThreads(entries)
    return entries
  }, [session, setTrashedThreads])

  const restoreTrashedThread = useCallback(async (threadId: string) => {
    const restored = await restoreThread(threadId)
    await Promise.all([refreshSessionHistory(restored.sessionId), refreshTrash()])
    return restored
  }, [refreshSessionHistory, refreshTrash])

  const purgeTrashedThread = useCallback(async (threadId: string) => {
    await purgeThread(threadId)
    await refreshTrash()
  }, [refreshTrash])

  return {
    activeThreadId,
    canonicalThreadItems,
    clearCanonicalThreadItems,
    compactCurrentThread,
    ensureActiveThread,
    getThread,
    getThreadHistory,
    forkFromMessage,
    hasMoreRunHistory: Boolean(runHistoryCursor),
    isRunHistoryLoading,
    loadRunHistory,
    applyWorkspaceBootstrap,
    loadWorkspaceBootstrap,
    refreshSessionHistory,
    refreshCanonicalThreadHistory,
    loadThreadContextState,
    purgeTrashedThread,
    rebuildCurrentThreadMemory,
    refreshTrash,
    restoreTrashedThread,
    removeThread,
    renameThread,
    session,
    sessionRuns,
    sessionThreads,
    setActiveThreadId,
    setCanonicalThreadItems,
    setSession,
    setSessionThreads,
    setThreadRuns,
    saveThreadMemory,
    threadContext,
    threadMemory,
    threadRuns,
    trashedThreads,
  }
}
