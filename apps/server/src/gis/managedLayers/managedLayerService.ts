// +-------------------------------------------------------------------------
//
//   地理智能平台 - 托管图层服务
//
//   文件:       managedLayerService.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { Database } from '../../db/connection.js'
import type { LayerDescriptor } from '../../schemas/types.js'
import { ManagedFeatureRepository } from './managedFeatureRepository.js'
import { ManagedLayerImportService } from './managedLayerImportService.js'
import { ManagedLayerRepository } from './managedLayerRepository.js'
import { ManagedLayerSceneProjection } from './managedLayerSceneProjection.js'
import type {
  ImportGeoJsonLayerInput,
  LayerFeatureQuery,
  LayerMetadataPatch,
  StoredFeature,
} from './managedLayerTypes.js'
import { PostGisHealthProbe, type PostGisHealthStatus } from './postGisHealthProbe.js'

export type {
  ImportGeoJsonLayerInput,
  LayerFeatureQuery,
  LayerMetadataPatch,
  StoredFeature,
} from './managedLayerTypes.js'

/**
 * 托管矢量图层的应用门面。调用方不接触数据库、空间 SQL 或导入事务内部实现。
 */
export class ManagedLayerService {
  private readonly layers: ManagedLayerRepository
  private readonly features: ManagedFeatureRepository
  private readonly importer: ManagedLayerImportService
  private readonly health: PostGisHealthProbe

  constructor(db: Database) {
    this.layers = new ManagedLayerRepository(db)
    this.features = new ManagedFeatureRepository(db)
    this.importer = new ManagedLayerImportService(
      db,
      this.layers,
      this.features,
      new ManagedLayerSceneProjection(),
    )
    this.health = new PostGisHealthProbe(db)
  }

  status(): Promise<PostGisHealthStatus> {
    return this.health.status()
  }

  listLayers(
    workspaceId: string,
    sessionId?: string | null,
    threadId?: string | null,
  ): Promise<LayerDescriptor[]> {
    return this.layers.listVisibleLayers(workspaceId, sessionId, threadId)
  }

  listVisibleLayers(
    workspaceId: string,
    sessionId?: string | null,
    threadId?: string | null,
  ): Promise<LayerDescriptor[]> {
    return this.layers.listVisibleLayers(workspaceId, sessionId, threadId)
  }

  getLayer(layerKey: string): Promise<LayerDescriptor | null> {
    return this.layers.getLayer(layerKey)
  }

  geocode(query: string): Promise<Array<{ label: string; longitude: number; latitude: number }>> {
    return this.layers.geocode(query)
  }

  async queryFeatures(layerKey: string, query: LayerFeatureQuery = {}): Promise<StoredFeature[]> {
    const mapLayerId = await this.layers.requireManagedMapLayerId(layerKey)
    return this.features.queryFeatures(mapLayerId, query)
  }

  async featureCount(layerKey: string, query: Omit<LayerFeatureQuery, 'limit'> = {}): Promise<number> {
    const mapLayerId = await this.layers.requireManagedMapLayerId(layerKey)
    return this.features.featureCount(mapLayerId, query)
  }

  importGeoJsonLayer(input: ImportGeoJsonLayerInput): Promise<LayerDescriptor> {
    return this.importer.importGeoJsonLayer(input)
  }

  updateLayerMetadata(layerKey: string, patch: LayerMetadataPatch): Promise<LayerDescriptor> {
    return this.layers.updateLayerMetadata(layerKey, patch)
  }

  deleteLayer(layerKey: string): Promise<boolean> {
    return this.layers.deleteLayer(layerKey)
  }
}
