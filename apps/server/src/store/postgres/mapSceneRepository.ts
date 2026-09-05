// +-------------------------------------------------------------------------
//
//   地理智能平台 - 地图场景仓储
//
//   文件:       mapSceneRepository.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { and, asc, eq, inArray, isNotNull, or, sql } from 'drizzle-orm'

import type { Database } from '../../db/connection.js'
import {
  platformMapLayers,
  platformMapSceneLayers,
  platformMapScenes,
  platformThreads,
} from '../../db/schema.js'
import {
  mapSceneSchema,
  mapSceneUpdateSchema,
  type MapLayerManifest,
  type MapScene,
  type MapSceneUpdate,
} from '../../schemas/types.js'
import type { InMemoryEventBus } from '../eventBus.js'
import { MapLayerRepository, type MapResourceScope } from './mapLayerRepository.js'

class MapSceneVersionConflictError extends Error {
  constructor(readonly currentVersion: number) {
    super(`地图场景已更新，当前版本为 ${currentVersion}。请刷新后重试。`)
    this.name = 'MapSceneVersionConflictError'
  }
}

/** 地图场景组合、图层顺序和乐观版本的唯一写入边界。 */
export class MapSceneRepository {
  constructor(
    private readonly db: Database,
    private readonly layers: MapLayerRepository,
    private readonly sceneBus: InMemoryEventBus<MapScene>,
  ) {}

  async getThreadScope(threadId: string): Promise<MapResourceScope | null> {
    const rows = await this.db.select({
      workspaceId: platformThreads.workspaceId,
      threadId: platformThreads.threadId,
      createdByUserId: platformThreads.createdByUserId,
      visibility: platformThreads.visibility,
    }).from(platformThreads).where(eq(platformThreads.threadId, threadId)).limit(1)
    const row = rows[0]
    if (!row?.workspaceId) return null
    return { ...row, workspaceId: row.workspaceId, resourceId: row.threadId, system: false }
  }

  async getScene(threadId: string): Promise<MapScene | null> {
    const sceneRows = await this.db.select().from(platformMapScenes)
      .where(eq(platformMapScenes.threadId, threadId)).limit(1)
    const scene = sceneRows[0]
    if (!scene) return null
    const layerRows = await this.db.select().from(platformMapSceneLayers)
      .where(eq(platformMapSceneLayers.sceneId, scene.sceneId))
      .orderBy(asc(platformMapSceneLayers.layerOrder))
    return mapSceneSchema.parse({
      sceneId: scene.sceneId,
      workspaceId: scene.workspaceId,
      threadId: scene.threadId,
      version: scene.version,
      layers: layerRows.map(row => ({
        mapLayerId: row.mapLayerId,
        order: row.layerOrder,
        visible: row.visible,
        opacity: row.opacity / 100,
        styleOverride: row.styleOverrideJson,
        label: row.labelJson,
        currentFrameId: row.currentFrameId,
      })),
      createdAt: scene.createdAt.toISOString(),
      updatedAt: scene.updatedAt.toISOString(),
    })
  }

  /**
   * 为线程建立唯一地图场景，并仅在首次初始化时加入当前可用的托管图层。
   * 持久化初始化标记确保用户主动移除图层后，后续读取不会把它自动加回。
   */
  async getOrCreateScene(threadId: string): Promise<MapScene> {
    const scope = await this.getThreadScope(threadId)
    if (!scope?.workspaceId) throw new Error(`线程 '${threadId}' 不存在`)
    const workspaceId = scope.workspaceId
    const now = new Date()
    const sceneId = `map_scene_${threadId}`
    let changed = false

    await this.db.transaction(async tx => {
      await tx.insert(platformMapScenes).values({
        sceneId,
        workspaceId,
        threadId,
        version: 1,
        defaultLayersInitialized: false,
        createdAt: now,
        updatedAt: now,
      }).onConflictDoNothing({ target: platformMapScenes.threadId })

      const sceneRows = await tx.select().from(platformMapScenes)
        .where(eq(platformMapScenes.threadId, threadId)).limit(1).for('update')
      const scene = sceneRows[0]
      if (!scene) throw new Error(`线程 '${threadId}' 的地图场景创建失败`)
      if (scene.defaultLayersInitialized) return

      const defaults = await tx.select({ mapLayerId: platformMapLayers.mapLayerId })
        .from(platformMapLayers)
        .where(and(
          isNotNull(platformMapLayers.managedLayerKey),
          eq(platformMapLayers.status, 'ready'),
          or(
            eq(platformMapLayers.ownershipScope, 'system'),
            and(
              eq(platformMapLayers.ownershipScope, 'workspace'),
              eq(platformMapLayers.workspaceId, workspaceId),
            ),
            and(
              eq(platformMapLayers.ownershipScope, 'thread'),
              eq(platformMapLayers.threadId, threadId),
            ),
          ),
        ))
        .orderBy(asc(platformMapLayers.createdAt))

      const existing = await tx.select({ mapLayerId: platformMapSceneLayers.mapLayerId })
        .from(platformMapSceneLayers)
        .where(eq(platformMapSceneLayers.sceneId, scene.sceneId))
      const existingIds = new Set(existing.map(row => row.mapLayerId))
      const missingDefaults = defaults.filter(row => !existingIds.has(row.mapLayerId))

      if (missingDefaults.length > 0) {
        // 非延迟唯一顺序约束要求先进入保留区，再一次性写回最终位置。
        await tx.update(platformMapSceneLayers).set({
          layerOrder: sql`${platformMapSceneLayers.layerOrder} + 1000000`,
          updatedAt: now,
        }).where(eq(platformMapSceneLayers.sceneId, scene.sceneId))
        await tx.update(platformMapSceneLayers).set({
          layerOrder: sql`${platformMapSceneLayers.layerOrder} - 1000000 + ${missingDefaults.length}`,
          updatedAt: now,
        }).where(eq(platformMapSceneLayers.sceneId, scene.sceneId))
        await tx.insert(platformMapSceneLayers).values(missingDefaults.map((layer, index) => ({
          sceneId: scene.sceneId,
          mapLayerId: layer.mapLayerId,
          layerOrder: index,
          visible: true,
          opacity: 100,
          styleOverrideJson: null,
          labelJson: null,
          currentFrameId: null,
          updatedAt: now,
        })))
      }

      await tx.update(platformMapScenes).set({
        defaultLayersInitialized: true,
        version: scene.version + 1,
        updatedAt: now,
      }).where(eq(platformMapScenes.sceneId, scene.sceneId))
      changed = true
    })

    const scene = await this.getScene(threadId)
    if (!scene) throw new Error(`线程 '${threadId}' 的地图场景初始化后无法读取`)
    if (changed) this.sceneBus.publish(threadId, structuredClone(scene))
    return scene
  }

  async listSceneManifests(threadId: string): Promise<MapLayerManifest[]> {
    const scene = await this.getScene(threadId)
    if (!scene?.layers.length) return []
    const manifests = await this.layers.getManifests(scene.layers.map(layer => layer.mapLayerId))
    const byId = new Map(manifests.map(manifest => [manifest.mapLayerId, manifest]))
    return scene.layers.flatMap(layer => {
      const manifest = byId.get(layer.mapLayerId)
      return manifest ? [manifest] : []
    })
  }

  async updateScene(input: MapSceneUpdate): Promise<MapScene> {
    const parsed = mapSceneUpdateSchema.parse(input)
    await this.db.transaction(async tx => {
      const scenes = await tx.select().from(platformMapScenes)
        .where(eq(platformMapScenes.threadId, parsed.threadId)).limit(1).for('update')
      const scene = scenes[0]
      if (!scene) throw new Error(`线程 '${parsed.threadId}' 尚未创建地图场景`)
      if (scene.version !== parsed.expectedVersion) {
        throw new MapSceneVersionConflictError(scene.version)
      }

      if (parsed.layers.length) {
        const available = await tx.select({
          mapLayerId: platformMapLayers.mapLayerId,
          ownershipScope: platformMapLayers.ownershipScope,
          workspaceId: platformMapLayers.workspaceId,
          threadId: platformMapLayers.threadId,
          status: platformMapLayers.status,
        })
          .from(platformMapLayers)
          .where(inArray(platformMapLayers.mapLayerId, parsed.layers.map(layer => layer.mapLayerId)))
        const permitted = available.filter(layer =>
          layer.status === 'ready' && (
            layer.ownershipScope === 'system'
            || (layer.ownershipScope === 'workspace' && layer.workspaceId === scene.workspaceId)
            || (layer.ownershipScope === 'thread' && layer.threadId === parsed.threadId)
          ),
        )
        if (permitted.length !== parsed.layers.length) {
          throw new Error('场景包含不属于当前线程的地图图层')
        }
      }

      await tx.delete(platformMapSceneLayers).where(eq(platformMapSceneLayers.sceneId, scene.sceneId))
      if (parsed.layers.length) {
        await tx.insert(platformMapSceneLayers).values(parsed.layers.map(layer => ({
          sceneId: scene.sceneId,
          mapLayerId: layer.mapLayerId,
          layerOrder: layer.order,
          visible: layer.visible,
          opacity: Math.round(layer.opacity * 100),
          styleOverrideJson: layer.styleOverride,
          labelJson: layer.label,
          currentFrameId: layer.currentFrameId,
          updatedAt: new Date(),
        })))
      }
      await tx.update(platformMapScenes).set({
        version: parsed.expectedVersion + 1,
        updatedAt: new Date(),
      }).where(and(
        eq(platformMapScenes.sceneId, scene.sceneId),
        eq(platformMapScenes.version, parsed.expectedVersion),
      ))
    })
    const updated = await this.getScene(parsed.threadId)
    if (!updated) throw new Error(`线程 '${parsed.threadId}' 的地图场景更新后无法读取`)
    this.sceneBus.publish(parsed.threadId, structuredClone(updated))
    return updated
  }

  async isLayerInThreadScene(threadId: string, mapLayerId: string): Promise<boolean> {
    const rows = await this.db.select({ mapLayerId: platformMapSceneLayers.mapLayerId })
      .from(platformMapSceneLayers)
      .innerJoin(platformMapScenes, eq(platformMapScenes.sceneId, platformMapSceneLayers.sceneId))
      .where(and(
        eq(platformMapScenes.threadId, threadId),
        eq(platformMapSceneLayers.mapLayerId, mapLayerId),
      ))
      .limit(1)
    return Boolean(rows[0])
  }
}
