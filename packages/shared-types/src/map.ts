// +-------------------------------------------------------------------------
//
//   地理智能平台 - 地图共享契约
//
//   文件:       map.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { z } from 'zod'

const finiteNumberSchema = z.number().finite()
const longitudeSchema = finiteNumberSchema.min(-180).max(180)
const latitudeSchema = finiteNumberSchema.min(-90).max(90)

export const mapBoundsSchema = z.tuple([
  longitudeSchema,
  latitudeSchema,
  longitudeSchema,
  latitudeSchema,
]).refine(([west, south, east, north]) => west < east && south < north, {
  message: '地图范围必须满足 west < east 且 south < north',
})

export const mapCoordinateSchema = z.tuple([longitudeSchema, latitudeSchema])
export const mapImageCoordinatesSchema = z.tuple([
  mapCoordinateSchema,
  mapCoordinateSchema,
  mapCoordinateSchema,
  mapCoordinateSchema,
])

const relativeResourceUrlSchema = z.string().trim().min(1).refine(
  value => value.startsWith('/'),
  { message: '地图资源必须使用同源相对地址' },
)

export const mapLayerSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('geojson'),
    url: relativeResourceUrlSchema,
    featureCount: z.number().int().nonnegative(),
    sizeBytes: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal('vector_tiles'),
    tileJsonUrl: relativeResourceUrlSchema,
    sourceLayer: z.string().trim().min(1),
  }),
  z.object({
    kind: z.literal('raster_image'),
    url: relativeResourceUrlSchema,
    coordinates: mapImageCoordinatesSchema,
  }),
  z.object({
    kind: z.literal('raster_tiles'),
    tileJsonUrl: relativeResourceUrlSchema,
    tileSize: z.union([z.literal(256), z.literal(512)]).default(256),
  }),
  z.object({
    kind: z.literal('raster_dem'),
    tileJsonUrl: relativeResourceUrlSchema,
    encoding: z.enum(['mapbox', 'terrarium']).default('mapbox'),
    tileSize: z.union([z.literal(256), z.literal(512)]).default(256),
  }),
])

export const colorStopSchema = z.object({
  value: finiteNumberSchema,
  color: z.string().trim().min(1),
  label: z.string().trim().min(1).optional(),
})

export const categoryStyleSchema = z.object({
  value: z.union([z.string(), z.number(), z.boolean()]),
  label: z.string().trim().min(1),
  color: z.string().trim().min(1),
})

const commonVectorStyleSchema = z.object({
  opacity: z.number().min(0).max(1).default(1),
  colorField: z.string().trim().min(1).nullable().default(null),
  categories: z.array(categoryStyleSchema).default([]),
})

export const mapLayerStyleSchema = z.discriminatedUnion('kind', [
  commonVectorStyleSchema.extend({
    kind: z.literal('point'),
    color: z.string().trim().min(1),
    radius: z.number().min(1).max(64).default(6),
    strokeColor: z.string().trim().min(1).default('#ffffff'),
    strokeWidth: z.number().min(0).max(12).default(1),
    cluster: z.boolean().default(false),
  }),
  commonVectorStyleSchema.extend({
    kind: z.literal('line'),
    color: z.string().trim().min(1),
    width: z.number().min(0.5).max(32).default(2),
    dashArray: z.array(z.number().positive()).max(8).nullable().default(null),
  }),
  commonVectorStyleSchema.extend({
    kind: z.literal('polygon'),
    color: z.string().trim().min(1),
    outlineColor: z.string().trim().min(1).default('#ffffff'),
    outlineWidth: z.number().min(0).max(12).default(1),
  }),
  z.object({
    kind: z.literal('heatmap'),
    field: z.string().trim().min(1).nullable().default(null),
    radius: z.number().min(1).max(128).default(30),
    intensity: z.number().positive().max(10).default(1),
    opacity: z.number().min(0).max(1).default(0.85),
    colorStops: z.array(colorStopSchema).min(2),
  }),
  z.object({
    kind: z.literal('contour'),
    valueField: z.string().trim().min(1),
    color: z.string().trim().min(1),
    width: z.number().min(0.5).max(12).default(1.5),
    label: z.boolean().default(true),
    opacity: z.number().min(0).max(1).default(1),
  }),
  z.object({
    kind: z.literal('continuous_raster'),
    rangeMode: z.enum(['data', 'robust', 'custom']).default('data'),
    dataRange: z.tuple([finiteNumberSchema, finiteNumberSchema]),
    renderRange: z.tuple([finiteNumberSchema, finiteNumberSchema]),
    colorStops: z.array(colorStopSchema).min(2),
    opacity: z.number().min(0).max(1).default(1),
  }),
  z.object({
    kind: z.literal('categorical_raster'),
    categories: z.array(categoryStyleSchema).min(1),
    opacity: z.number().min(0).max(1).default(1),
  }),
  z.object({
    kind: z.literal('hillshade'),
    exaggeration: z.number().min(0).max(8).default(1),
    shadowColor: z.string().trim().min(1).default('#253247'),
    highlightColor: z.string().trim().min(1).default('#f8fafc'),
    accentColor: z.string().trim().min(1).default('#64748b'),
  }),
]).superRefine((style, context) => {
  if ('dataRange' in style && style.dataRange[0] >= style.dataRange[1]) {
    context.addIssue({ code: 'custom', path: ['dataRange'], message: '数据范围最小值必须小于最大值' })
  }
  if ('renderRange' in style && style.renderRange[0] >= style.renderRange[1]) {
    context.addIssue({ code: 'custom', path: ['renderRange'], message: '渲染范围最小值必须小于最大值' })
  }
})

export const mapLegendSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('continuous'),
    title: z.string().trim().min(1),
    unit: z.string().trim().min(1).nullable().default(null),
    range: z.tuple([finiteNumberSchema, finiteNumberSchema]),
    stops: z.array(colorStopSchema).min(2),
    nodataLabel: z.string().trim().min(1).nullable().default(null),
  }),
  z.object({
    kind: z.literal('classified'),
    title: z.string().trim().min(1),
    unit: z.string().trim().min(1).nullable().default(null),
    classes: z.array(z.object({
      min: finiteNumberSchema,
      max: finiteNumberSchema,
      label: z.string().trim().min(1),
      color: z.string().trim().min(1),
    })).min(1),
  }),
  z.object({
    kind: z.literal('categorical'),
    title: z.string().trim().min(1),
    categories: z.array(categoryStyleSchema).min(1),
  }),
])

export const mapTemporalFrameSchema = z.object({
  frameId: z.string().trim().min(1),
  validTime: z.string().datetime({ offset: true }),
  label: z.string().trim().min(1),
  source: mapLayerSourceSchema.optional(),
})

export const mapTemporalSchema = z.object({
  frames: z.array(mapTemporalFrameSchema).min(1),
  defaultFrameId: z.string().trim().min(1),
}).superRefine((temporal, context) => {
  const ids = new Set(temporal.frames.map(frame => frame.frameId))
  if (ids.size !== temporal.frames.length) {
    context.addIssue({ code: 'custom', path: ['frames'], message: '时间帧标识不能重复' })
  }
  if (!ids.has(temporal.defaultFrameId)) {
    context.addIssue({ code: 'custom', path: ['defaultFrameId'], message: '默认时间帧不存在' })
  }
})

export const mapLayerCapabilitiesSchema = z.object({
  query: z.boolean().default(false),
  labels: z.boolean().default(false),
  style: z.boolean().default(false),
  temporal: z.boolean().default(false),
  opacity: z.boolean().default(true),
  download: z.boolean().default(false),
})

export const mapLayerLabelSchema = z.object({
  field: z.string().trim().min(1),
  placement: z.enum(['auto', 'point', 'line']).default('auto'),
  size: z.number().min(8).max(32).default(12),
  color: z.string().trim().min(1).default('#1f2937'),
  haloColor: z.string().trim().min(1).default('#ffffff'),
  haloWidth: z.number().min(0).max(4).default(1.5),
})

export const mapLayerDraftSchema = z.object({
  title: z.string().trim().min(1),
  replacementGroup: z.string().trim().min(1).nullable().default(null),
  bounds: mapBoundsSchema,
  crs: z.string().trim().min(1),
  minZoom: z.number().min(0).max(24).default(0),
  maxZoom: z.number().min(0).max(24).default(22),
  source: mapLayerSourceSchema,
  style: mapLayerStyleSchema,
  legend: mapLegendSchema.nullable().default(null),
  temporal: mapTemporalSchema.nullable().default(null),
  capabilities: mapLayerCapabilitiesSchema,
}).refine(draft => draft.minZoom <= draft.maxZoom, {
  message: '最小缩放级别不能大于最大缩放级别',
  path: ['minZoom'],
})

export const artifactDisplaySurfaceSchema = z.enum(['map', 'mini_app', 'download'])
export const artifactDisplaySchema = z.object({
  surfaces: z.array(artifactDisplaySurfaceSchema).min(1),
  primarySurface: artifactDisplaySurfaceSchema,
  map: mapLayerDraftSchema.nullable().default(null),
}).superRefine((display, context) => {
  if (!display.surfaces.includes(display.primarySurface)) {
    context.addIssue({ code: 'custom', path: ['primarySurface'], message: '主展示面必须包含在展示面列表中' })
  }
  if (display.surfaces.includes('map') !== Boolean(display.map)) {
    context.addIssue({ code: 'custom', path: ['map'], message: '地图展示面与地图图层定义必须同时存在' })
  }
})

export const artifactHttpMetadataSchema = z.object({
  artifactId: z.string().trim().min(1),
  artifactType: z.string().trim().min(1),
  name: z.string().trim().min(1),
  uri: z.string().trim().min(1),
  display: artifactDisplaySchema,
  metadata: z.record(z.string(), z.unknown()).prefault({}),
}).strict()

export const mapLayerManifestSchema = mapLayerDraftSchema.extend({
  mapLayerId: z.string().trim().min(1),
  ownershipScope: z.enum(['system', 'workspace', 'thread']),
  workspaceId: z.string().trim().min(1).nullable().default(null),
  threadId: z.string().trim().min(1).nullable().default(null),
  artifactId: z.string().trim().min(1).nullable().default(null),
  managedLayerKey: z.string().trim().min(1).nullable().default(null),
  status: z.enum(['processing', 'ready', 'failed', 'disabled']),
  errorMessage: z.string().trim().min(1).nullable().default(null),
  dataVersion: z.number().int().positive(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
}).superRefine((manifest, context) => {
  if (Boolean(manifest.artifactId) === Boolean(manifest.managedLayerKey)) {
    context.addIssue({
      code: 'custom',
      path: ['artifactId'],
      message: '地图图层必须且只能关联一个 Artifact 或托管图层',
    })
  }
  if (manifest.status === 'failed' && !manifest.errorMessage) {
    context.addIssue({ code: 'custom', path: ['errorMessage'], message: '失败图层必须包含错误原因' })
  }
  if (manifest.ownershipScope === 'system' && (manifest.workspaceId || manifest.threadId)) {
    context.addIssue({ code: 'custom', path: ['ownershipScope'], message: '系统图层不能绑定工作区或对话' })
  }
  if (manifest.ownershipScope === 'workspace' && (!manifest.workspaceId || manifest.threadId)) {
    context.addIssue({ code: 'custom', path: ['ownershipScope'], message: '工作区图层必须且只能绑定工作区' })
  }
  if (manifest.ownershipScope === 'thread' && (!manifest.workspaceId || !manifest.threadId)) {
    context.addIssue({ code: 'custom', path: ['ownershipScope'], message: '对话图层必须绑定工作区和对话' })
  }
})

export const mapSceneLayerSchema = z.object({
  mapLayerId: z.string().trim().min(1),
  order: z.number().int().nonnegative(),
  visible: z.boolean(),
  opacity: z.number().min(0).max(1),
  styleOverride: mapLayerStyleSchema.nullable().default(null),
  label: mapLayerLabelSchema.nullable().default(null),
  currentFrameId: z.string().trim().min(1).nullable().default(null),
})

export const mapSceneSchema = z.object({
  sceneId: z.string().trim().min(1),
  workspaceId: z.string().trim().min(1),
  threadId: z.string().trim().min(1),
  version: z.number().int().positive(),
  layers: z.array(mapSceneLayerSchema),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
}).superRefine((scene, context) => {
  const ids = new Set(scene.layers.map(layer => layer.mapLayerId))
  if (ids.size !== scene.layers.length) {
    context.addIssue({ code: 'custom', path: ['layers'], message: '场景不能重复引用同一图层' })
  }
})

export const mapSceneUpdateSchema = z.object({
  threadId: z.string().trim().min(1),
  expectedVersion: z.number().int().positive(),
  layers: z.array(mapSceneLayerSchema),
})

export const mapFeatureSchema = z.object({
  featureId: z.string().trim().min(1),
  geometry: z.record(z.string(), z.unknown()),
  properties: z.record(z.string(), z.unknown()),
})

export const mapFeaturePageSchema = z.object({
  mapLayerId: z.string().trim().min(1),
  items: z.array(mapFeatureSchema),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  total: z.number().int().nonnegative(),
})

export const mapTileJsonSchema = z.object({
  tilejson: z.literal('3.0.0'),
  name: z.string().trim().min(1),
  tiles: z.array(relativeResourceUrlSchema).min(1),
  minzoom: z.number().min(0).max(24),
  maxzoom: z.number().min(0).max(24),
  bounds: mapBoundsSchema,
  vector_layers: z.array(z.object({ id: z.string().trim().min(1) })).optional(),
})

export type MapBounds = z.infer<typeof mapBoundsSchema>
export type MapLayerSource = z.infer<typeof mapLayerSourceSchema>
export type MapLayerStyle = z.infer<typeof mapLayerStyleSchema>
export type MapLegend = z.infer<typeof mapLegendSchema>
export type MapTemporal = z.infer<typeof mapTemporalSchema>
export type MapLayerCapabilities = z.infer<typeof mapLayerCapabilitiesSchema>
export type MapLayerDraft = z.infer<typeof mapLayerDraftSchema>
export type ArtifactDisplay = z.infer<typeof artifactDisplaySchema>
export type ArtifactHttpMetadata = z.infer<typeof artifactHttpMetadataSchema>
export type MapLayerManifest = z.infer<typeof mapLayerManifestSchema>
export type MapLayerLabel = z.infer<typeof mapLayerLabelSchema>
export type MapSceneLayer = z.infer<typeof mapSceneLayerSchema>
export type MapScene = z.infer<typeof mapSceneSchema>
export type MapSceneUpdate = z.infer<typeof mapSceneUpdateSchema>
export type MapFeature = z.infer<typeof mapFeatureSchema>
export type MapFeaturePage = z.infer<typeof mapFeaturePageSchema>
export type MapTileJson = z.infer<typeof mapTileJsonSchema>
