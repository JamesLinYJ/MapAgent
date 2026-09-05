// +-------------------------------------------------------------------------
//
//   地理智能平台 - 地图图层仓储
//
//   文件:       mapLayerRepository.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { eq, inArray } from 'drizzle-orm'

import type { Database } from '../../db/connection.js'
import { platformArtifacts, platformMapLayers } from '../../db/schema.js'
import { mapLayerManifestSchema, type MapLayerManifest } from '../../schemas/types.js'

export interface MapResourceScope {
  workspaceId: string | null
  threadId: string | null
  createdByUserId: string | null
  visibility: string
  resourceId: string
  system: boolean
}

export interface MapTileExecutionSpec {
  manifest: MapLayerManifest
  artifactRelativePath: string | null
}

/** 地图图层展示契约、所有权和瓦片执行引用的读取边界。 */
export class MapLayerRepository {
  constructor(private readonly db: Database) {}

  async getLayerScope(mapLayerId: string): Promise<MapResourceScope | null> {
    const rows = await this.db.select({
      workspaceId: platformMapLayers.workspaceId,
      threadId: platformMapLayers.threadId,
      createdByUserId: platformMapLayers.createdByUserId,
      visibility: platformMapLayers.visibility,
      ownershipScope: platformMapLayers.ownershipScope,
    }).from(platformMapLayers)
      .where(eq(platformMapLayers.mapLayerId, mapLayerId))
      .limit(1)
    const row = rows[0]
    return row ? {
      workspaceId: row.workspaceId,
      threadId: row.threadId,
      createdByUserId: row.createdByUserId,
      visibility: row.visibility,
      resourceId: mapLayerId,
      system: row.ownershipScope === 'system',
    } : null
  }

  async getManifest(mapLayerId: string): Promise<MapLayerManifest | null> {
    const rows = await this.db.select().from(platformMapLayers)
      .where(eq(platformMapLayers.mapLayerId, mapLayerId))
      .limit(1)
    const row = rows[0]
    return row ? mapManifestRow(row) : null
  }

  async getManifests(mapLayerIds: string[]): Promise<MapLayerManifest[]> {
    if (mapLayerIds.length === 0) return []
    const rows = await this.db.select().from(platformMapLayers)
      .where(inArray(platformMapLayers.mapLayerId, mapLayerIds))
    return rows.map(mapManifestRow)
  }

  async getTileExecutionSpec(mapLayerId: string): Promise<MapTileExecutionSpec | null> {
    const rows = await this.db.select({
      layer: platformMapLayers,
      artifactRelativePath: platformArtifacts.contentRelativePath,
    }).from(platformMapLayers)
      .leftJoin(platformArtifacts, eq(platformArtifacts.artifactId, platformMapLayers.artifactId))
      .where(eq(platformMapLayers.mapLayerId, mapLayerId))
      .limit(1)
    const row = rows[0]
    return row ? {
      manifest: mapManifestRow(row.layer),
      artifactRelativePath: row.artifactRelativePath,
    } : null
  }
}

function mapManifestRow(row: typeof platformMapLayers.$inferSelect): MapLayerManifest {
  return mapLayerManifestSchema.parse({
    mapLayerId: row.mapLayerId,
    ownershipScope: row.ownershipScope,
    workspaceId: row.workspaceId,
    threadId: row.threadId,
    artifactId: row.artifactId,
    managedLayerKey: row.managedLayerKey,
    title: row.title,
    replacementGroup: row.replacementGroup,
    status: row.status,
    errorMessage: row.errorMessage,
    bounds: row.boundsJson,
    crs: row.crs,
    minZoom: row.minZoom,
    maxZoom: row.maxZoom,
    source: row.sourceJson,
    style: row.styleJson,
    legend: row.legendJson,
    temporal: row.temporalJson,
    capabilities: row.capabilitiesJson,
    dataVersion: row.dataVersion,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  })
}
