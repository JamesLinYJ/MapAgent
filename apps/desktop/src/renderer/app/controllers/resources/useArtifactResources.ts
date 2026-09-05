// +-------------------------------------------------------------------------
//
//   地理智能平台 - Artifact 资源控制器
//
//   文件:       useArtifactResources.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { startTransition, useCallback, useEffect, useMemo, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { AnalysisRun, ArtifactRef } from '@geo-agent-platform/shared-types'
import {
  apiBaseUrl,
  getArtifactGeoJson,
  getArtifactMetadata,
} from '../../../api/client'
import { artifactHasDisplaySurface } from '../../../features/artifacts/artifactDisplay'
import { isRecord } from '../../../shared/utils/guards'
import {
  describeCollectionGeometry,
  describeRasterMetadata,
  parseRasterCoordinates,
} from '../../derivedState'
import { formatUiError, reportNonBlockingError } from '../../bootstrap'
import { useArtifactStore } from '../../stores/artifactStore'
import type { MapRenderLayer } from '../../types'

interface ArtifactResourcesOptions {
  artifacts: ArtifactRef[]
  currentThreadId?: string | null
  runStatus?: AnalysisRun['status']
}

interface HydratedArtifactPayload {
  artifactId: string
  data?: GeoJSON.FeatureCollection
  metadata: Record<string, unknown>
}

/** Artifact 内容水合、显示偏好和旧式地图投影边界。 */
export function useArtifactResources({
  artifacts,
  currentThreadId,
  runStatus,
}: ArtifactResourcesOptions) {
  const queryClient = useQueryClient()
  const hydrationScopeRef = useRef<string | null>(currentThreadId ?? null)
  const pendingHydrationsRef = useRef(new Set<string>())
  const artifactData = useArtifactStore(state => state.data)
  const artifactMetadata = useArtifactStore(state => state.metadata)
  const artifactHydrationErrors = useArtifactStore(state => state.hydrationErrors)
  const mapLayerPreferences = useArtifactStore(state => state.layerPreferences)
  const selectedArtifactId = useArtifactStore(state => state.selectedArtifactId)
  const mergeArtifactData = useArtifactStore(state => state.mergeData)
  const mergeArtifactMetadata = useArtifactStore(state => state.mergeMetadata)
  const setArtifactHydrationErrors = useArtifactStore(state => state.setHydrationErrors)
  const setMapLayerPreferences = useArtifactStore(state => state.setLayerPreferences)
  const setSelectedArtifactId = useArtifactStore(state => state.setSelectedArtifactId)
  const clearArtifacts = useArtifactStore(state => state.clear)

  const hydrateArtifact = useCallback(async (artifact: ArtifactRef): Promise<HydratedArtifactPayload> => {
    return queryClient.fetchQuery({
      queryKey: ['artifact', 'hydration', artifact.artifactId],
      staleTime: Number.POSITIVE_INFINITY,
      queryFn: async () => {
        if (artifact.artifactType === 'geojson') {
          const [data, metadataPayload] = await Promise.all([
            getArtifactGeoJson(artifact.artifactId),
            getArtifactMetadata(artifact.artifactId),
          ])
          return {
            artifactId: artifact.artifactId,
            data,
            metadata: isRecord(metadataPayload.metadata) ? metadataPayload.metadata : {},
          }
        }
        const metadataPayload = await getArtifactMetadata(artifact.artifactId)
        return {
          artifactId: artifact.artifactId,
          metadata: isRecord(metadataPayload.metadata) ? metadataPayload.metadata : {},
        }
      },
    })
  }, [queryClient])

  useEffect(() => {
    const scope = currentThreadId ?? null
    if (hydrationScopeRef.current !== scope) {
      hydrationScopeRef.current = scope
      pendingHydrationsRef.current.clear()
    }

    const activeArtifactIds = new Set(artifacts.map(artifact => artifact.artifactId))
    setArtifactHydrationErrors(current => {
      const retained = Object.entries(current).filter(([artifactId]) => activeArtifactIds.has(artifactId))
      return retained.length === Object.keys(current).length ? current : Object.fromEntries(retained)
    })

    const missing = artifacts.filter(artifact => (
      !pendingHydrationsRef.current.has(artifact.artifactId)
      && !artifactHydrationErrors[artifact.artifactId]
      && (artifact.artifactType === 'geojson'
        ? !artifactData[artifact.artifactId]
        : !artifactMetadata[artifact.artifactId])
    ))
    if (!missing.length) return
    for (const artifact of missing) pendingHydrationsRef.current.add(artifact.artifactId)

    void Promise.allSettled(missing.map(hydrateArtifact)).then(results => {
      if (hydrationScopeRef.current !== scope) return
      const hydrated = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
      const rejected = results.flatMap((result, index) => result.status === 'rejected'
        ? [{ artifactId: missing[index]?.artifactId, error: result.reason }]
        : [])
      startTransition(() => {
        const dataEntries = hydrated.flatMap(entry => entry.data
          ? [{ artifactId: entry.artifactId, data: entry.data }]
          : [])
        if (dataEntries.length) mergeArtifactData(dataEntries)
        if (hydrated.length) mergeArtifactMetadata(hydrated)
        const onlyHydrated = hydrated.length === 1 ? hydrated[0] : undefined
        if (missing.length === 1 && onlyHydrated) setSelectedArtifactId(onlyHydrated.artifactId)
        setArtifactHydrationErrors(current => {
          const next = { ...current }
          for (const entry of hydrated) delete next[entry.artifactId]
          for (const entry of rejected) {
            if (entry.artifactId) next[entry.artifactId] = formatUiError(entry.error, '结果数据加载失败。')
          }
          return next
        })
      })
      for (const entry of rejected) reportNonBlockingError('artifactHydration', entry.error)
    }).finally(() => {
      if (hydrationScopeRef.current !== scope) return
      for (const artifact of missing) pendingHydrationsRef.current.delete(artifact.artifactId)
    })
  }, [
    artifactData,
    artifactHydrationErrors,
    artifactMetadata,
    artifacts,
    currentThreadId,
    hydrateArtifact,
    mergeArtifactData,
    mergeArtifactMetadata,
    setArtifactHydrationErrors,
    setSelectedArtifactId,
  ])

  const retryArtifactHydration = useCallback((artifactId: string) => {
    setArtifactHydrationErrors(current => {
      if (!(artifactId in current)) return current
      const next = { ...current }
      delete next[artifactId]
      return next
    })
  }, [setArtifactHydrationErrors])

  const toggleArtifactVisibility = useCallback((artifactId: string) => {
    setMapLayerPreferences(current => {
      const existing = current[artifactId]
      return {
        ...current,
        [artifactId]: {
          visible: existing ? !existing.visible : false,
          opacity: existing?.opacity ?? 0.9,
        },
      }
    })
  }, [setMapLayerPreferences])

  const setArtifactVisibility = useCallback((artifactId: string, visible: boolean) => {
    setMapLayerPreferences(current => ({
      ...current,
      [artifactId]: {
        visible,
        opacity: current[artifactId]?.opacity ?? 0.9,
      },
    }))
  }, [setMapLayerPreferences])

  const changeArtifactOpacity = useCallback((artifactId: string, opacity: number) => {
    setMapLayerPreferences(current => ({
      ...current,
      [artifactId]: {
        visible: current[artifactId]?.visible ?? true,
        opacity,
      },
    }))
  }, [setMapLayerPreferences])

  const mapLayers = useMemo(() => artifacts
    .filter(artifact => runStatus === 'running' || !artifact.isIntermediate)
    .flatMap<MapRenderLayer>(artifact => {
      const visible = mapLayerPreferences[artifact.artifactId]?.visible ?? true
      const opacity = mapLayerPreferences[artifact.artifactId]?.opacity ?? 0.9
      const metadata = artifactMetadata[artifact.artifactId] ?? artifact.metadata
      const displayArtifact = { ...artifact, metadata }
      if (!artifactHasDisplaySurface(displayArtifact, 'map')) return []
      if (artifact.artifactType === 'geojson' && artifactData[artifact.artifactId]) {
        return [{
          kind: 'geojson',
          artifact: displayArtifact,
          data: artifactData[artifact.artifactId],
          visible,
          opacity,
          featureCount: artifactData[artifact.artifactId]?.features.length ?? 0,
          geometrySummary: describeCollectionGeometry(artifactData[artifact.artifactId]),
        }]
      }
      const coordinates = parseRasterCoordinates(metadata.coordinates)
      const imageUrl = typeof metadata.imageUrl === 'string'
        ? `${apiBaseUrl}${metadata.imageUrl}`
        : `${apiBaseUrl}${artifact.uri}`
      if (artifact.artifactType === 'raster_png' && coordinates) {
        return [{
          kind: 'raster',
          artifact: displayArtifact,
          imageUrl,
          coordinates,
          visible,
          opacity,
          featureCount: 1,
          geometrySummary: describeRasterMetadata(metadata),
        }]
      }
      return []
    }), [artifactData, artifactMetadata, artifacts, mapLayerPreferences, runStatus])

  return {
    artifactData,
    artifactHydrationErrors,
    artifactMetadata,
    changeArtifactOpacity,
    clearArtifacts,
    mapLayers,
    retryArtifactHydration,
    selectedArtifactId,
    setArtifactVisibility,
    setSelectedArtifactId,
    toggleArtifactVisibility,
  }
}
// +-------------------------------------------------------------------------
//
//   地理智能平台 - Artifact 资源控制器
//
//   文件:       useArtifactResources.ts
// --------------------------------------------------------------------------
