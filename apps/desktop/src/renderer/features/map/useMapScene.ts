// +-------------------------------------------------------------------------
//
//   地理智能平台 - 地图场景查询控制器
//
//   文件:       useMapScene.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { MapLayerManifest, MapScene, MapSceneLayer } from '@geo-agent-platform/shared-types'
import { getMapScene, type MapSceneBundle, updateMapScene } from '../../api/mapApi'
import { wsClient } from '../../ws/client'
import { MapSceneCommandService } from './MapSceneCommandService'

export interface SceneRenderLayer {
  manifest: MapLayerManifest
  scene: MapSceneLayer
}

export interface MapSceneController {
  error: string | null
  isLoading: boolean
  layers: SceneRenderLayer[]
  scene: MapScene | null
  replaceLayers: (layers: MapSceneLayer[]) => Promise<void>
  addLayer: (mapLayerId: string) => Promise<void>
  updateLayer: (
    mapLayerId: string,
    patch: Partial<Pick<MapSceneLayer, 'visible' | 'opacity' | 'styleOverride' | 'label' | 'currentFrameId'>>,
  ) => Promise<void>
}

export function useMapScene(
  threadId: string | null,
  artifactCount: number,
  ensureThread: () => Promise<string>,
): MapSceneController {
  const queryClient = useQueryClient()
  const previousArtifactCount = useRef(artifactCount)
  const queryKey = useMemo(() => ['map-scene', threadId] as const, [threadId])
  const query = useQuery({
    queryKey,
    queryFn: () => {
      if (!threadId) throw new Error('地图场景缺少 threadId')
      return getMapScene(threadId)
    },
    enabled: Boolean(threadId),
    staleTime: 15_000,
    retry: false,
  })

  const commandService = useMemo(() => new MapSceneCommandService({
    ensureThread,
    readScene: candidateThreadId => queryClient.getQueryData<MapSceneBundle>(['map-scene', candidateThreadId])?.scene ?? null,
    loadScene: async candidateThreadId => {
      const key = ['map-scene', candidateThreadId] as const
      const bundle = await queryClient.fetchQuery({
        queryKey: key,
        queryFn: () => getMapScene(candidateThreadId),
        staleTime: 15_000,
      })
      return bundle.scene ?? Promise.reject(new Error('地图场景初始化失败。'))
    },
    persistScene: updateMapScene,
    publishScene: (candidateThreadId, updated) => {
      queryClient.setQueryData<MapSceneBundle>(['map-scene', candidateThreadId], bundle => (
        bundle ? { ...bundle, scene: updated } : bundle
      ))
    },
    invalidateScene: candidateThreadId => {
      void queryClient.invalidateQueries({ queryKey: ['map-scene', candidateThreadId] })
    },
    hasManifest: (candidateThreadId, mapLayerId) => (
      queryClient.getQueryData<MapSceneBundle>(['map-scene', candidateThreadId])?.layers
        .some(layer => layer.mapLayerId === mapLayerId) ?? false
    ),
  }), [ensureThread, queryClient])

  useEffect(() => {
    if (threadId && query.data?.scene) commandService.syncRemote(threadId, query.data.scene)
  }, [commandService, query.data?.scene, threadId])

  useEffect(() => {
    if (!threadId) return
    if (previousArtifactCount.current === artifactCount) return
    previousArtifactCount.current = artifactCount
    void queryClient.invalidateQueries({ queryKey })
  }, [artifactCount, queryClient, queryKey, threadId])

  useEffect(() => wsClient.on(message => {
    if (!threadId) return
    if (message.type === 'connected') {
      void queryClient.invalidateQueries({ queryKey })
      return
    }
    if (message.type !== 'map.scene.updated' || message.payload.data.threadId !== threadId) return
    const current = queryClient.getQueryData<MapSceneBundle>(queryKey)
    if (!current) {
      void queryClient.invalidateQueries({ queryKey })
      return
    }
    commandService.syncRemote(threadId, message.payload.data, true)
    const knownManifestIds = new Set(current.layers.map(layer => layer.mapLayerId))
    if (message.payload.data.layers.some(layer => !knownManifestIds.has(layer.mapLayerId))) {
      void queryClient.invalidateQueries({ queryKey })
    }
  }), [commandService, queryClient, queryKey, threadId])

  const scene = query.data?.scene ?? null
  const manifests = query.data?.layers
  const byId = useMemo(
    () => new Map((manifests ?? []).map(layer => [layer.mapLayerId, layer])),
    [manifests],
  )
  const layers = useMemo<SceneRenderLayer[]>(() => (scene?.layers ?? [])
    .slice()
    .sort((left, right) => left.order - right.order)
    .flatMap(sceneLayer => {
      const manifest = byId.get(sceneLayer.mapLayerId)
      return manifest ? [{ manifest, scene: sceneLayer }] : []
    }), [byId, scene])

  const replaceLayers = useCallback(async (nextLayers: MapSceneLayer[]) => {
    await commandService.replaceLayers(nextLayers, threadId)
  }, [commandService, threadId])

  const addLayer = useCallback(async (mapLayerId: string) => {
    await commandService.addLayer(mapLayerId, threadId)
  }, [commandService, threadId])

  const updateLayer = useCallback(async (
    mapLayerId: string,
    patch: Partial<Pick<MapSceneLayer, 'visible' | 'opacity' | 'styleOverride' | 'label' | 'currentFrameId'>>,
  ) => {
    await commandService.updateLayer(mapLayerId, patch, threadId)
  }, [commandService, threadId])

  return {
    error: query.error instanceof Error ? query.error.message : null,
    isLoading: query.isLoading,
    layers,
    scene,
    replaceLayers,
    addLayer,
    updateLayer,
  }
}
