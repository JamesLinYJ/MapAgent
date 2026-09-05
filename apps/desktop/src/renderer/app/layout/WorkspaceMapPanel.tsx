// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工作台地图面板
//
//   文件:       WorkspaceMapPanel.tsx
//
//   日期:       2026年07月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { lazy, Suspense } from 'react'
import { m } from 'framer-motion'
import type { BasemapDescriptor } from '@geo-agent-platform/shared-types'
import { MapErrorBoundary } from '../../features/map/MapErrorBoundary'
import type { MapSceneController } from '../../features/map/useMapScene'
import { motionSpring } from '../../shared/motion'
import { loadWorkspaceMapCanvas, preloadWorkspaceMap } from './workspaceMapPreload'

const MapCanvas = lazy(() => loadWorkspaceMapCanvas().then((module) => ({ default: module.MapCanvas })))

interface WorkspaceMapPanelProps {
  artifactCount: number
  basemaps: BasemapDescriptor[]
  mapScene: MapSceneController
  isMapActivated: boolean
  runStatus?: string
  selectedBasemapKey: string
  selectedArtifactId?: string
  selectedArtifactName?: string
  focusRequest?: { mapLayerId?: string; nonce: number }
  placeResolution?: { status: string; selected?: { latitude?: number | null; longitude?: number | null } | null } | null
  agentState?: { placeResolution?: { status: string; selected?: { latitude?: number | null; longitude?: number | null } | null } | null } | null
  onActivateMap: () => void
  onSelectArtifact: (artifactId: string) => void
}

export function WorkspaceMapPanel({
  artifactCount,
  basemaps,
  mapScene,
  isMapActivated,
  runStatus,
  selectedBasemapKey,
  selectedArtifactId,
  selectedArtifactName,
  focusRequest,
  placeResolution,
  agentState,
  onActivateMap,
  onSelectArtifact,
}: WorkspaceMapPanelProps) {
  return (
    <m.section
      className="workbench-map-shell"
      data-geo-agent-platform-export-map=""
      aria-label="空间地图"
      layout
      transition={motionSpring.gentle}
      onPointerEnter={() => { void preloadWorkspaceMap().catch(() => undefined) }}
    >
      <div className="workbench-map-shell__body">
        {isMapActivated ? (
          <MapErrorBoundary>
            <Suspense fallback={<div className="dc-map-stage dc-map-stage--loading">正在初始化地图…</div>}>
              <MapCanvas
                artifactCount={artifactCount}
                basemaps={basemaps}
                runStatus={runStatus}
                selectedBasemapKey={selectedBasemapKey}
                layers={mapScene.layers}
                sceneError={mapScene.error}
                sceneLoading={mapScene.isLoading}
                onUpdateLayer={mapScene.updateLayer}
                selectedArtifactId={selectedArtifactId}
                selectedArtifactName={selectedArtifactName}
                focusRequest={focusRequest}
                onSelectArtifact={onSelectArtifact}
                placeResolution={placeResolution}
                agentState={agentState}
              />
            </Suspense>
          </MapErrorBoundary>
        ) : (
          <button
            type="button"
            className="dc-map-stage dc-map-stage--loading dc-map-activation"
            onClick={onActivateMap}
            onFocus={() => { void preloadWorkspaceMap().catch(() => undefined) }}
          >
            <strong>空间地图</strong>
            <span>点击打开地图检查器</span>
          </button>
        )}
      </div>
    </m.section>
  )
}
