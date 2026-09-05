// +-------------------------------------------------------------------------
//
//   地理智能平台 - GIS 世界状态、Patch 与 Diff 契约
//
//   文件:       geoWorld.ts
//
//   日期:       2026年08月20日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { z } from 'zod'

import { artifactRefSchema, toolValueRefSchema } from './core.js'
import { mapBoundsSchema } from './map.js'

export const GEO_WORLD_SCHEMA_VERSION = 1 as const

export const geoTimeExtentSchema = z.object({
  start: z.string().datetime({ offset: true }),
  end: z.string().datetime({ offset: true }),
}).strict().refine(value => value.start <= value.end, {
  message: '时间范围必须满足 start <= end',
})

export const geoWorldLayerSnapshotSchema = z.object({
  layerId: z.string().trim().min(1),
  revision: z.string().trim().min(1),
  sourceRef: z.string().trim().min(1),
  schemaHash: z.string().trim().min(1).nullable(),
  contentHash: z.string().trim().min(1).nullable(),
  crs: z.string().trim().min(1),
  geometryType: z.string().trim().min(1).nullable(),
  featureCount: z.number().int().nonnegative().nullable(),
  extent: mapBoundsSchema.nullable(),
  styleRevision: z.string().trim().min(1).nullable(),
}).strict()

export const geoWorldDatasetSnapshotSchema = z.object({
  datasetId: z.string().trim().min(1),
  revision: z.string().trim().min(1),
  contentHash: z.string().trim().min(1),
  schemaHash: z.string().trim().min(1).nullable(),
  temporalExtent: geoTimeExtentSchema.nullable(),
  spatialExtent: mapBoundsSchema.nullable(),
}).strict()

export const geoWorldFileSnapshotSchema = z.object({
  fileId: z.string().trim().min(1),
  contentHash: z.string().trim().min(1),
  mediaType: z.string().trim().min(1),
  status: z.enum(['ready', 'deleted']),
}).strict()

export const geoWorldProvenanceRefSchema = z.object({
  provenanceId: z.string().trim().min(1),
  sourceResultId: z.string().trim().min(1),
  objectiveRevision: z.number().int().positive(),
  data: z.record(z.string(), z.unknown()),
}).strict()

export const geoWorldCapabilitiesSchema = z.object({
  toolNames: z.array(z.string().trim().min(1)),
  mcpServerNames: z.array(z.string().trim().min(1)),
  sandboxBackend: z.string().trim().min(1),
  writableRoots: z.array(z.string().trim().min(1)),
  networkPolicy: z.string().trim().min(1),
}).strict()

export const geoWorldStateSchema = z.object({
  schemaVersion: z.literal(GEO_WORLD_SCHEMA_VERSION),
  revision: z.number().int().positive(),
  workspaceId: z.string().trim().min(1),
  map: z.object({
    displayCrs: z.string().trim().min(1),
    viewport: mapBoundsSchema.nullable(),
    selectedLayerIds: z.array(z.string().trim().min(1)),
    selectedFeatureRefs: z.array(z.string().trim().min(1)),
    timeRange: geoTimeExtentSchema.nullable(),
  }).strict(),
  layers: z.array(geoWorldLayerSnapshotSchema),
  datasets: z.array(geoWorldDatasetSnapshotSchema),
  files: z.array(geoWorldFileSnapshotSchema),
  artifacts: z.array(artifactRefSchema),
  values: z.array(toolValueRefSchema),
  provenance: z.array(geoWorldProvenanceRefSchema),
  capabilities: geoWorldCapabilitiesSchema,
}).strict().superRefine((world, context) => {
  assertUniqueIds(world.layers.map(value => value.layerId), 'layerId', ['layers'], context)
  assertUniqueIds(world.datasets.map(value => value.datasetId), 'datasetId', ['datasets'], context)
  assertUniqueIds(world.files.map(value => value.fileId), 'fileId', ['files'], context)
  assertUniqueIds(world.artifacts.map(value => value.artifactId), 'artifactId', ['artifacts'], context)
  assertUniqueIds(world.values.map(value => value.refId), 'refId', ['values'], context)
  assertUniqueIds(world.provenance.map(value => value.provenanceId), 'provenanceId', ['provenance'], context)
  const layerIds = new Set(world.layers.map(value => value.layerId))
  for (const [index, layerId] of world.map.selectedLayerIds.entries()) {
    if (!layerIds.has(layerId)) {
      context.addIssue({
        code: 'custom',
        path: ['map', 'selectedLayerIds', index],
        message: `选中图层 '${layerId}' 不存在于世界快照`,
      })
    }
  }
})

export const geoWorldPatchSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('layer.added'),
    layer: geoWorldLayerSnapshotSchema,
  }).strict(),
  z.object({
    type: z.literal('layer.updated'),
    layerId: z.string().trim().min(1),
    expectedRevision: z.string().trim().min(1),
    next: geoWorldLayerSnapshotSchema,
  }).strict(),
  z.object({
    type: z.literal('layer.removed'),
    layerId: z.string().trim().min(1),
    expectedRevision: z.string().trim().min(1),
  }).strict(),
  z.object({
    type: z.literal('dataset.registered'),
    dataset: geoWorldDatasetSnapshotSchema,
  }).strict(),
  z.object({
    type: z.literal('map.selection_changed'),
    selectedLayerIds: z.array(z.string().trim().min(1)),
  }).strict(),
  z.object({
    type: z.literal('artifact.created'),
    artifact: artifactRefSchema,
  }).strict(),
  z.object({
    type: z.literal('value.created'),
    value: toolValueRefSchema,
  }).strict(),
  z.object({
    type: z.literal('capabilities.changed'),
    expected: geoWorldCapabilitiesSchema,
    next: geoWorldCapabilitiesSchema,
  }).strict(),
])

export const geoWorldDiffSchema = z.object({
  diffId: z.string().trim().min(1),
  runId: z.string().trim().min(1),
  fromWorldRevision: z.number().int().positive(),
  toWorldRevision: z.number().int().positive(),
  patches: z.array(geoWorldPatchSchema).min(1),
  changedLayerIds: z.array(z.string().trim().min(1)),
  changedDatasetIds: z.array(z.string().trim().min(1)),
  createdArtifactIds: z.array(z.string().trim().min(1)),
  createdValueRefIds: z.array(z.string().trim().min(1)),
  permissionsChanged: z.boolean(),
  capabilitiesChanged: z.boolean(),
  createdAt: z.string().datetime({ offset: true }),
}).strict().superRefine((diff, context) => {
  if (diff.toWorldRevision !== diff.fromWorldRevision + 1) {
    context.addIssue({
      code: 'custom',
      path: ['toWorldRevision'],
      message: 'GeoWorld diff 必须恰好推进一个 revision',
    })
  }
})

export type GeoWorldLayerSnapshot = z.infer<typeof geoWorldLayerSnapshotSchema>
export type GeoWorldDatasetSnapshot = z.infer<typeof geoWorldDatasetSnapshotSchema>
export type GeoWorldFileSnapshot = z.infer<typeof geoWorldFileSnapshotSchema>
export type GeoWorldProvenanceRef = z.infer<typeof geoWorldProvenanceRefSchema>
export type GeoWorldCapabilities = z.infer<typeof geoWorldCapabilitiesSchema>
export type GeoWorldState = z.infer<typeof geoWorldStateSchema>
export type GeoWorldPatch = z.infer<typeof geoWorldPatchSchema>
export type GeoWorldDiff = z.infer<typeof geoWorldDiffSchema>

export function applyGeoWorldPatches(
  current: GeoWorldState,
  rawPatches: readonly GeoWorldPatch[],
): GeoWorldState {
  const world = geoWorldStateSchema.parse(structuredClone(current))
  if (!rawPatches.length) throw new Error('GeoWorld patch 集合不能为空')
  const patches = rawPatches.map(patch => geoWorldPatchSchema.parse(patch))
  const next = structuredClone(world)

  for (const patch of patches) {
    switch (patch.type) {
      case 'layer.added': {
        if (next.layers.some(layer => layer.layerId === patch.layer.layerId)) {
          throw new Error(`图层 '${patch.layer.layerId}' 已存在，不能重复添加`)
        }
        next.layers.push(structuredClone(patch.layer))
        break
      }
      case 'layer.updated': {
        const index = next.layers.findIndex(layer => layer.layerId === patch.layerId)
        const layer = next.layers[index]
        if (!layer) throw new Error(`图层 '${patch.layerId}' 不存在，不能更新`)
        if (layer.revision !== patch.expectedRevision) {
          throw new Error(
            `图层 '${patch.layerId}' revision 冲突：`
            + `期望 ${patch.expectedRevision}，实际 ${layer.revision}`,
          )
        }
        if (patch.next.layerId !== patch.layerId) {
          throw new Error(`图层 '${patch.layerId}' 更新不能改变 layerId`)
        }
        if (patch.next.revision === patch.expectedRevision) {
          throw new Error(`图层 '${patch.layerId}' 更新必须产生新的 revision`)
        }
        next.layers[index] = structuredClone(patch.next)
        break
      }
      case 'layer.removed': {
        const index = next.layers.findIndex(layer => layer.layerId === patch.layerId)
        const layer = next.layers[index]
        if (!layer) throw new Error(`图层 '${patch.layerId}' 不存在，不能移除`)
        if (layer.revision !== patch.expectedRevision) {
          throw new Error(
            `图层 '${patch.layerId}' revision 冲突：`
            + `期望 ${patch.expectedRevision}，实际 ${layer.revision}`,
          )
        }
        next.layers.splice(index, 1)
        next.map.selectedLayerIds = next.map.selectedLayerIds.filter(layerId => layerId !== patch.layerId)
        break
      }
      case 'dataset.registered':
        if (next.datasets.some(dataset => dataset.datasetId === patch.dataset.datasetId)) {
          throw new Error(`数据集 '${patch.dataset.datasetId}' 已注册`)
        }
        next.datasets.push(structuredClone(patch.dataset))
        break
      case 'map.selection_changed': {
        const available = new Set(next.layers.map(layer => layer.layerId))
        for (const layerId of patch.selectedLayerIds) {
          if (!available.has(layerId)) throw new Error(`地图选择引用了不存在的图层 '${layerId}'`)
        }
        next.map.selectedLayerIds = [...patch.selectedLayerIds]
        break
      }
      case 'artifact.created':
        if (next.artifacts.some(artifact => artifact.artifactId === patch.artifact.artifactId)) {
          throw new Error(`Artifact '${patch.artifact.artifactId}' 已存在`)
        }
        next.artifacts.push(structuredClone(patch.artifact))
        break
      case 'value.created':
        if (next.values.some(value => value.refId === patch.value.refId)) {
          throw new Error(`ValueRef '${patch.value.refId}' 已存在`)
        }
        next.values.push(structuredClone(patch.value))
        break
      case 'capabilities.changed':
        if (!sameJson(next.capabilities, patch.expected)) {
          throw new Error('GeoWorld capabilities 已变更，不能用过期快照覆盖')
        }
        if (sameJson(patch.expected, patch.next)) {
          throw new Error('GeoWorld capabilities patch 必须产生实际变化')
        }
        next.capabilities = structuredClone(patch.next)
        break
    }
  }

  next.revision = world.revision + 1
  return geoWorldStateSchema.parse(next)
}

export function createGeoWorldDiff(input: {
  diffId: string
  runId: string
  current: GeoWorldState
  patches: readonly GeoWorldPatch[]
  createdAt: string
}): { state: GeoWorldState; diff: GeoWorldDiff } {
  const current = geoWorldStateSchema.parse(input.current)
  const patches = input.patches.map(patch => geoWorldPatchSchema.parse(patch))
  const state = applyGeoWorldPatches(current, patches)
  const changedLayerIds = new Set<string>()
  const changedDatasetIds = new Set<string>()
  const createdArtifactIds = new Set<string>()
  const createdValueRefIds = new Set<string>()
  for (const patch of patches) {
    if (patch.type === 'layer.added') changedLayerIds.add(patch.layer.layerId)
    if (patch.type === 'layer.updated' || patch.type === 'layer.removed') changedLayerIds.add(patch.layerId)
    if (patch.type === 'dataset.registered') changedDatasetIds.add(patch.dataset.datasetId)
    if (patch.type === 'artifact.created') createdArtifactIds.add(patch.artifact.artifactId)
    if (patch.type === 'value.created') createdValueRefIds.add(patch.value.refId)
  }
  const diff = geoWorldDiffSchema.parse({
    diffId: input.diffId,
    runId: input.runId,
    fromWorldRevision: current.revision,
    toWorldRevision: state.revision,
    patches,
    changedLayerIds: [...changedLayerIds].sort(),
    changedDatasetIds: [...changedDatasetIds].sort(),
    createdArtifactIds: [...createdArtifactIds].sort(),
    createdValueRefIds: [...createdValueRefIds].sort(),
    permissionsChanged: false,
    capabilitiesChanged: patches.some(patch => patch.type === 'capabilities.changed'),
    createdAt: input.createdAt,
  })
  return { state, diff }
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function replayGeoWorldDiff(current: GeoWorldState, rawDiff: GeoWorldDiff): GeoWorldState {
  const world = geoWorldStateSchema.parse(current)
  const diff = geoWorldDiffSchema.parse(rawDiff)
  if (world.revision !== diff.fromWorldRevision) {
    throw new Error(
      `GeoWorld diff '${diff.diffId}' revision 不连续：`
      + `当前 ${world.revision}，diff 从 ${diff.fromWorldRevision} 开始`,
    )
  }
  const next = applyGeoWorldPatches(world, diff.patches)
  if (next.revision !== diff.toWorldRevision) {
    throw new Error(`GeoWorld diff '${diff.diffId}' 回放后 revision 不一致`)
  }
  return next
}

function assertUniqueIds(
  values: readonly string[],
  label: string,
  path: Array<string | number>,
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>()
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) {
      context.addIssue({ code: 'custom', path: [...path, index, label], message: `${label} 不能重复` })
    }
    seen.add(value)
  }
}
