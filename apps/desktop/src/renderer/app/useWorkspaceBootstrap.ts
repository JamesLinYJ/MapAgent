// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工作区启动控制器
//
//   文件:       useWorkspaceBootstrap.ts
//
//   日期:       2026年07月06日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

// 模块职责
//
// 负责首屏认证、workspace bootstrap、窗口指针校验和 run/thread 恢复。
// AppShell 只消费认证结果，不直接编排启动阶段的请求瀑布。

import { useCallback, useEffect, useState } from 'react'
import type {
  ConversationItem,
  ThreadHistoryPage,
} from '@geo-agent-platform/shared-types'
import type {
  DesktopAuthBootstrapResult,
  DesktopWorkspaceBootstrapSnapshot,
} from '../../contracts/desktopIpc'

import { getAuthProjection } from '../api/client'
import { bootstrapDesktopAuth } from '../api/authClient'
import { formatUiError, transcriptEntriesToConversationItems } from './bootstrap'
import type { RunHydrationCapability } from './controllers/useWorkspaceRunProjection'
import { useAuthStore, type AuthStatus } from './stores/authStore'

export type { AuthStatus }
export type DesktopAuthMode = DesktopAuthBootstrapResult['mode'] | 'unknown'

export interface WorkspaceBootstrapPointer {
  activeWorkspaceId?: string
  activeSessionId?: string
  activeThreadId?: string
  activeRunId?: string
  sessionSource?: 'route' | 'query'
}

// 当前桌面窗口中的 workspace/session/thread/run 只是恢复指针，不是身份事实源。
// 指针不可读时保留服务端权限错误，不回退到其它工作区伪造成功。
export async function loadBootstrapFromWorkspacePointer(
  pointer: WorkspaceBootstrapPointer,
  loadWorkspaceBootstrap: (
    sessionId?: string,
    workspaceId?: string,
  ) => Promise<DesktopWorkspaceBootstrapSnapshot>,
): Promise<DesktopWorkspaceBootstrapSnapshot> {
  return loadWorkspaceBootstrap(pointer.activeSessionId, pointer.activeWorkspaceId)
}

export function useWorkspaceBootstrap({
  applyProviders,
  applyTools,
  applyWorkspaceBootstrap,
  abortRunSelection,
  beginRunSelection,
  clearActiveRunState,
  disabled = false,
  getThreadHistory,
  hydrateRunState,
  isRunSelectionCurrent,
  loadWorkspaceBootstrap,
  readWorkspacePointer,
  setActiveThreadId,
  setCanonicalThreadItems,
  setUiError,
  syncUrl,
  syncWorkspaceUrl = true,
}: RunHydrationCapability & {
  applyProviders: (providers: DesktopWorkspaceBootstrapSnapshot['providers']) => void
  applyTools: (tools: DesktopWorkspaceBootstrapSnapshot['tools']) => void
  applyWorkspaceBootstrap: (snapshot: DesktopWorkspaceBootstrapSnapshot) => void
  clearActiveRunState: () => void
  disabled?: boolean
  getThreadHistory: (threadId: string, cursor?: string | null, limit?: number) => Promise<ThreadHistoryPage>
  loadWorkspaceBootstrap: (
    sessionId?: string,
    workspaceId?: string,
  ) => Promise<DesktopWorkspaceBootstrapSnapshot>
  readWorkspacePointer: () => WorkspaceBootstrapPointer
  setActiveThreadId: (threadId: string | undefined) => void
  setCanonicalThreadItems: (threadId: string, items: ConversationItem[]) => void
  setUiError: (message: string | undefined) => void
  syncUrl: (sessionId: string, runId?: string, threadId?: string) => void
  syncWorkspaceUrl?: boolean
}) {
  const authStatus = useAuthStore(state => state.status)
  const authMe = useAuthStore(state => state.authMe)
  const clearAuthState = useAuthStore(state => state.clear)
  const setAuthenticated = useAuthStore(state => state.setAuthenticated)
  const setAuthStatus = useAuthStore(state => state.setStatus)
  const [authRefreshNonce, setAuthRefreshNonce] = useState(0)
  const [authMode, setAuthMode] = useState<DesktopAuthMode>('unknown')

  const retryAuth = useCallback(() => {
    setAuthStatus('checking')
    setAuthRefreshNonce(value => value + 1)
  }, [setAuthStatus])

  const clearAuth = useCallback(() => {
    clearAuthState()
  }, [clearAuthState])

  useEffect(() => {
    if (disabled) {
      setAuthMode('interactive')
      setAuthStatus('unauthenticated')
      return
    }
    // 首屏只吸收一次 workspace bootstrap；thread 摘要足以校验本地指针。
    // 完整运行通过 run:subscribe 一次恢复，不能再展开 thread/run 请求瀑布。
    let disposed = false
    const selection = beginRunSelection()

    void (async () => {
      try {
        const workspacePointer = readWorkspacePointer()
        const sharedThreadId = workspacePointer.activeThreadId
        const sharedRunId = workspacePointer.activeRunId
        const desktopAuth = await bootstrapDesktopAuth()
        if (disposed || !isRunSelectionCurrent(selection)) return
        setAuthMode(desktopAuth.mode)
        if (desktopAuth.status === 'failed') {
          throw new Error(desktopAuth.message ?? '本机自动认证失败。')
        }
        const auth = await getAuthProjection().catch(error => {
          const message = error instanceof Error ? error.message : String(error)
          if (message.includes('未登录') || message.includes('401')) return null
          throw error
        })
        if (!isRunSelectionCurrent(selection)) return
        if (!auth) {
          if (desktopAuth.mode === 'local_auto') {
            throw new Error('本机自动认证未建立可验证的服务端会话。')
          }
          if (!disposed) setAuthStatus('unauthenticated')
          abortRunSelection(selection)
          return
        }
        if (disposed) return
        setAuthenticated(auth)
        const snapshot = await loadBootstrapFromWorkspacePointer(workspacePointer, loadWorkspaceBootstrap)
        if (disposed || !isRunSelectionCurrent(selection)) return
        applyWorkspaceBootstrap(snapshot)
        applyProviders(snapshot.providers)
        applyTools(snapshot.tools)
        setUiError(undefined)

        const sessionRecord = snapshot.session
        // thread/run 选中提示按 session 隔离；数据库仍是归属和可访问性的事实源。
        const hintedThreadId = sharedThreadId
        const hintedRunId = sharedRunId
        const threadToRestore = hintedThreadId || undefined
        const runToRestore = hintedRunId || undefined
        const thread = threadToRestore
          ? snapshot.threads.find(item => item.id === threadToRestore)
          : undefined

        if (threadToRestore && !thread) {
          if (sharedThreadId) throw new Error('链接中的对话不属于当前会话。')
          clearActiveRunState()
          if (syncWorkspaceUrl) syncUrl(sessionRecord.id)
          return
        }

        if (thread) setActiveThreadId(thread.id)
        const preferredRunId = runToRestore ?? thread?.latestRunId ?? undefined
        if (!preferredRunId) {
          if (syncWorkspaceUrl) syncUrl(sessionRecord.id, undefined, thread?.id)
          abortRunSelection(selection)
          return
        }

        try {
          const hydration = await hydrateRunState(preferredRunId, selection)
          if (
            hydration.status === 'superseded'
            || disposed
            || !isRunSelectionCurrent(selection)
          ) return
          const restoredRun = hydration.run
          const wrongSession = restoredRun.sessionId !== sessionRecord.id
          const wrongThread = Boolean(thread && restoredRun.threadId !== thread.id)
          if (wrongSession || wrongThread) throw new Error('运行记录不属于当前会话或对话。')
          if (restoredRun.threadId) {
            const history = await getThreadHistory(restoredRun.threadId, null, 200)
            if (disposed || !isRunSelectionCurrent(selection)) return
            setCanonicalThreadItems(restoredRun.threadId, transcriptEntriesToConversationItems(history.entries))
          }
        } catch (error) {
          if (disposed || !isRunSelectionCurrent(selection)) return
          abortRunSelection(selection)
          if (sharedRunId || sharedThreadId) throw error
          clearActiveRunState()
          if (syncWorkspaceUrl) syncUrl(sessionRecord.id)
        }
      } catch (error) {
        if (!disposed && isRunSelectionCurrent(selection)) {
          abortRunSelection(selection)
          setAuthStatus('error')
          setUiError(formatUiError(error, '页面加载遇到问题，请刷新重试。'))
        }
      }
    })()

    return () => {
      disposed = true
      abortRunSelection(selection)
    }
  }, [
    abortRunSelection,
    applyProviders,
    applyTools,
    applyWorkspaceBootstrap,
    authRefreshNonce,
    beginRunSelection,
    clearActiveRunState,
    disabled,
    hydrateRunState,
    isRunSelectionCurrent,
    getThreadHistory,
    loadWorkspaceBootstrap,
    readWorkspacePointer,
    setActiveThreadId,
    setCanonicalThreadItems,
    setAuthenticated,
    setAuthStatus,
    setUiError,
    syncUrl,
    syncWorkspaceUrl,
  ])

  return { authMe, authStatus, authMode, clearAuth, retryAuth }
}
