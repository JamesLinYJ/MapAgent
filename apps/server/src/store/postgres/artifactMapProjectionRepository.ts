// +-------------------------------------------------------------------------
//
//   地理智能平台 - Artifact 地图投影仓储
//
//   文件:       artifactMapProjectionRepository.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { and, eq, inArray, max, ne, sql } from 'drizzle-orm'

import type { DatabaseTransaction } from '../../db/connection.js'
import { platformMapLayers, platformMapSceneLayers, platformMapScenes } from '../../db/schema.js'
import type { ArtifactRef } from '../../schemas/types.js'
import type { ArtifactOwnerProjection } from './artifactRepository.js'

/** 将 Artifact 的显式地图展示契约投影到图层与场景关系。 */
export class ArtifactMapProjectionRepository {
  async publish(
    tx: DatabaseTransaction,
    artifact: ArtifactRef,
    owner: ArtifactOwnerProjection,
  ): Promise<void> {
    const draft = artifact.display.map
    if (!draft) {
      await this.removeExistingProjection(tx, artifact.artifactId)
      return
    }
    if (!owner.workspaceId || !owner.threadId) {
      throw new Error(`地图 Artifact '${artifact.artifactId}' 缺少 workspace 或 thread 归属`)
    }

    const mapLayerId = `map_layer_${artifact.artifactId}`
    const sceneId = `map_scene_${owner.threadId}`
    const now = new Date()
    await tx.insert(platformMapLayers).values({
      mapLayerId,
      ownershipScope: 'thread',
      workspaceId: owner.workspaceId,
      threadId: owner.threadId,
      artifactId: artifact.artifactId,
      managedLayerKey: null,
      title: draft.title,
      replacementGroup: draft.replacementGroup,
      sourceType: 'artifact',
      geometryType: draft.style.kind,
      srid: 4326,
      description: typeof artifact.metadata.description === 'string' ? artifact.metadata.description : '',
      featureCount: typeof artifact.metadata.featureCount === 'number' ? artifact.metadata.featureCount : null,
      propertySchemaJson: [],
      category: 'analysis',
      tagsJson: [],
      analysisCapabilitiesJson: Object.entries(draft.capabilities)
        .filter(([, enabled]) => enabled)
        .map(([name]) => name),
      sourceConfigSummary: artifact.name,
      sessionId: null,
      createdByUserId: owner.createdByUserId,
      visibility: owner.visibility,
      readonly: false,
      status: 'ready',
      errorMessage: null,
      boundsJson: draft.bounds,
      crs: draft.crs,
      minZoom: draft.minZoom,
      maxZoom: draft.maxZoom,
      sourceJson: draft.source,
      styleJson: draft.style,
      legendJson: draft.legend,
      temporalJson: draft.temporal,
      capabilitiesJson: draft.capabilities,
      dataVersion: 1,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: platformMapLayers.artifactId,
      set: {
        title: draft.title,
        replacementGroup: draft.replacementGroup,
        status: 'ready',
        errorMessage: null,
        boundsJson: draft.bounds,
        crs: draft.crs,
        minZoom: draft.minZoom,
        maxZoom: draft.maxZoom,
        sourceJson: draft.source,
        styleJson: draft.style,
        legendJson: draft.legend,
        temporalJson: draft.temporal,
        capabilitiesJson: draft.capabilities,
        dataVersion: sql`${platformMapLayers.dataVersion} + 1`,
        updatedAt: now,
      },
    })

    await tx.insert(platformMapScenes).values({
      sceneId,
      workspaceId: owner.workspaceId,
      threadId: owner.threadId,
      version: 1,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing({ target: platformMapScenes.threadId })

    const existingSceneLayer = await tx.select({ mapLayerId: platformMapSceneLayers.mapLayerId })
      .from(platformMapSceneLayers)
      .where(eq(platformMapSceneLayers.mapLayerId, mapLayerId))
      .limit(1)
    if (existingSceneLayer[0]) return

    if (draft.replacementGroup) {
      const replacedLayers = await tx.select({ mapLayerId: platformMapLayers.mapLayerId })
        .from(platformMapLayers)
        .where(and(
          eq(platformMapLayers.threadId, owner.threadId),
          eq(platformMapLayers.replacementGroup, draft.replacementGroup),
          ne(platformMapLayers.mapLayerId, mapLayerId),
        ))
      const replacedIds = replacedLayers.map(layer => layer.mapLayerId)
      if (replacedIds.length > 0) {
        await tx.update(platformMapSceneLayers).set({
          visible: false,
          updatedAt: now,
        }).where(and(
          eq(platformMapSceneLayers.sceneId, sceneId),
          inArray(platformMapSceneLayers.mapLayerId, replacedIds),
        ))
      }
    }

    const orderRows = await tx.select({ value: max(platformMapSceneLayers.layerOrder) })
      .from(platformMapSceneLayers)
      .where(eq(platformMapSceneLayers.sceneId, sceneId))
    await tx.insert(platformMapSceneLayers).values({
      sceneId,
      mapLayerId,
      layerOrder: Number(orderRows[0]?.value ?? -1) + 1,
      visible: true,
      opacity: 100,
      styleOverrideJson: null,
      labelJson: null,
      currentFrameId: draft.temporal?.defaultFrameId ?? null,
      updatedAt: now,
    })
    await tx.update(platformMapScenes).set({
      version: sql`${platformMapScenes.version} + 1`,
      updatedAt: now,
    }).where(eq(platformMapScenes.sceneId, sceneId))
  }

  private async removeExistingProjection(
    tx: DatabaseTransaction,
    artifactId: string,
  ): Promise<void> {
    const existing = await tx.select({
      mapLayerId: platformMapLayers.mapLayerId,
      threadId: platformMapLayers.threadId,
    }).from(platformMapLayers).where(eq(platformMapLayers.artifactId, artifactId)).limit(1)
    const layer = existing[0]
    if (!layer) return
    await tx.delete(platformMapLayers).where(eq(platformMapLayers.mapLayerId, layer.mapLayerId))
    if (!layer.threadId) return
    await tx.update(platformMapScenes).set({
      version: sql`${platformMapScenes.version} + 1`,
      updatedAt: new Date(),
    }).where(eq(platformMapScenes.threadId, layer.threadId))
  }
}
