// +-------------------------------------------------------------------------
//
//   地理智能平台 - 会话与线程状态 Store
//
//   文件:       sessionStore.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type {
  AgentThreadRecord,
  AnalysisRun,
  ContextAssemblyReport,
  ConversationItem,
  RunSummary,
  SessionRecord,
  ThreadMemoryDocument,
} from '@geo-agent-platform/shared-types'
import type { DesktopWorkspaceBootstrapSnapshot } from '../../../contracts/desktopIpc'
import { create } from 'zustand'

export interface TrashedThreadEntry {
  thread: AgentThreadRecord
  deletedAt: string
  purgeAfter: string
}

type StateUpdater<T> = T | ((current: T) => T)

interface SessionState {
  session?: SessionRecord
  sessionRuns: RunSummary[]
  sessionThreads: AgentThreadRecord[]
  threadRuns: AnalysisRun[]
  activeThreadId?: string
  threadContext?: ContextAssemblyReport
  threadMemory?: ThreadMemoryDocument
  trashedThreads: TrashedThreadEntry[]
  runHistoryCursor: string | null
  isRunHistoryLoading: boolean
  canonicalThreadId?: string
  canonicalThreadItems: ConversationItem[]
  applyBootstrap: (snapshot: DesktopWorkspaceBootstrapSnapshot) => void
  setSession: (session?: SessionRecord) => void
  setSessionRuns: (value: StateUpdater<RunSummary[]>) => void
  setSessionThreads: (value: StateUpdater<AgentThreadRecord[]>) => void
  setThreadRuns: (value: StateUpdater<AnalysisRun[]>) => void
  setActiveThreadId: (activeThreadId?: string) => void
  setThreadContext: (threadContext?: ContextAssemblyReport) => void
  setThreadMemory: (threadMemory?: ThreadMemoryDocument) => void
  setTrashedThreads: (trashedThreads: TrashedThreadEntry[]) => void
  setRunHistoryState: (cursor: string | null, loading: boolean) => void
  setRunHistoryLoading: (loading: boolean) => void
  setCanonicalThreadItems: (threadId: string, value: StateUpdater<ConversationItem[]>) => void
  clearCanonicalThreadItems: () => void
  resetSessionState: () => void
}

const initialSessionState = {
  session: undefined,
  sessionRuns: [] as RunSummary[],
  sessionThreads: [] as AgentThreadRecord[],
  threadRuns: [] as AnalysisRun[],
  activeThreadId: undefined,
  threadContext: undefined,
  threadMemory: undefined,
  trashedThreads: [] as TrashedThreadEntry[],
  runHistoryCursor: null,
  isRunHistoryLoading: false,
  canonicalThreadId: undefined,
  canonicalThreadItems: [] as ConversationItem[],
}

function resolveUpdater<T>(current: T, value: StateUpdater<T>): T {
  return typeof value === 'function'
    ? (value as (current: T) => T)(current)
    : value
}

export const useSessionStore = create<SessionState>((set) => ({
  ...initialSessionState,
  applyBootstrap: snapshot => set({
    session: snapshot.session,
    sessionThreads: snapshot.threads,
  }),
  setSession: session => set({ session }),
  setSessionRuns: value => set(state => ({ sessionRuns: resolveUpdater(state.sessionRuns, value) })),
  setSessionThreads: value => set(state => ({ sessionThreads: resolveUpdater(state.sessionThreads, value) })),
  setThreadRuns: value => set(state => ({ threadRuns: resolveUpdater(state.threadRuns, value) })),
  setActiveThreadId: activeThreadId => set({ activeThreadId }),
  setThreadContext: threadContext => set({ threadContext }),
  setThreadMemory: threadMemory => set({ threadMemory }),
  setTrashedThreads: trashedThreads => set({ trashedThreads }),
  setRunHistoryState: (runHistoryCursor, isRunHistoryLoading) => set({
    runHistoryCursor,
    isRunHistoryLoading,
  }),
  setRunHistoryLoading: isRunHistoryLoading => set({ isRunHistoryLoading }),
  setCanonicalThreadItems: (threadId, value) => set(state => {
    if (state.activeThreadId && state.activeThreadId !== threadId) return state
    return {
      canonicalThreadId: threadId,
      canonicalThreadItems: resolveUpdater(
        state.canonicalThreadId === threadId ? state.canonicalThreadItems : [],
        value,
      ),
    }
  }),
  clearCanonicalThreadItems: () => set({
    canonicalThreadId: undefined,
    canonicalThreadItems: [],
  }),
  resetSessionState: () => set(initialSessionState),
}))
