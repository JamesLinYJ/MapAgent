// +-------------------------------------------------------------------------
//
//   地理智能平台 - 地图资源控制器
//
//   文件:       useMapResources.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { useCallback } from 'react'
import type { ArtifactRef, LayerDescriptor } from '@geo-agent-platform/shared-types'
import { requestDesktopDownload } from '../../../api/client'
import { useLayerManager } from '../../../features/layers/useLayerManager'
import { useMapScene } from '../../../features/map/useMapScene'

interface MapResourcesOptions {
  artifacts: ArtifactRef[]
  artifactCount: number
  currentThreadId?: string | null
  ensureActiveThread: (title: string) => Promise<string>
  layerPreferenceKey?: string
  referenceLayers: LayerDescriptor[]
  setUiError: (error?: string) => void
}

/** 地图场景、图层管理视图模型与导出命令的组合边界。 */
export function useMapResources({
  artifacts,
  artifactCount,
  currentThreadId,
  ensureActiveThread,
  layerPreferenceKey,
  referenceLayers,
  setUiError,
}: MapResourcesOptions) {
  const mapScene = useMapScene(
    currentThreadId ?? null,
    artifactCount,
    useCallback(() => ensureActiveThread('地图浏览'), [ensureActiveThread]),
  )

  const layerManager = useLayerManager({
    layers: mapScene.layers,
    referenceLayers,
    onReplaceLayers: mapScene.replaceLayers,
    onAddLayer: mapScene.addLayer,
    preferenceKey: layerPreferenceKey,
  })

  const exportLayer = useCallback(async (id: string) => {
    const sceneLayer = mapScene.layers.find(item => item.manifest.mapLayerId === id)
    const artifact = artifacts.find(item => item.artifactId === sceneLayer?.manifest.artifactId)
    const url = artifact?.uri ?? (sceneLayer ? `/api/v1/map/layers/${id}/download` : null)
    if (!url) {
      setUiError('当前地图图层没有可下载的数据。')
      return
    }
    try {
      await requestDesktopDownload(url, `${sceneLayer?.manifest.title ?? artifact?.name ?? '地图图层'}.geojson`)
    } catch (error) {
      setUiError(error instanceof Error ? error.message : '地图图层下载失败。')
    }
  }, [artifacts, mapScene.layers, setUiError])

  return { exportLayer, layerManager, mapScene }
}
// +-------------------------------------------------------------------------
//
//   地理智能平台 - 地图资源控制器
//
//   文件:       useMapResources.ts
// --------------------------------------------------------------------------
