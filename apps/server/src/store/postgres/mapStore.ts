// +-------------------------------------------------------------------------
//
//   地理智能平台 - 地图持久化门面
//
//   文件:       mapStore.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { Database } from '../../db/connection.js'
import type {
  MapFeaturePage,
  MapLayerManifest,
  MapScene,
  MapSceneUpdate,
} from '../../schemas/types.js'
import type { InMemoryEventBus } from '../eventBus.js'
import { MapFeatureRepository } from './mapFeatureRepository.js'
import {
  MapLayerRepository,
  type MapResourceScope,
  type MapTileExecutionSpec,
} from './mapLayerRepository.js'
import { MapSceneRepository } from './mapSceneRepository.js'


export type { MapResourceScope, MapTileExecutionSpec } from './mapLayerRepository.js'

/**
 * 面向 HTTP、WS 和应用容器的稳定地图组合接口。
 * 场景写入、图层元数据和 PostGIS 要素查询由各自仓储拥有。
 */
export class MapStore {
  private readonly layers: MapLayerRepository
  private readonly scenes: MapSceneRepository
  private readonly features: MapFeatureRepository

  constructor(db: Database, sceneBus: InMemoryEventBus<MapScene>) {
    this.layers = new MapLayerRepository(db)
    this.scenes = new MapSceneRepository(db, this.layers, sceneBus)
    this.features = new MapFeatureRepository(db)
  }

  getThreadScope(threadId: string): Promise<MapResourceScope | null> {
    return this.scenes.getThreadScope(threadId)
  }

  getLayerScope(mapLayerId: string): Promise<MapResourceScope | null> {
    return this.layers.getLayerScope(mapLayerId)
  }

  getManifest(mapLayerId: string): Promise<MapLayerManifest | null> {
    return this.layers.getManifest(mapLayerId)
  }

  getTileExecutionSpec(mapLayerId: string): Promise<MapTileExecutionSpec | null> {
    return this.layers.getTileExecutionSpec(mapLayerId)
  }

  getScene(threadId: string): Promise<MapScene | null> {
    return this.scenes.getScene(threadId)
  }

  getOrCreateScene(threadId: string): Promise<MapScene> {
    return this.scenes.getOrCreateScene(threadId)
  }

  listSceneManifests(threadId: string): Promise<MapLayerManifest[]> {
    return this.scenes.listSceneManifests(threadId)
  }

  updateScene(input: MapSceneUpdate): Promise<MapScene> {
    return this.scenes.updateScene(input)
  }

  listFeatures(mapLayerId: string, offset: number, limit: number): Promise<MapFeaturePage> {
    return this.features.listFeatures(mapLayerId, offset, limit)
  }

  exportFeatureCollection(mapLayerId: string): Promise<Record<string, unknown>> {
    return this.features.exportFeatureCollection(mapLayerId)
  }

  isLayerInThreadScene(threadId: string, mapLayerId: string): Promise<boolean> {
    return this.scenes.isLayerInThreadScene(threadId, mapLayerId)
  }
}
