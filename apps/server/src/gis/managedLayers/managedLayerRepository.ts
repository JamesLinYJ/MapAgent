// +-------------------------------------------------------------------------
//
//   地理智能平台 - 托管图层元数据仓储
//
//   文件:       managedLayerRepository.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
//
//   维护记录 (2026-08-30):
//     作者: JamesLinYJ
//     协助: OpenAI Codex:GPT-5.6 Sol
//     说明: 相同导入指纹不再更新图层或递增数据版本，避免每次服务启动制造虚假世界状态变化。
// --------------------------------------------------------------------------

import { and,desc,eq,ilike,isNull,or,sql } from 'drizzle-orm'

import type { Database,DatabaseTransaction } from '../../db/connection.js'
import { platformMapLayers } from '../../db/schema.js'
import {
layerDescriptorSchema,
layerPropertyDescriptorSchema,
resourceVisibilitySchema,
type LayerDescriptor,
} from '../../schemas/types.js'
import { managedLayerImportFingerprint } from './managedLayerGeometry.js'
import type {
LayerMetadataPatch,
ManagedLayerImportPersistence,
PreparedManagedLayerImport,
} from './managedLayerTypes.js'

interface LegacyImportCandidate {
  mapLayerId: string
  metadataEquivalent: boolean
}

/** 托管图层元数据、归属和能力描述的唯一写入边界。 */
export class ManagedLayerRepository {
  constructor(private readonly db: Database) {}

  async listVisibleLayers(
    workspaceId: string,
    sessionId?: string | null,
    threadId?: string | null,
  ): Promise<LayerDescriptor[]> {
    const ownership = or(
      eq(platformMapLayers.ownershipScope, 'system'),
      eq(platformMapLayers.workspaceId, workspaceId),
    )
    const location = threadId
      ? or(
          eq(platformMapLayers.ownershipScope, 'system'),
          eq(platformMapLayers.threadId, threadId),
          and(eq(platformMapLayers.ownershipScope, 'workspace'), eq(platformMapLayers.workspaceId, workspaceId)),
          ...(sessionId ? [eq(platformMapLayers.sessionId, sessionId)] : []),
        )
      : sessionId
        ? or(
            eq(platformMapLayers.ownershipScope, 'system'),
            and(eq(platformMapLayers.ownershipScope, 'workspace'), eq(platformMapLayers.workspaceId, workspaceId)),
            eq(platformMapLayers.sessionId, sessionId),
          )
        : ownership
    const rows = await this.db.select().from(platformMapLayers)
      .where(and(
        isNull(platformMapLayers.artifactId),
        ownership,
        location,
      ))
      .orderBy(desc(platformMapLayers.updatedAt))
    return rows.map(mapRowToLayerDescriptor)
  }

  async getLayer(layerKey: string): Promise<LayerDescriptor | null> {
    const rows = await this.db.select().from(platformMapLayers)
      .where(eq(platformMapLayers.managedLayerKey, layerKey)).limit(1)
    const row = rows[0]
    return row ? mapRowToLayerDescriptor(row) : null
  }

  async geocode(query: string): Promise<Array<{ label: string; longitude: number; latitude: number }>> {
    const rows = await this.db.select({
      name: platformMapLayers.title,
      bounds: platformMapLayers.boundsJson,
    }).from(platformMapLayers)
      .where(and(
        isNull(platformMapLayers.artifactId),
        ilike(platformMapLayers.title, `%${query}%`),
      ))
      .limit(10)
    return rows.map(row => ({
      label: row.name,
      longitude: (row.bounds[0] + row.bounds[2]) / 2,
      latitude: (row.bounds[1] + row.bounds[3]) / 2,
    }))
  }

  async upsertImportedLayer(
    tx: DatabaseTransaction,
    prepared: PreparedManagedLayerImport,
    now: Date,
  ): Promise<boolean> {
    const persistence = prepared.persistence
    const sourceJson = importedLayerSource(prepared)
    const changedRows = await tx.insert(platformMapLayers).values({
      mapLayerId: prepared.mapLayerId,
      ownershipScope: persistence.ownershipScope,
      workspaceId: persistence.workspaceId,
      threadId: persistence.threadId,
      artifactId: null,
      managedLayerKey: prepared.layerKey,
      title: persistence.title,
      sourceType: persistence.sourceType,
      geometryType: persistence.geometryType,
      srid: persistence.srid,
      description: persistence.description,
      featureCount: persistence.featureCount,
      propertySchemaJson: persistence.propertySchema,
      category: persistence.category,
      tagsJson: persistence.tags,
      analysisCapabilitiesJson: persistence.analysisCapabilities,
      sourceConfigSummary: persistence.sourceConfigSummary,
      sessionId: persistence.sessionId,
      createdByUserId: persistence.createdByUserId,
      visibility: persistence.visibility,
      readonly: persistence.readonly,
      status: persistence.status,
      errorMessage: persistence.errorMessage,
      boundsJson: persistence.bounds,
      crs: persistence.crs,
      minZoom: persistence.minZoom,
      maxZoom: persistence.maxZoom,
      sourceJson,
      styleJson: persistence.style,
      legendJson: persistence.legend,
      temporalJson: persistence.temporal,
      capabilitiesJson: persistence.capabilities,
      dataVersion: 1,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: platformMapLayers.managedLayerKey,
      set: {
        ownershipScope: persistence.ownershipScope,
        workspaceId: persistence.workspaceId,
        threadId: persistence.threadId,
        title: persistence.title,
        sourceType: persistence.sourceType,
        geometryType: persistence.geometryType,
        srid: persistence.srid,
        description: persistence.description,
        featureCount: persistence.featureCount,
        propertySchemaJson: persistence.propertySchema,
        category: persistence.category,
        tagsJson: persistence.tags,
        analysisCapabilitiesJson: persistence.analysisCapabilities,
        sourceConfigSummary: persistence.sourceConfigSummary,
        sessionId: persistence.sessionId,
        createdByUserId: persistence.createdByUserId,
        visibility: persistence.visibility,
        readonly: persistence.readonly,
        status: persistence.status,
        errorMessage: persistence.errorMessage,
        boundsJson: persistence.bounds,
        crs: persistence.crs,
        minZoom: persistence.minZoom,
        maxZoom: persistence.maxZoom,
        sourceJson,
        styleJson: persistence.style,
        legendJson: persistence.legend,
        temporalJson: persistence.temporal,
        capabilitiesJson: persistence.capabilities,
        dataVersion: sql`${platformMapLayers.dataVersion} + 1`,
        updatedAt: sql`GREATEST(${platformMapLayers.updatedAt}, clock_timestamp())`,
      },
      setWhere: sql`${platformMapLayers.sourceJson}->>'importFingerprint'
        IS DISTINCT FROM ${prepared.importFingerprint}`,
    }).returning({ mapLayerId: platformMapLayers.mapLayerId })
    return changedRows.length > 0
  }

  async lockLegacySystemImportCandidate(
    tx: DatabaseTransaction,
    prepared: PreparedManagedLayerImport,
  ): Promise<LegacyImportCandidate | null> {
    if (prepared.persistence.sourceType !== 'system') return null
    const rows = await tx.select().from(platformMapLayers).where(and(
      eq(platformMapLayers.managedLayerKey, prepared.layerKey),
      eq(platformMapLayers.sourceType, 'system'),
      sql`${platformMapLayers.sourceJson}->>'importFingerprint' IS NULL`,
    )).for('update').limit(1)
    const row = rows[0]
    if (!row) return null
    const persistence = legacyImportPersistence(row, prepared.contentHash)
    return {
      mapLayerId: row.mapLayerId,
      metadataEquivalent: persistence !== null
        && managedLayerImportFingerprint(persistence) === prepared.importFingerprint,
    }
  }

  async backfillLegacyImportFingerprint(
    tx: DatabaseTransaction,
    prepared: PreparedManagedLayerImport,
  ): Promise<boolean> {
    const updated = await tx.update(platformMapLayers).set({
      sourceJson: sql`${platformMapLayers.sourceJson} || ${JSON.stringify({
        fingerprintSchemaVersion: prepared.persistence.fingerprintSchemaVersion,
        importFingerprint: prepared.importFingerprint,
      })}::jsonb`,
    }).where(and(
      eq(platformMapLayers.managedLayerKey, prepared.layerKey),
      sql`${platformMapLayers.sourceJson}->>'importFingerprint' IS NULL`,
    )).returning({ mapLayerId: platformMapLayers.mapLayerId })
    return updated.length > 0
  }

  async updateLayerMetadata(layerKey: string, patch: LayerMetadataPatch): Promise<LayerDescriptor> {
    const layer = await this.getLayer(layerKey)
    if (!layer) throw new Error(`图层 '${layerKey}' 不存在`)
    await this.db.update(platformMapLayers).set({
      title: patch.name ?? layer.name,
      description: patch.description ?? layer.description,
      tagsJson: patch.tags ?? layer.tags,
      category: patch.category ?? layer.category,
      status: patch.status === 'disabled' ? 'disabled' : 'ready',
      analysisCapabilitiesJson: patch.analysisCapabilities ?? layer.analysisCapabilities,
      sourceConfigSummary: patch.sourceConfigSummary === undefined
        ? layer.sourceConfigSummary
        : patch.sourceConfigSummary,
      updatedAt: new Date(),
    }).where(eq(platformMapLayers.managedLayerKey, layerKey))
    const updated = await this.getLayer(layerKey)
    if (!updated) throw new Error(`图层 '${layerKey}' 更新后无法读取`)
    return updated
  }

  async deleteLayer(layerKey: string): Promise<boolean> {
    const deleted = await this.db.delete(platformMapLayers)
      .where(eq(platformMapLayers.managedLayerKey, layerKey))
      .returning({ mapLayerId: platformMapLayers.mapLayerId })
    return deleted.length > 0
  }

  async requireManagedMapLayerId(layerKey: string): Promise<string> {
    const rows = await this.db.select({ mapLayerId: platformMapLayers.mapLayerId })
      .from(platformMapLayers)
      .where(eq(platformMapLayers.managedLayerKey, layerKey)).limit(1)
    const mapLayerId = rows[0]?.mapLayerId
    if (!mapLayerId) throw new Error(`图层 '${layerKey}' 不存在`)
    return mapLayerId
  }
}

function importedLayerSource(prepared: PreparedManagedLayerImport): Record<string, unknown> {
  return {
    ...prepared.persistence.source,
    fingerprintSchemaVersion: prepared.persistence.fingerprintSchemaVersion,
    importFingerprint: prepared.importFingerprint,
  }
}

function legacyImportPersistence(
  row: typeof platformMapLayers.$inferSelect,
  assumedContentHash: string,
): ManagedLayerImportPersistence | null {
  const visibility = resourceVisibilitySchema.safeParse(row.visibility)
  const propertySchema = layerPropertyDescriptorSchema.array().safeParse(row.propertySchemaJson)
  const source = row.sourceJson
  if (
    !visibility.success
    || !propertySchema.success
    || (row.ownershipScope !== 'system' && row.ownershipScope !== 'workspace' && row.ownershipScope !== 'thread')
    || (row.status !== 'ready' && row.status !== 'disabled')
    || row.srid !== 4326
    || row.crs !== 'EPSG:4326'
    || row.minZoom !== 0
    || row.maxZoom !== 22
    || row.featureCount === null
    || row.errorMessage !== null
    || row.legendJson !== null
    || row.temporalJson !== null
    || typeof source.kind !== 'string'
    || typeof source.tileJsonUrl !== 'string'
    || typeof source.sourceLayer !== 'string'
    || source.kind !== 'vector_tiles'
    || source.sourceLayer !== 'features'
  ) return null
  return {
    fingerprintSchemaVersion: 1,
    ownershipScope: row.ownershipScope,
    workspaceId: row.workspaceId,
    threadId: row.threadId,
    title: row.title,
    sourceType: row.sourceType,
    geometryType: row.geometryType,
    srid: 4326,
    description: row.description,
    featureCount: row.featureCount,
    propertySchema: [...propertySchema.data].sort((left, right) => (
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    )),
    category: row.category,
    tags: row.tagsJson,
    analysisCapabilities: row.analysisCapabilitiesJson,
    sourceConfigSummary: row.sourceConfigSummary,
    sessionId: row.sessionId,
    createdByUserId: row.createdByUserId,
    visibility: visibility.data,
    readonly: row.readonly,
    status: row.status,
    errorMessage: null,
    bounds: row.boundsJson,
    crs: 'EPSG:4326',
    minZoom: 0,
    maxZoom: 22,
    source: {
      kind: 'vector_tiles',
      tileJsonUrl: source.tileJsonUrl,
      sourceLayer: 'features',
      contentHash: assumedContentHash,
    },
    style: row.styleJson,
    legend: null,
    temporal: null,
    capabilities: row.capabilitiesJson,
  }
}

function mapRowToLayerDescriptor(row: typeof platformMapLayers.$inferSelect): LayerDescriptor {
  return layerDescriptorSchema.parse({
    mapLayerId: row.mapLayerId,
    layerKey: row.managedLayerKey ?? row.mapLayerId,
    name: row.title,
    sourceType: row.sourceType,
    geometryType: row.geometryType,
    srid: row.srid,
    description: row.description,
    featureCount: row.featureCount,
    bounds: row.boundsJson,
    propertySchema: layerPropertyDescriptorSchema.array().parse(row.propertySchemaJson),
    category: row.category,
    status: row.status === 'ready' ? 'active' : row.status,
    tags: row.tagsJson,
    analysisCapabilities: row.analysisCapabilitiesJson,
    sourceConfigSummary: row.sourceConfigSummary,
    sessionId: row.sessionId,
    threadId: row.threadId,
    workspaceId: row.workspaceId,
    createdByUserId: row.createdByUserId,
    visibility: resourceVisibilitySchema.parse(row.visibility),
    readonly: row.readonly,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  })
}
