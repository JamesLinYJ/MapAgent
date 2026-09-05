// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工作台检查器详情
//
//   文件:       workspaceInspectorDetails.ts
//
//   说明:
//   AppShell 只负责组合控制器；本模块负责把资源、运行和导航状态整理为
//   DetailPanel 的判别联合。这里不读 Store、不发请求，也不持有 React 状态。
// --------------------------------------------------------------------------

import type {
  AnalysisRun,
  ArtifactRef,
  AgentState,
  ConversationItem,
  LayerDescriptor,
  ModelProviderDescriptor,
  RunEvent,
  RunSummary,
  SystemComponentsStatus,
} from '@geo-agent-platform/shared-types'
import type { DesktopFileSelectionHandle } from '../../contracts/desktopIpc'
import type { FileEntry } from '../api/client'
import type { WorkspaceInspectorDetail } from './layout/WorkspaceInspectorPanel'
import type { PanelMode } from './types'
import type { useWorkspaceResources } from './controllers/workspaceResourceComposition'

type WorkspaceResourceState = ReturnType<typeof useWorkspaceResources>
type LayerManagerState = WorkspaceResourceState['layerManager']
type SummaryDetail = Extract<WorkspaceInspectorDetail, { panelMode: 'summary' }>
type LayersDetail = Extract<WorkspaceInspectorDetail, { panelMode: 'layers' }>
type HistoryDetail = Extract<WorkspaceInspectorDetail, { panelMode: 'history' }>
type LayerManagerDetail = Extract<WorkspaceInspectorDetail, { panelMode: 'layerManager' }>
type PanelModeDetail = WorkspaceInspectorDetail['panelMode']

export interface WorkspaceInspectorDetailsInput {
  runStatus?: AnalysisRun['status']
  panelMode: PanelMode
  agentState?: AgentState
  items: ConversationItem[]
  artifacts: ArtifactRef[]
  artifactData: SummaryDetail['artifactData']
  mapLayers: SummaryDetail['mapLayers']
  layers: LayerDescriptor[]
  selectedArtifactId?: string
  onSelectArtifact: SummaryDetail['onSelectArtifact']
  onDownloadArtifact: SummaryDetail['onDownloadArtifact']
  onExportResults: SummaryDetail['onExportResults']
  onToggleArtifactVisibility: LayersDetail['onToggleArtifactVisibility']
  onChangeArtifactOpacity: LayersDetail['onChangeArtifactOpacity']
  currentRunId?: string
  events: RunEvent[]
  sessionRuns: RunSummary[]
  hasMoreHistory: boolean
  isHistoryLoading: boolean
  progressItems: HistoryDetail['progressItems']
  onSelectHistoryRun: HistoryDetail['onSelectHistoryRun']
  onLoadMoreHistory: HistoryDetail['onLoadMoreHistory']
  allFiles?: FileEntry[]
  onUploadFile: (file: DesktopFileSelectionHandle) => Promise<void>
  onDeleteFile: (fileId: string) => Promise<void>
  provider: string
  model: string
  providers: ModelProviderDescriptor[]
  systemComponents?: SystemComponentsStatus
  onProviderChange: (value: string) => void
  onModelChange: (value: string) => void
  isToolSubmitting: boolean
  layerManager: LayerManagerState
  onLayerZoomTo: LayerManagerDetail['onZoomToLayer']
  onExportLayer: LayerManagerDetail['onExportLayer']
  onImportManagedLayer: (file: DesktopFileSelectionHandle) => Promise<void>
  onReplaceManagedLayer: (layerKey: string, file: DesktopFileSelectionHandle) => Promise<void>
  onToggleReferenceLayerStatus: (layerKey: string, nextStatus: string) => Promise<void>
  onDeleteReferenceLayer: (layerKey: string) => Promise<void>
  refreshReferenceLayers: WorkspaceResourceState['refreshLayers']
  sessionId?: string | null
  threadId?: string | null
  setPanelMode: (mode: PanelMode) => void
}

function createLayerManagerDetail(
  input: WorkspaceInspectorDetailsInput,
  closeable: boolean,
): LayerManagerDetail {
  const { layerManager } = input
  return {
    panelMode: 'layerManager',
    runStatus: input.runStatus,
    tree: layerManager.tree,
    selectedId: layerManager.selectedId,
    searchQuery: layerManager.searchQuery,
    totalCount: layerManager.totalCount,
    visibleCount: layerManager.visibleCount,
    selectedNode: layerManager.selectedNode,
    activeView: layerManager.activeView,
    visibilityFilter: layerManager.visibilityFilter,
    referenceLayers: input.layers,
    errorMessage: layerManager.operationError,
    onSelectLayer: layerManager.selectLayer,
    onToggleVisibility: layerManager.toggleVisibility,
    onToggleAllVisibility: layerManager.toggleAllVisibility,
    onSetOpacity: layerManager.setOpacity,
    onSetColor: layerManager.setColor,
    onRenameLayer: layerManager.renameLayer,
    onMoveUp: layerManager.moveUp,
    onMoveDown: layerManager.moveDown,
    onMoveLayer: layerManager.moveTo,
    onRemoveLayer: layerManager.removeLayer,
    onCreateGroup: layerManager.createGroup,
    onToggleGroup: layerManager.toggleGroup,
    onSetSearchQuery: layerManager.setSearchQuery,
    onZoomToLayer: input.onLayerZoomTo,
    onExportLayer: input.onExportLayer,
    onSetActiveView: layerManager.setActiveView,
    onSetVisibilityFilter: layerManager.setVisibilityFilter,
    onSetLabelEnabled: layerManager.setLabelEnabled,
    onSetLabelField: layerManager.setLabelField,
    onImportManagedLayer: file => { void input.onImportManagedLayer(file) },
    onReplaceManagedLayer: (layerKey, file) => { void input.onReplaceManagedLayer(layerKey, file) },
    onToggleReferenceLayerStatus: (layerKey, nextStatus) => {
      void input.onToggleReferenceLayerStatus(layerKey, nextStatus)
    },
    onDeleteReferenceLayer: layerKey => { void input.onDeleteReferenceLayer(layerKey) },
    onRefreshReferenceLayers: () => {
      void input.refreshReferenceLayers(input.sessionId, input.threadId)
    },
    sceneManagedLayerKeys: layerManager.sceneManagedLayerKeys,
    onAddReferenceLayer: layerManager.addReferenceLayer,
    onRemoveReferenceLayer: layerManager.removeReferenceLayer,
    onClose: closeable ? () => input.setPanelMode('summary') : undefined,
  }
}

export function createWorkspaceShellInspectorDetails(
  input: WorkspaceInspectorDetailsInput,
): {
  inspectorDetails: WorkspaceInspectorDetail
  contentsDetails: LayerManagerDetail
} {
  return {
    inspectorDetails: createWorkspaceInspectorDetail(input),
    contentsDetails: createLayerManagerDetail(input, false),
  }
}

function createWorkspaceInspectorDetail(
  input: WorkspaceInspectorDetailsInput,
): WorkspaceInspectorDetail {
  const common = { runStatus: input.runStatus }

  switch (input.panelMode as PanelModeDetail) {
    case 'summary':
      return {
        ...common,
        panelMode: 'summary',
        agentState: input.agentState,
        items: input.items,
        artifacts: input.artifacts,
        artifactData: input.artifactData,
        mapLayers: input.mapLayers,
        layers: input.layers,
        selectedArtifactId: input.selectedArtifactId,
        onSelectArtifact: input.onSelectArtifact,
        onDownloadArtifact: input.onDownloadArtifact,
        onExportResults: input.onExportResults,
      }
    case 'layers':
      return {
        ...common,
        panelMode: 'layers',
        artifacts: input.artifacts,
        artifactData: input.artifactData,
        mapLayers: input.mapLayers,
        layers: input.layers,
        selectedArtifactId: input.selectedArtifactId,
        onSelectArtifact: input.onSelectArtifact,
        onToggleArtifactVisibility: input.onToggleArtifactVisibility,
        onChangeArtifactOpacity: input.onChangeArtifactOpacity,
      }
    case 'history':
      return {
        ...common,
        panelMode: 'history',
        currentRunId: input.currentRunId,
        agentState: input.agentState,
        events: input.events,
        sessionRuns: input.sessionRuns,
        hasMoreHistory: input.hasMoreHistory,
        isHistoryLoading: input.isHistoryLoading,
        progressItems: input.progressItems,
        onSelectHistoryRun: input.onSelectHistoryRun,
        onLoadMoreHistory: input.onLoadMoreHistory,
      }
    case 'compute':
      return {
        ...common,
        panelMode: 'compute',
        artifacts: input.artifacts,
        artifactData: input.artifactData,
        mapLayers: input.mapLayers,
        selectedArtifactId: input.selectedArtifactId,
        isToolSubmitting: input.isToolSubmitting,
        onSelectArtifact: input.onSelectArtifact,
        onToggleArtifactVisibility: input.onToggleArtifactVisibility,
        onExportResults: input.onExportResults,
      }
    case 'sources':
      return {
        ...common,
        panelMode: 'sources',
        allFiles: input.allFiles,
        onUploadFile: file => { void input.onUploadFile(file) },
        onDeleteFile: fileId => { void input.onDeleteFile(fileId) },
      }
    case 'export':
      return {
        ...common,
        panelMode: 'export',
        artifacts: input.artifacts,
        selectedArtifactId: input.selectedArtifactId,
        onDownloadArtifact: input.onDownloadArtifact,
        onExportResults: input.onExportResults,
      }
    case 'config':
      return {
        ...common,
        panelMode: 'config',
        provider: input.provider,
        model: input.model,
        providers: input.providers,
        systemComponents: input.systemComponents,
        onProviderChange: input.onProviderChange,
        onModelChange: input.onModelChange,
      }
    case 'layerManager':
      return createLayerManagerDetail(input, true)
    case 'tools':
      return { ...common, panelMode: 'tools' }
  }
}
