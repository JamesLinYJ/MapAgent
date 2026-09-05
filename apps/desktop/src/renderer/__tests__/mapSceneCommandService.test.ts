// +-------------------------------------------------------------------------
//
//   地理智能平台 - 地图场景命令服务测试
//
//   文件:       mapSceneCommandService.test.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { MapScene, MapSceneUpdate } from '@geo-agent-platform/shared-types'
import { describe, expect, it, vi } from 'vitest'
import { MapSceneCommandService } from '../features/map/MapSceneCommandService'

function makeScene(threadId: string, version = 1, layerIds: string[] = []): MapScene {
  return {
    sceneId: `scene_${threadId}`,
    workspaceId: 'workspace_1',
    threadId,
    version,
    layers: layerIds.map((mapLayerId, order) => ({
      mapLayerId,
      order,
      visible: true,
      opacity: 1,
      styleOverride: null,
      label: null,
      currentFrameId: null,
    })),
    createdAt: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T00:00:00.000Z',
  }
}

describe('MapSceneCommandService', () => {
  it('creates an active thread, initializes its scene, and adds a layer', async () => {
    const scenes = new Map<string, MapScene>()
    const initial = makeScene('thread_map')
    const updates: MapSceneUpdate[] = []
    const ensureThread = vi.fn().mockResolvedValue('thread_map')
    const loadScene = vi.fn().mockImplementation(async (threadId: string) => {
      scenes.set(threadId, initial)
      return initial
    })
    const publishScene = vi.fn((threadId: string, scene: MapScene) => scenes.set(threadId, scene))
    const service = new MapSceneCommandService({
      ensureThread,
      readScene: threadId => scenes.get(threadId) ?? null,
      loadScene,
      persistScene: async update => {
        updates.push(update)
        return { ...initial, version: update.expectedVersion + 1, layers: update.layers }
      },
      publishScene,
      invalidateScene: vi.fn(),
      hasManifest: () => true,
    })

    await expect(service.addLayer('layer_hangzhou')).resolves.toBe('thread_map')

    expect(ensureThread).toHaveBeenCalledOnce()
    expect(loadScene).toHaveBeenCalledWith('thread_map')
    expect(updates).toEqual([expect.objectContaining({
      threadId: 'thread_map',
      expectedVersion: 1,
      layers: [expect.objectContaining({ mapLayerId: 'layer_hangzhou', order: 0 })],
    })])
    expect(scenes.get('thread_map')?.version).toBe(2)
  })

  it('does not write when the requested layer is already in the scene', async () => {
    const existing = makeScene('thread_map', 3, ['layer_hangzhou'])
    const persistScene = vi.fn()
    const service = new MapSceneCommandService({
      ensureThread: vi.fn().mockResolvedValue('thread_map'),
      readScene: () => existing,
      loadScene: vi.fn(),
      persistScene,
      publishScene: vi.fn(),
      invalidateScene: vi.fn(),
      hasManifest: () => true,
    })

    await service.addLayer('layer_hangzhou')
    expect(persistScene).not.toHaveBeenCalled()
  })

  it('invalidates the projection after adding a layer whose manifest is not cached', async () => {
    let current = makeScene('thread_map')
    const invalidateScene = vi.fn()
    const service = new MapSceneCommandService({
      ensureThread: vi.fn().mockResolvedValue('thread_map'),
      readScene: () => current,
      loadScene: vi.fn(),
      persistScene: async update => ({ ...current, version: current.version + 1, layers: update.layers }),
      publishScene: (_threadId, scene) => { current = scene },
      invalidateScene,
      hasManifest: () => false,
    })

    await service.addLayer('layer_new')
    expect(invalidateScene).toHaveBeenCalledWith('thread_map')
  })

  it('surfaces persistence conflicts and invalidates without retrying', async () => {
    const current = makeScene('thread_map', 4)
    const conflict = new Error('地图场景版本冲突')
    const persistScene = vi.fn().mockRejectedValue(conflict)
    const invalidateScene = vi.fn()
    const service = new MapSceneCommandService({
      ensureThread: vi.fn().mockResolvedValue('thread_map'),
      readScene: () => current,
      loadScene: vi.fn(),
      persistScene,
      publishScene: vi.fn(),
      invalidateScene,
      hasManifest: () => true,
    })

    await expect(service.addLayer('layer_new')).rejects.toThrow('地图场景版本冲突')
    expect(persistScene).toHaveBeenCalledOnce()
    expect(invalidateScene).toHaveBeenCalledWith('thread_map')
  })
})
// +-------------------------------------------------------------------------
//
//   地理智能平台 - 地图场景命令服务测试
//
//   文件:       mapSceneCommandService.test.ts
// --------------------------------------------------------------------------
