// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工作区 Run 投影协调器
//
//   文件:       useWorkspaceRunProjection.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { startTransition, useCallback } from 'react'
import type { AnalysisRun } from '@geo-agent-platform/shared-types'

import { pickPreferredArtifactId } from '../../features/artifacts/artifactSelection'
import type {
  RunHydrationResult,
  RunSelectionCapability,
  RunSelectionToken,
} from '../../features/runs/useRunState'
import { mergeThreadRuns } from '../derivedState'

type ListUpdater<T> = T[] | ((current: T[]) => T[])

export interface RunHydrationCapability {
  abortRunSelection: RunSelectionCapability['abortRunSelection']
  beginRunSelection: RunSelectionCapability['beginRunSelection']
  hydrateRunState: (
    runId: string,
    selection?: RunSelectionToken,
  ) => Promise<RunHydrationResult>
  isRunSelectionCurrent: RunSelectionCapability['isRunSelectionCurrent']
}

export interface WorkspaceRunProjectionOptions extends RunSelectionCapability {
  clearArtifacts: () => void
  clearCanonicalThreadItems: () => void
  clearRun: () => void
  hydrateRun: (runId: string, selection?: RunSelectionToken) => Promise<RunHydrationResult>
  setActiveThreadId: (threadId?: string) => void
  setModel: (model: string) => void
  setProvider: (provider: string) => void
  setSelectedArtifactId: (artifactId?: string) => void
  setThreadRuns: (value: ListUpdater<AnalysisRun>) => void
  setToolRunResult: (result: Record<string, unknown> | null) => void
  syncUrl: (sessionId: string, runId?: string, threadId?: string) => void
}

export function useWorkspaceRunProjection({
  abortRunSelection,
  clearArtifacts,
  clearCanonicalThreadItems,
  clearRun,
  beginRunSelection,
  captureRunSelection,
  hydrateRun,
  isRunSelectionCurrent,
  setActiveThreadId,
  setModel,
  setProvider,
  setSelectedArtifactId,
  setThreadRuns,
  setToolRunResult,
  syncUrl,
}: WorkspaceRunProjectionOptions) {
  const clearActiveRunState = useCallback(() => {
    clearRun()
    clearArtifacts()
    clearCanonicalThreadItems()
    setThreadRuns([])
    setToolRunResult(null)
    setActiveThreadId(undefined)
  }, [
    clearArtifacts,
    clearCanonicalThreadItems,
    clearRun,
    setActiveThreadId,
    setThreadRuns,
    setToolRunResult,
  ])

  const hydrateRunState = useCallback(async (
    runId: string,
    selection?: RunSelectionToken,
  ) => {
    const effectiveSelection = selection ?? beginRunSelection()
    if (!isRunSelectionCurrent(effectiveSelection)) {
      return { status: 'superseded' } as const
    }
    const hydration = await hydrateRun(runId, effectiveSelection)
    if (hydration.status === 'superseded') return hydration
    if (!isRunSelectionCurrent(effectiveSelection)) {
      return { status: 'superseded' } as const
    }
    const latestRun = hydration.run
    startTransition(() => {
      setActiveThreadId(latestRun.threadId ?? undefined)
      setProvider(latestRun.modelProvider ?? 'deepseek')
      setModel(latestRun.modelName ?? '')
      setSelectedArtifactId(pickPreferredArtifactId(latestRun.state.artifacts))
      setThreadRuns(current => mergeThreadRuns(current, latestRun))
    })
    syncUrl(latestRun.sessionId, latestRun.id, latestRun.threadId ?? undefined)
    return hydration
  }, [
    beginRunSelection,
    hydrateRun,
    isRunSelectionCurrent,
    setActiveThreadId,
    setModel,
    setProvider,
    setSelectedArtifactId,
    setThreadRuns,
    syncUrl,
  ])

  return {
    abortRunSelection,
    beginRunSelection,
    captureRunSelection,
    clearActiveRunState,
    hydrateRunState,
    isRunSelectionCurrent,
  }
}
