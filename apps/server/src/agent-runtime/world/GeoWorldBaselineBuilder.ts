// +-------------------------------------------------------------------------
//
//   地理智能平台 - 现有 GIS 事实到 GeoWorld baseline
//
//   文件:       GeoWorldBaselineBuilder.ts
//
//   日期:       2026年08月20日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm'
import {
  GEO_WORLD_SCHEMA_VERSION,
  geoTimeExtentSchema,
  geoWorldStateSchema,
  type GeoWorldCapabilities,
  type GeoWorldDatasetSnapshot,
  type GeoWorldLayerSnapshot,
  type GeoWorldState,
} from '@geo-agent-platform/shared-types/geo-world'
import { runDomainSnapshotSchema } from '@geo-agent-platform/shared-types/run-domain'
import { mapBoundsSchema } from '@geo-agent-platform/shared-types/map'

import type { Database } from '../../db/connection.js'
import {
  platformArtifacts,
  platformFileObjects,
  platformMapLayers,
  platformMapSceneLayers,
  platformMapScenes,
  platformMeteorologicalDatasets,
  platformRuns,
  platformRunSnapshots,
} from '../../db/schema.js'
import { isRecord, stableJson } from '../../framework/schema.js'
import { agentContextDigest } from '../step/agentContextDigest.js'

export class GeoWorldBaselineBuilder {
  constructor(private readonly db: Database) {}

  async build(runId: string, capabilities: GeoWorldCapabilities): Promise<GeoWorldState> {
    const runRows = await this.db.select({
      run: platformRuns,
      snapshot: platformRunSnapshots,
    }).from(platformRuns)
      .leftJoin(platformRunSnapshots, eq(platformRunSnapshots.runId, platformRuns.runId))
      .where(eq(platformRuns.runId, runId))
      .limit(1)
    const record = runRows[0]
    if (!record) throw new Error(`运行 '${runId}' 不存在`)
    const run = record.run
    if (!record.snapshot) throw new Error(`运行 '${runId}' 缺少权威 snapshot`)
    if (!run.workspaceId) throw new Error(`运行 '${runId}' 缺少 workspaceId，不能建立 GeoWorld`)
    if (!run.threadId) throw new Error(`运行 '${runId}' 缺少 threadId，不能建立 GeoWorld`)
    const state = runDomainSnapshotSchema.parse(record.snapshot.stateJson).state

    const [layerRows, datasetRows, fileRows] = await Promise.all([
      this.db.select({
        layer: platformMapLayers,
        sceneLayer: platformMapSceneLayers,
        artifactMetadata: platformArtifacts.metadataJson,
      }).from(platformMapScenes)
        .innerJoin(platformMapSceneLayers, eq(platformMapSceneLayers.sceneId, platformMapScenes.sceneId))
        .innerJoin(platformMapLayers, eq(platformMapLayers.mapLayerId, platformMapSceneLayers.mapLayerId))
        .leftJoin(platformArtifacts, eq(platformArtifacts.artifactId, platformMapLayers.artifactId))
        .where(eq(platformMapScenes.threadId, run.threadId))
        .orderBy(asc(platformMapSceneLayers.layerOrder)),
      this.db.select().from(platformMeteorologicalDatasets)
        .where(and(
          eq(platformMeteorologicalDatasets.sessionId, run.sessionId),
          eq(platformMeteorologicalDatasets.status, 'ready'),
          or(
            eq(platformMeteorologicalDatasets.threadId, run.threadId),
            isNull(platformMeteorologicalDatasets.threadId),
          ),
        ))
        .orderBy(asc(platformMeteorologicalDatasets.createdAt)),
      this.db.select().from(platformFileObjects)
        .where(and(
          eq(platformFileObjects.threadId, run.threadId),
          inArray(platformFileObjects.status, ['ready', 'deleted']),
        ))
        .orderBy(asc(platformFileObjects.createdAt)),
    ])

    const layers = layerRows.map(row => layerSnapshot(row.layer, row.artifactMetadata))
    const datasets = datasetRows.map(datasetSnapshot)
    const selectedLayerIds = layerRows
      .filter(row => row.sceneLayer.visible)
      .map(row => row.layer.mapLayerId)
    const provenance = state.toolResults.flatMap(result => {
      if (!result.resultId || result.objectiveRevision === undefined || !Object.keys(result.provenance).length) return []
      return [{
        provenanceId: `provenance_${agentContextDigest({
          resultId: result.resultId,
          objectiveRevision: result.objectiveRevision,
          data: result.provenance,
        }).slice('sha256:'.length, 'sha256:'.length + 32)}`,
        sourceResultId: result.resultId,
        objectiveRevision: result.objectiveRevision,
        data: structuredClone(result.provenance),
      }]
    })

    return geoWorldStateSchema.parse({
      schemaVersion: GEO_WORLD_SCHEMA_VERSION,
      revision: 1,
      workspaceId: run.workspaceId,
      map: {
        displayCrs: 'EPSG:3857',
        viewport: null,
        selectedLayerIds,
        selectedFeatureRefs: [],
        timeRange: null,
      },
      layers,
      datasets,
      files: fileRows.map(row => ({
        fileId: row.fileId,
        contentHash: row.contentHash,
        mediaType: row.mediaType,
        status: row.status,
      })),
      artifacts: state.artifacts,
      values: state.toolValueRefs,
      provenance,
      capabilities,
    })
  }
}

function layerSnapshot(
  row: typeof platformMapLayers.$inferSelect,
  artifactMetadata: unknown,
): GeoWorldLayerSnapshot {
  const sourceRef = row.artifactId
    ? `artifact:${row.artifactId}`
    : row.managedLayerKey
      ? `managed:${row.managedLayerKey}`
      : `source:${agentContextDigest(row.sourceJson)}`
  const schemaHash = row.propertySchemaJson.length
    ? agentContextDigest(row.propertySchemaJson)
    : null
  const styleRevision = agentContextDigest(row.styleJson)
  const contentHash = explicitString(artifactMetadata, 'contentHash')
    ?? explicitString(row.sourceJson, 'contentHash')
  const revision = agentContextDigest({
    layerId: row.mapLayerId,
    dataVersion: row.dataVersion,
    sourceRef,
    schemaHash,
    contentHash,
    crs: row.crs,
    geometryType: row.geometryType,
    featureCount: row.featureCount,
    extent: row.boundsJson,
    styleRevision,
  })
  return {
    layerId: row.mapLayerId,
    revision,
    sourceRef,
    schemaHash,
    contentHash,
    crs: row.crs,
    geometryType: row.geometryType === 'unknown' ? null : row.geometryType,
    featureCount: row.featureCount,
    extent: mapBoundsSchema.parse(row.boundsJson),
    styleRevision,
  }
}

function datasetSnapshot(
  row: typeof platformMeteorologicalDatasets.$inferSelect,
): GeoWorldDatasetSnapshot {
  const contentHash = row.contentHash?.trim()
  if (!contentHash) {
    throw new Error(`ready 数据集 '${row.datasetId}' 缺少 contentHash，不能进入 GeoWorld`)
  }
  const metadata = row.metadataJson
  const schemaHash = explicitString(metadata, 'schemaHash')
  const temporalExtent = parseTimeExtent(metadata.temporalExtent)
  const spatialExtent = parseBounds(metadata.spatialExtent ?? metadata.bounds ?? metadata.bbox)
  return {
    datasetId: row.datasetId,
    revision: agentContextDigest({
      datasetId: row.datasetId,
      contentHash,
      schemaHash,
      temporalExtent,
      spatialExtent,
      metadata: stableJson(metadata),
    }),
    contentHash,
    schemaHash,
    temporalExtent,
    spatialExtent,
  }
}

function parseTimeExtent(value: unknown): GeoWorldDatasetSnapshot['temporalExtent'] {
  const parsed = geoTimeExtentSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

function parseBounds(value: unknown): GeoWorldDatasetSnapshot['spatialExtent'] {
  const parsed = mapBoundsSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

function explicitString(record: unknown, key: string): string | null {
  if (!isRecord(record)) return null
  const value = record[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}
