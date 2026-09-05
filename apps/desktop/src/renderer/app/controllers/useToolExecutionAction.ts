// +-------------------------------------------------------------------------
//
//   地理智能平台 - 直接工具执行动作
//
//   文件:       useToolExecutionAction.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { useCallback, useRef } from 'react'
import type { DirectToolRunResponse, ToolDescriptor } from '@geo-agent-platform/shared-types'

import { formatUiError } from '../bootstrap'
import type { RunHydrationCapability } from './useWorkspaceRunProjection'

export interface ToolExecutionActionOptions extends RunHydrationCapability {
  sessionId?: string
  threadId?: string | null
  runId?: string
  runTool: (payload: Record<string, unknown>) => Promise<DirectToolRunResponse>
  setIsToolSubmitting: (isSubmitting: boolean) => void
  setToolRunResult: (result: Record<string, unknown> | null) => void
  setUiError: (message?: string) => void
  syncUrl: (sessionId: string, runId?: string, threadId?: string) => void
}

export function useToolExecutionAction({
  abortRunSelection,
  beginRunSelection,
  sessionId,
  threadId,
  runId,
  hydrateRunState,
  isRunSelectionCurrent,
  runTool,
  setIsToolSubmitting,
  setToolRunResult,
  setUiError,
  syncUrl,
}: ToolExecutionActionOptions) {
  const activeToolOperationRef = useRef<object | null>(null)
  return useCallback(async (tool: ToolDescriptor, args: Record<string, unknown>) => {
    if (!sessionId) return
    const selection = beginRunSelection()
    const operation = {}
    activeToolOperationRef.current = operation

    try {
      setUiError(undefined)
      setIsToolSubmitting(true)
      const response = await runTool({
        sessionId,
        threadId,
        runId,
        toolName: tool.name,
        toolKind: tool.toolKind,
        args,
      })
      if (!isRunSelectionCurrent(selection)) return
      const hydration = await hydrateRunState(response.run.id, selection)
      if (hydration.status === 'superseded' || !isRunSelectionCurrent(selection)) return
      setToolRunResult(response)
      syncUrl(sessionId, response.run.id, threadId ?? undefined)
    } catch (error) {
      if (!isRunSelectionCurrent(selection)) return
      abortRunSelection(selection)
      setUiError(formatUiError(error, `${tool.label} 执行失败。`))
    } finally {
      if (activeToolOperationRef.current === operation) {
        activeToolOperationRef.current = null
        setIsToolSubmitting(false)
      }
    }
  }, [
    abortRunSelection,
    beginRunSelection,
    hydrateRunState,
    isRunSelectionCurrent,
    runId,
    runTool,
    sessionId,
    setIsToolSubmitting,
    setToolRunResult,
    setUiError,
    syncUrl,
    threadId,
  ])
}
