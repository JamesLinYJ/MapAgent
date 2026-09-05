// +-------------------------------------------------------------------------
//
//   地理智能平台 - 托管图层几何准备
//
//   文件:       managedLayerGeometry.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
//
//   维护记录 (2026-08-30):
//     作者: JamesLinYJ
//     协助: OpenAI Codex:GPT-5.6 Sol
//     说明: 对规范化图层内容和持久化导入语义生成稳定指纹，供启动 Seed 幂等判定使用。
// --------------------------------------------------------------------------

import { createHash } from 'node:crypto'

import { stableJson } from '../../framework/schema.js'
import type { LayerPropertyDescriptor } from '../../schemas/types.js'
import { makeId } from '../../utils/ids.js'
import { toFeatureCollection,type GeoJsonFeature } from '../geojson.js'
import { normalizeGeoJsonToCrs84,requireRenderableCrs84Bounds,type CanonicalGeoJson } from '../geojsonCrs.js'
import type {
ImportGeoJsonLayerInput,
ManagedLayerImportPersistence,
ManagedLayerOwnership,
PreparedManagedLayerImport,
} from './managedLayerTypes.js'

interface PropertySchemaAccumulator {
  dataType: string
  populatedCount: number
  sampleValues: Set<string>
}

export function prepareManagedLayerImport(input: ImportGeoJsonLayerInput): PreparedManagedLayerImport {
  const canonical = requireCanonicalGeoJson(input)
  const features = requireFeatures(canonical)
  const layerKey = sanitizeLayerKey(input.layerKey ?? makeId('layer'))
  const geometryTypes = [...new Set(features.map(feature => feature.geometry.type))]
  const geometryType = geometryTypes.length === 1 ? geometryTypes[0] ?? 'Mixed' : 'Mixed'
  const ownership = resolveOwnership(input)
  const bounds = requireRenderableCrs84Bounds(canonical.bounds, '托管图层 GeoJSON')
  const propertySchema = buildPropertySchema(features)
  const style = defaultVectorStyle(geometryType)
  const contentHash = managedLayerContentHash(features)
  const persistence: ManagedLayerImportPersistence = {
    fingerprintSchemaVersion: 1,
    ownershipScope: ownership.scope,
    workspaceId: ownership.workspaceId,
    threadId: ownership.threadId,
    title: input.name,
    sourceType: input.sourceType,
    geometryType,
    srid: 4326,
    description: input.description ?? '',
    featureCount: features.length,
    propertySchema,
    category: input.category ?? 'upload',
    tags: input.tags ?? [],
    analysisCapabilities: ['query', 'spatial_analysis'],
    sourceConfigSummary: input.sourceFilename ?? null,
    sessionId: input.sessionId ?? null,
    createdByUserId: input.createdByUserId ?? null,
    visibility: input.visibility ?? 'workspace',
    readonly: input.readonly === true || input.sourceType === 'system',
    status: input.status === 'disabled' ? 'disabled' : 'ready',
    errorMessage: null,
    bounds,
    crs: 'EPSG:4326',
    minZoom: 0,
    maxZoom: 22,
    source: {
      kind: 'vector_tiles',
      tileJsonUrl: `/api/v1/map/layers/map_layer_${layerKey}/tilejson`,
      sourceLayer: 'features',
      contentHash,
    },
    style,
    legend: null,
    temporal: null,
    capabilities: {
      query: true,
      labels: propertySchema.length > 0,
      style: true,
      temporal: false,
      opacity: true,
      download: true,
    },
  }
  return {
    input,
    features,
    contentHash,
    importFingerprint: managedLayerImportFingerprint(persistence),
    persistence,
    layerKey,
    mapLayerId: `map_layer_${layerKey}`,
    ownership,
    geometryType,
    bounds,
    propertySchema,
    style,
  }
}

export function managedLayerContentHash(features: GeoJsonFeature[]): string {
  return sha256Digest(features)
}

export function managedLayerImportFingerprint(persistence: ManagedLayerImportPersistence): string {
  return sha256Digest(persistence)
}

function sha256Digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableJson(value), 'utf8').digest('hex')}`
}

function requireCanonicalGeoJson(input: ImportGeoJsonLayerInput): CanonicalGeoJson {
  if (input.canonicalGeoJson && input.collection) {
    throw new Error('托管图层只能提交 canonicalGeoJson 或原始 collection，不能同时提交两个事实源')
  }
  if (input.canonicalGeoJson) return input.canonicalGeoJson
  if (!input.collection) throw new Error('托管图层缺少 GeoJSON 输入')
  return normalizeGeoJsonToCrs84(input.collection, '托管图层 GeoJSON')
}

function requireFeatures(canonical: CanonicalGeoJson): GeoJsonFeature[] {
  const collection = toFeatureCollection(canonical.entity)
  if (collection.features.length === 0) {
    throw new Error('GeoJSON 至少需要一个 feature')
  }
  return collection.features
}

function resolveOwnership(input: ImportGeoJsonLayerInput): ManagedLayerOwnership {
  if (input.sourceType === 'system') return { scope: 'system', workspaceId: null, threadId: null }
  if (!input.workspaceId) throw new Error('非系统图层必须绑定 workspaceId')
  return input.threadId
    ? { scope: 'thread', workspaceId: input.workspaceId, threadId: input.threadId }
    : { scope: 'workspace', workspaceId: input.workspaceId, threadId: null }
}

function defaultVectorStyle(geometryType: string): Record<string, unknown> {
  if (geometryType.includes('Point')) {
    return {
      kind: 'point', opacity: 1, colorField: null, categories: [], color: '#1976d2',
      radius: 6, strokeColor: '#ffffff', strokeWidth: 1, cluster: true,
    }
  }
  if (geometryType.includes('Line')) {
    return {
      kind: 'line', opacity: 1, colorField: null, categories: [], color: '#1976d2',
      width: 2, dashArray: null,
    }
  }
  return {
    kind: 'polygon', opacity: 0.72, colorField: null, categories: [], color: '#3aa981',
    outlineColor: '#16735a', outlineWidth: 1,
  }
}

function buildPropertySchema(features: GeoJsonFeature[]): LayerPropertyDescriptor[] {
  const stats = new Map<string, PropertySchemaAccumulator>()
  for (const feature of features) {
    const properties = feature.properties === null
      ? {}
      : requireRecord(feature.properties, 'GeoJSON properties')
    for (const [name, value] of Object.entries(properties)) {
      const current = stats.get(name) ?? {
        dataType: inferDataType(value), populatedCount: 0, sampleValues: new Set<string>(),
      }
      if (value !== null && value !== undefined && value !== '') {
        current.populatedCount += 1
        if (current.sampleValues.size < 5) current.sampleValues.add(String(value))
      }
      if (current.dataType === 'null') current.dataType = inferDataType(value)
      stats.set(name, current)
    }
  }
  return [...stats.entries()].sort(([left], [right]) => compareStableText(left, right)).map(([name, entry]) => ({
    name,
    dataType: entry.dataType === 'null' ? 'string' : entry.dataType,
    populatedCount: entry.populatedCount,
    sampleValues: [...entry.sampleValues],
  }))
}

function compareStableText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function inferDataType(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function sanitizeLayerKey(value: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9_]+/gu, '_')
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(normalized)
    ? normalized
    : `layer_${normalized || makeId('layer').replace(/^layer_/, '')}`
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} 必须是对象`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
