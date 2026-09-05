// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工作区资源加载协调器
//
//   文件:       useWorkspaceResourceLoader.ts
//
//   日期:       2026年07月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { useEffect } from 'react'

import { reportNonBlockingError } from '../bootstrap'

interface WorkspaceResourceLoaderOptions {
  enabled: boolean
  sessionId?: string
  threadId?: string
  loadBasemaps: () => Promise<unknown>
  refreshLayers: (sessionId?: string, threadId?: string) => Promise<unknown>
}

export async function loadWorkspaceResources(
  sessionId: string,
  threadId: string | undefined,
  loadBasemaps: () => Promise<unknown>,
  refreshLayers: (sessionId?: string, threadId?: string) => Promise<unknown>,
): Promise<void> {
  await Promise.all([
    loadBasemaps(),
    refreshLayers(sessionId, threadId),
  ])
}

export function useWorkspaceResourceLoader({
  enabled,
  sessionId,
  threadId,
  loadBasemaps,
  refreshLayers,
}: WorkspaceResourceLoaderOptions): void {
  useEffect(() => {
    if (!enabled || !sessionId) return
    void loadWorkspaceResources(sessionId, threadId, loadBasemaps, refreshLayers).catch(error => {
      reportNonBlockingError('workspaceResources', error)
    })
  }, [
    enabled,
    loadBasemaps,
    refreshLayers,
    sessionId,
    threadId,
  ])
}
