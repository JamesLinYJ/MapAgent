// +-------------------------------------------------------------------------
//
//   地理智能平台 - 托管图层场景投影
//
//   文件:       managedLayerSceneProjection.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { and, eq, max, sql } from 'drizzle-orm'

import type { DatabaseTransaction } from '../../db/connection.js'
import { platformMapSceneLayers, platformMapScenes } from '../../db/schema.js'
import type { PreparedManagedLayerImport } from './managedLayerTypes.js'

/** 在同一导入事务中，将线程级托管图层挂载到地图场景。 */
export class ManagedLayerSceneProjection {
  async attach(
    tx: DatabaseTransaction,
    prepared: PreparedManagedLayerImport,
    now: Date,
  ): Promise<void> {
    const { ownership, input } = prepared
    if (!input.threadId || !ownership.workspaceId || !ownership.threadId) return
    const sceneId = `map_scene_${input.threadId}`
    await tx.insert(platformMapScenes).values({
      sceneId,
      workspaceId: ownership.workspaceId,
      threadId: ownership.threadId,
      version: 1,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing({ target: platformMapScenes.threadId })

    const existing = await tx.select({ mapLayerId: platformMapSceneLayers.mapLayerId })
      .from(platformMapSceneLayers)
      .where(and(
        eq(platformMapSceneLayers.sceneId, sceneId),
        eq(platformMapSceneLayers.mapLayerId, prepared.mapLayerId),
      )).limit(1)
    if (existing[0]) return

    const orderRows = await tx.select({ value: max(platformMapSceneLayers.layerOrder) })
      .from(platformMapSceneLayers)
      .where(eq(platformMapSceneLayers.sceneId, sceneId))
    await tx.insert(platformMapSceneLayers).values({
      sceneId,
      mapLayerId: prepared.mapLayerId,
      layerOrder: Number(orderRows[0]?.value ?? -1) + 1,
      visible: true,
      opacity: 100,
      styleOverrideJson: null,
      labelJson: null,
      currentFrameId: null,
      updatedAt: now,
    })
    await tx.update(platformMapScenes).set({
      version: sql`${platformMapScenes.version} + 1`,
      updatedAt: now,
    }).where(eq(platformMapScenes.sceneId, sceneId))
  }
}
