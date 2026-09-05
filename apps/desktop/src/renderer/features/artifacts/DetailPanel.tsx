// +-------------------------------------------------------------------------
//
//   地理智能平台 - 详情面板组件
//
//   文件:       DetailPanel.tsx
//
//   日期:       2026年04月14日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

// 模块职责
//
// 展示当前结果对象、导出入口、运行摘要与系统状态等辅助信息。

import { memo, useMemo, type ComponentProps } from 'react'
import type {
  AgentState,
  AnalysisRun,
  ArtifactRef,
  ConversationItem,
  LayerDescriptor,
  ModelProviderDescriptor,
  RunEvent,
  RunSummary,
  SystemComponentsStatus,
} from '@geo-agent-platform/shared-types'
import type { DesktopFileSelectionHandle } from '../../../contracts/desktopIpc'

import { apiBaseUrl } from '../../api/client'
import type { FileEntry } from '../../api/client'
import { LayerPanel } from '../layers/LayerManagerPanel'
import { pickConversationHeadline } from '@geo-agent-platform/conversation-presentation'
import { buildDetailSummaryFacts } from './detailSummaryModel'
import { DetailSummaryPanel } from './DetailSummaryPanel'
import { DetailLayerOverviewPanel, type DetailMapLayer } from './DetailLayerOverviewPanel'
import { DetailHistoryPanel } from './DetailHistoryPanel'
import { DetailSourcesPanel } from './DetailSourcesPanel'
import { DetailComputePanel, DetailConfigPanel, DetailExportPanel } from './DetailActionPanels'

interface ProgressItem {
  id: string
  title: string
  description: string
  status: 'done' | 'active' | 'pending' | 'warning'
}

type PanelMode = 'summary' | 'layers' | 'history' | 'compute' | 'sources' | 'export' | 'config' | 'layerManager' | 'tools'

interface DetailPanelBase {
  panelMode: PanelMode
  runStatus?: AnalysisRun['status']
}

export interface SummaryDetailPanelProps extends DetailPanelBase {
  panelMode: 'summary'
  agentState?: AgentState
  items: ConversationItem[]
  artifacts: ArtifactRef[]
  artifactData: Record<string, GeoJSON.FeatureCollection>
  mapLayers: DetailMapLayer[]
  layers: LayerDescriptor[]
  selectedArtifactId?: string
  onSelectArtifact: (artifactId: string) => void
  onDownloadArtifact: () => void
  onExportResults: () => void
}

export interface LayerOverviewDetailPanelProps extends DetailPanelBase {
  panelMode: 'layers'
  artifacts: ArtifactRef[]
  artifactData: Record<string, GeoJSON.FeatureCollection>
  mapLayers: DetailMapLayer[]
  layers: LayerDescriptor[]
  selectedArtifactId?: string
  onSelectArtifact: (artifactId: string) => void
  onToggleArtifactVisibility: (artifactId: string) => void
  onChangeArtifactOpacity: (artifactId: string, opacity: number) => void
}

export interface HistoryDetailPanelProps extends DetailPanelBase {
  panelMode: 'history'
  currentRunId?: string
  agentState?: AgentState
  events: RunEvent[]
  sessionRuns: RunSummary[]
  hasMoreHistory?: boolean
  isHistoryLoading?: boolean
  progressItems: ReadonlyArray<ProgressItem>
  onSelectHistoryRun: (runId: string) => void
  onLoadMoreHistory?: () => void
}

export interface ComputeDetailPanelProps extends DetailPanelBase {
  panelMode: 'compute'
  artifacts: ArtifactRef[]
  artifactData: Record<string, GeoJSON.FeatureCollection>
  mapLayers: DetailMapLayer[]
  selectedArtifactId?: string
  isToolSubmitting: boolean
  onSelectArtifact: (artifactId: string) => void
  onToggleArtifactVisibility: (artifactId: string) => void
  onExportResults: () => void
}

export interface SourcesDetailPanelProps extends DetailPanelBase {
  panelMode: 'sources'
  allFiles?: FileEntry[]
  onUploadFile?: (file: DesktopFileSelectionHandle) => void
  onDeleteFile?: (fileId: string) => void
}

export interface ExportDetailPanelProps extends DetailPanelBase {
  panelMode: 'export'
  artifacts: ArtifactRef[]
  selectedArtifactId?: string
  onDownloadArtifact: () => void
  onExportResults: () => void
}

export interface ConfigDetailPanelProps extends DetailPanelBase {
  panelMode: 'config'
  provider: string
  model: string
  providers: ModelProviderDescriptor[]
  systemComponents?: SystemComponentsStatus
  onProviderChange: (value: string) => void
  onModelChange: (value: string) => void
}

export interface LayerManagerDetailPanelProps extends DetailPanelBase, ComponentProps<typeof LayerPanel> {
  panelMode: 'layerManager'
}

export interface EmptyDetailPanelProps extends DetailPanelBase {
  panelMode: 'tools'
}

export type DetailPanelProps =
  | SummaryDetailPanelProps
  | LayerOverviewDetailPanelProps
  | HistoryDetailPanelProps
  | ComputeDetailPanelProps
  | SourcesDetailPanelProps
  | ExportDetailPanelProps
  | ConfigDetailPanelProps
  | LayerManagerDetailPanelProps
  | EmptyDetailPanelProps

export const DetailPanel = memo(function DetailPanel(props: DetailPanelProps) {
  let content: React.ReactNode = null
  switch (props.panelMode) {
    case 'summary':
      content = <SummaryDetailPanel {...props} />
      break
    case 'layers':
      content = <LayerOverviewDetailPanel {...props} />
      break
    case 'history':
      content = <HistoryDetailPanel {...props} />
      break
    case 'compute':
      content = <ComputeDetailPanel {...props} />
      break
    case 'sources':
      content = (
        <DetailSourcesPanel
          allFiles={props.allFiles}
          onDeleteFile={props.onDeleteFile}
          onUploadFile={props.onUploadFile}
        />
      )
      break
    case 'layerManager': {
      const { panelMode: _panelMode, runStatus: _runStatus, ...layerProps } = props
      content = <LayerPanel {...layerProps} />
      break
    }
    case 'export': {
      const selectedArtifact = selectArtifact(props.artifacts, props.selectedArtifactId)
      content = (
        <DetailExportPanel
          selectedArtifact={selectedArtifact}
          onDownloadArtifact={props.onDownloadArtifact}
          onExportResults={props.onExportResults}
        />
      )
      break
    }
    case 'config':
      content = (
        <DetailConfigPanel
          model={props.model}
          provider={props.provider}
          providers={props.providers}
          systemComponents={props.systemComponents}
          onModelChange={props.onModelChange}
          onProviderChange={props.onProviderChange}
        />
      )
      break
    case 'tools':
      break
  }
  return (
    <div className="dc-detail-column">
      {content}
      {props.runStatus === 'failed' ? <div className="dc-error-banner">这次分析没有完成，请调整问题后重新尝试。</div> : null}
    </div>
  )
})

function SummaryDetailPanel(props: SummaryDetailPanelProps) {
  const selectedArtifact = useMemo(
    () => selectArtifact(props.artifacts, props.selectedArtifactId),
    [props.artifacts, props.selectedArtifactId],
  )
  const selectedFileUrl = selectedArtifact && selectedArtifact.artifactType !== 'geojson'
    ? `${apiBaseUrl}${typeof selectedArtifact.metadata.imageUrl === 'string' ? selectedArtifact.metadata.imageUrl : selectedArtifact.uri}`
    : null
  const selectedCollection = selectedArtifact ? props.artifactData[selectedArtifact.artifactId] : undefined
  const summaryTitle = deriveSummaryTitle(props.agentState?.parsedIntent?.area ?? undefined, selectedArtifact?.name)
  const resultFeatureCount = useMemo(
    () => props.artifacts.reduce((total, artifact) => total + (props.artifactData[artifact.artifactId]?.features.length ?? 0), 0),
    [props.artifacts, props.artifactData],
  )
  const conversationHeadline = useMemo(
    () => pickConversationHeadline(props.items, props.runStatus),
    [props.items, props.runStatus],
  )
  const summaryBody =
    (conversationHeadline.title === '回答' ? conversationHeadline.body : '') ||
    (selectedArtifact
      ? `当前结果图层“${selectedArtifact.name}”已经生成，你可以继续查看对象分布、下载数据，或复制当前工作区链接。`
      : '分析完成后，这里会用更容易理解的语言总结地图结果和可执行建议。')
  const todoItems = props.agentState?.todos ?? []
  const subAgents = props.agentState?.subAgents ?? []
  const approvals = props.agentState?.approvals ?? []
  const layerSummary = useMemo(() => buildLayerSummary(props.layers), [props.layers])
  const primaryItems = useMemo(() => props.artifacts.slice(0, 2), [props.artifacts])
  const cardLabels = useMemo(
    () => primaryItems.map(artifact => ({
      title: artifact.name,
      subtitle:
        artifact.artifactType === 'chart_png'
          ? '统计图表已生成，可直接预览或下载 PNG'
          : artifact.artifactType !== 'geojson'
            ? '文件结果已生成，可在详情面板预览或下载'
            :
        `${props.artifactData[artifact.artifactId]?.features.length ?? 0} 个对象 · ${props.mapLayers.find(layer => layer.artifact.artifactId === artifact.artifactId)?.geometrySummary ?? '矢量结果'}`,
    })),
    [primaryItems, props.artifactData, props.mapLayers],
  )
  const summaryFacts = useMemo(() => buildDetailSummaryFacts({
    runStatus: props.runStatus,
    artifactCount: props.artifacts.length,
    resultFeatureCount,
    activeReferenceLayerCount: layerSummary.active,
    totalReferenceLayerCount: layerSummary.total,
  }), [props.artifacts.length, layerSummary.active, layerSummary.total, resultFeatureCount, props.runStatus])

  return (
    <DetailSummaryPanel
      artifactData={props.artifactData}
      approvals={approvals}
      cardLabels={cardLabels}
      primaryItems={primaryItems}
      selectedArtifact={selectedArtifact}
      selectedCollection={selectedCollection}
      selectedFileUrl={selectedFileUrl}
      subAgents={subAgents}
      summaryBody={summaryBody}
      summaryFacts={summaryFacts}
      summaryTitle={summaryTitle}
      todoItems={todoItems}
      onDownloadArtifact={props.onDownloadArtifact}
      onExportResults={props.onExportResults}
      onSelectArtifact={props.onSelectArtifact}
    />
  )
}

function LayerOverviewDetailPanel(props: LayerOverviewDetailPanelProps) {
  const selectedArtifact = selectArtifact(props.artifacts, props.selectedArtifactId)
  return (
    <DetailLayerOverviewPanel
      layers={props.layers}
      layerSummary={buildLayerSummary(props.layers)}
      mapLayers={props.mapLayers}
      selectedArtifact={selectedArtifact}
      onChangeArtifactOpacity={props.onChangeArtifactOpacity}
      onSelectArtifact={props.onSelectArtifact}
      onToggleArtifactVisibility={props.onToggleArtifactVisibility}
    />
  )
}

function HistoryDetailPanel(props: HistoryDetailPanelProps) {
  return (
    <DetailHistoryPanel
      currentRunId={props.currentRunId}
      events={props.events}
      hasMoreHistory={props.hasMoreHistory}
      isHistoryLoading={props.isHistoryLoading}
      progressItems={props.progressItems}
      sessionRuns={props.sessionRuns}
      subAgents={props.agentState?.subAgents ?? []}
      todoItems={props.agentState?.todos ?? []}
      onLoadMoreHistory={props.onLoadMoreHistory}
      onSelectHistoryRun={props.onSelectHistoryRun}
    />
  )
}

function ComputeDetailPanel(props: ComputeDetailPanelProps) {
  const selectedArtifact = selectArtifact(props.artifacts, props.selectedArtifactId)
  const selectedCollection = selectedArtifact
    ? props.artifactData[selectedArtifact.artifactId]
    : undefined
  return (
    <DetailComputePanel
      isToolSubmitting={props.isToolSubmitting}
      mapLayers={props.mapLayers}
      selectedArtifact={selectedArtifact}
      selectedCollection={selectedCollection}
      onExportResults={props.onExportResults}
      onSelectArtifact={props.onSelectArtifact}
      onToggleArtifactVisibility={props.onToggleArtifactVisibility}
    />
  )
}

function selectArtifact(artifacts: ArtifactRef[], selectedArtifactId?: string): ArtifactRef | undefined {
  return artifacts.find(artifact => artifact.artifactId === selectedArtifactId) ?? artifacts[0]
}

function deriveSummaryTitle(area?: string, artifactName?: string) {
  if (area) {
    return `${area}分析`
  }
  if (artifactName) {
    return artifactName
  }
  return '空间分析结果'
}

function buildLayerSummary(layers: LayerDescriptor[]) {
  return layers.reduce(
    (summary, layer) => {
      const isSessionLayer = layer.sourceType.startsWith('session_') || layer.sourceType === 'upload'
      return {
        total: summary.total + 1,
        active: summary.active + (layer.status === 'active' ? 1 : 0),
        inactive: summary.inactive + (layer.status === 'active' ? 0 : 1),
        managed: summary.managed + (isSessionLayer ? 0 : 1),
        session: summary.session + (isSessionLayer ? 1 : 0),
        features: summary.features + (layer.featureCount ?? 0),
      }
    },
    { total: 0, active: 0, inactive: 0, managed: 0, session: 0, features: 0 },
  )
}
