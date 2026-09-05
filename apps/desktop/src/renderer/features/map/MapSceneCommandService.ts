// +-------------------------------------------------------------------------
//
//   地理智能平台 - 地图场景命令服务
//
//   文件:       MapSceneCommandService.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { MapScene, MapSceneLayer, MapSceneUpdate } from '@geo-agent-platform/shared-types'
import { MapSceneMutationCoordinator } from './MapSceneMutationCoordinator'

export interface MapSceneCommandPort {
  ensureThread: () => Promise<string>
  readScene: (threadId: string) => MapScene | null
  loadScene: (threadId: string) => Promise<MapScene>
  persistScene: (update: MapSceneUpdate) => Promise<MapScene>
  publishScene: (threadId: string, scene: MapScene) => void
  invalidateScene: (threadId: string) => void
  hasManifest: (threadId: string, mapLayerId: string) => boolean
}

/**
 * MapScene 的应用命令边界。它负责线程解析、场景初始化和每线程的串行写入，
 * React、图层面板和 MapLibre 渲染器都不需要知道这些生命周期细节。
 */
export class MapSceneCommandService {
  private readonly coordinators = new Map<string, MapSceneMutationCoordinator>()

  constructor(private readonly port: MapSceneCommandPort) {}

  syncRemote(threadId: string, scene: MapScene, publish = false): void {
    this.coordinator(threadId).syncRemote(scene, publish)
  }

  async replaceLayers(layers: MapSceneLayer[], threadId?: string | null): Promise<string> {
    const resolvedThreadId = threadId ?? await this.port.ensureThread()
    await this.ensureScene(resolvedThreadId)
    await this.coordinator(resolvedThreadId).enqueue(normalizeOrder(layers))
    return resolvedThreadId
  }

  async addLayer(mapLayerId: string, threadId?: string | null): Promise<string> {
    const resolvedThreadId = threadId ?? await this.port.ensureThread()
    const scene = await this.ensureScene(resolvedThreadId)
    if (scene.layers.some(layer => layer.mapLayerId === mapLayerId)) return resolvedThreadId

    await this.coordinator(resolvedThreadId).enqueue(normalizeOrder([
      ...scene.layers,
      {
        mapLayerId,
        order: scene.layers.length,
        visible: true,
        opacity: 1,
        styleOverride: null,
        label: null,
        currentFrameId: null,
      },
    ]))
    if (!this.port.hasManifest(resolvedThreadId, mapLayerId)) {
      this.port.invalidateScene(resolvedThreadId)
    }
    return resolvedThreadId
  }

  async updateLayer(
    mapLayerId: string,
    patch: Partial<Pick<MapSceneLayer, 'visible' | 'opacity' | 'styleOverride' | 'label' | 'currentFrameId'>>,
    threadId?: string | null,
  ): Promise<string> {
    const resolvedThreadId = threadId ?? await this.port.ensureThread()
    const scene = await this.ensureScene(resolvedThreadId)
    if (!scene.layers.some(layer => layer.mapLayerId === mapLayerId)) {
      throw new Error(`地图场景中不存在图层 '${mapLayerId}'。`)
    }
    await this.coordinator(resolvedThreadId).enqueue(scene.layers.map(layer => (
      layer.mapLayerId === mapLayerId ? { ...layer, ...patch } : layer
    )))
    return resolvedThreadId
  }

  private async ensureScene(threadId: string): Promise<MapScene> {
    const cached = this.port.readScene(threadId)
    const scene = cached ?? await this.port.loadScene(threadId)
    this.coordinator(threadId).syncRemote(scene)
    return scene
  }

  private coordinator(threadId: string): MapSceneMutationCoordinator {
    const existing = this.coordinators.get(threadId)
    if (existing) return existing

    const coordinator = new MapSceneMutationCoordinator({
      readScene: () => this.port.readScene(threadId),
      persist: update => this.port.persistScene(update),
      publish: scene => this.port.publishScene(threadId, scene),
      onFailure: () => this.port.invalidateScene(threadId),
    })
    this.coordinators.set(threadId, coordinator)
    return coordinator
  }
}

function normalizeOrder(layers: MapSceneLayer[]): MapSceneLayer[] {
  return layers.map((layer, order) => ({ ...layer, order }))
}
// +-------------------------------------------------------------------------
//
//   地理智能平台 - 地图场景命令服务
//
//   文件:       MapSceneCommandService.ts
// --------------------------------------------------------------------------
