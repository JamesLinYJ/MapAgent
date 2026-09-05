// +-------------------------------------------------------------------------
//
//   地理智能平台 - 托管图层领域类型
//
//   文件:       managedLayerTypes.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
//
//   维护记录 (2026-08-30):
//     作者: JamesLinYJ
//     协助: OpenAI Codex:GPT-5.6 Sol
//     说明: 为托管图层导入增加内容与完整导入指纹，确保相同 Seed 重启导入幂等。
// --------------------------------------------------------------------------

import type { LayerPropertyDescriptor,ResourceVisibility } from '../../schemas/types.js'
import type { GeoJsonFeature,GeoJsonFeatureCollection,Geometry } from '../geojson.js'
import type { CanonicalGeoJson } from '../geojsonCrs.js'

type LayerBounds = [number, number, number, number]

type LayerPropertyValue = string | number | boolean

export interface LayerPropertyFilter {
  property: string
  values: LayerPropertyValue[]
}

export interface LayerFeatureQuery {
  bbox?: LayerBounds
  propertyFilter?: LayerPropertyFilter
  limit?: number
}

export interface StoredFeature {
  geometry: Geometry
  properties: Record<string, unknown>
}

export interface ImportGeoJsonLayerInput {
  collection?: GeoJsonFeatureCollection
  canonicalGeoJson?: CanonicalGeoJson
  layerKey?: string | null
  name: string
  sourceType: string
  description?: string | null
  tags?: string[]
  category?: string | null
  status?: string | null
  sourceFilename?: string | null
  sessionId?: string | null
  threadId?: string | null
  workspaceId?: string | null
  createdByUserId?: string | null
  visibility?: ResourceVisibility
  readonly?: boolean
}

export interface LayerMetadataPatch {
  name?: string
  description?: string
  tags?: string[]
  category?: string
  status?: string
  analysisCapabilities?: string[]
  sourceConfigSummary?: string | null
}

export interface ManagedLayerOwnership {
  scope: 'system' | 'workspace' | 'thread'
  workspaceId: string | null
  threadId: string | null
}

export interface ManagedLayerImportPersistence {
  fingerprintSchemaVersion: 1
  ownershipScope: ManagedLayerOwnership['scope']
  workspaceId: string | null
  threadId: string | null
  title: string
  sourceType: string
  geometryType: string
  srid: 4326
  description: string
  featureCount: number
  propertySchema: LayerPropertyDescriptor[]
  category: string
  tags: string[]
  analysisCapabilities: string[]
  sourceConfigSummary: string | null
  sessionId: string | null
  createdByUserId: string | null
  visibility: ResourceVisibility
  readonly: boolean
  status: 'disabled' | 'ready'
  errorMessage: null
  bounds: LayerBounds
  crs: 'EPSG:4326'
  minZoom: 0
  maxZoom: 22
  source: {
    kind: 'vector_tiles'
    tileJsonUrl: string
    sourceLayer: 'features'
    contentHash: string
  }
  style: Record<string, unknown>
  legend: null
  temporal: null
  capabilities: Record<string, boolean>
}

export interface PreparedManagedLayerImport {
  input: ImportGeoJsonLayerInput
  features: GeoJsonFeature[]
  contentHash: string
  importFingerprint: string
  persistence: ManagedLayerImportPersistence
  layerKey: string
  mapLayerId: string
  ownership: ManagedLayerOwnership
  geometryType: string
  bounds: LayerBounds
  propertySchema: LayerPropertyDescriptor[]
  style: Record<string, unknown>
}
