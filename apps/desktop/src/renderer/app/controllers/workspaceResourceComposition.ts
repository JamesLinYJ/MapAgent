// +-------------------------------------------------------------------------
//
//   地理智能平台 - 资源控制器组合门面
//
//   文件:       workspaceResourceComposition.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type {
  AnalysisRun,
  ArtifactRef,
  SessionRecord,
} from '@geo-agent-platform/shared-types'
import { useArtifactResources } from './resources/useArtifactResources'
import { useBasemapResources } from './resources/useBasemapResources'
import { useManagedLayerResources } from './resources/useManagedLayerResources'
import { useMapResources } from './resources/useMapResources'
import { useUploadResources } from './resources/useUploadResources'

interface WorkspaceResourceOptions {
  artifacts: ArtifactRef[]
  currentThreadId?: string | null
  ensureActiveThread: (title: string) => Promise<string>
  layerPreferenceKey?: string
  onSessionRecord: (session: SessionRecord) => void
  onShowSources: () => void
  runStatus?: AnalysisRun['status']
  session?: SessionRecord
  setUiError: (error?: string) => void
}

/**
 * 工作台资源组合门面。
 *
 * 各资源域独立拥有自己的查询、命令和浏览器投影；本 Hook 只维持
 * AppShell 的稳定接线接口，不参与任何资源生命周期。
 */
export function useWorkspaceResources({
  artifacts,
  currentThreadId,
  ensureActiveThread,
  layerPreferenceKey,
  onSessionRecord,
  onShowSources,
  runStatus,
  session,
  setUiError,
}: WorkspaceResourceOptions) {
  const managedLayers = useManagedLayerResources({ onShowSources, setUiError })
  const basemaps = useBasemapResources()
  const artifactResources = useArtifactResources({ artifacts, currentThreadId, runStatus })
  const uploads = useUploadResources({
    currentThreadId,
    ensureActiveThread,
    onSessionRecord,
    onShowSources,
    refreshLayers: managedLayers.refreshLayers,
    session,
    setUiError,
  })
  const mapResources = useMapResources({
    artifacts,
    artifactCount: artifacts.length,
    currentThreadId,
    ensureActiveThread,
    layerPreferenceKey,
    referenceLayers: managedLayers.layers,
    setUiError,
  })

  return {
    ...artifactResources,
    ...basemaps,
    ...managedLayers,
    ...mapResources,
    ...uploads,
  }
}
