// +-------------------------------------------------------------------------
//
//   地理智能平台 - 地图场景变更协调器测试
//
//   文件:       mapSceneMutationCoordinator.test.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { MapScene, MapSceneUpdate } from '@geo-agent-platform/shared-types'
import { describe, expect, it, vi } from 'vitest'
import { MapSceneMutationCoordinator } from '../features/map/MapSceneMutationCoordinator'

function scene(version: number, opacity = 1): MapScene {
  return {
    sceneId: 'scene-1',
    workspaceId: 'workspace-1',
    threadId: 'thread-1',
    version,
    layers: [{
      mapLayerId: 'layer-1', order: 0, visible: true, opacity,
      styleOverride: null, label: null, currentFrameId: null,
    }],
    createdAt: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T00:00:00.000Z',
  }
}

describe('MapSceneMutationCoordinator', () => {
  it('serializes versions and coalesces rapid edits to the latest scene', async () => {
    let releaseFirst: ((value: MapScene) => void) | undefined
    const requests: MapSceneUpdate[] = []
    const published: MapScene[] = []
    const persist = vi.fn((update: MapSceneUpdate) => {
      requests.push(update)
      if (requests.length === 1) {
        return new Promise<MapScene>(resolve => { releaseFirst = resolve })
      }
      return Promise.resolve(scene(3, update.layers[0]?.opacity))
    })
    const coordinator = new MapSceneMutationCoordinator({
      readScene: () => scene(1),
      persist,
      publish: next => published.push(next),
      onFailure: vi.fn(),
    })

    const first = coordinator.enqueue(scene(1, 0.8).layers)
    const second = coordinator.enqueue(scene(1, 0.6).layers)
    const third = coordinator.enqueue(scene(1, 0.4).layers)
    releaseFirst?.(scene(2, 0.8))
    await Promise.all([first, second, third])

    expect(requests).toHaveLength(2)
    expect(requests[0]).toMatchObject({ expectedVersion: 1, layers: [{ opacity: 0.8 }] })
    expect(requests[1]).toMatchObject({ expectedVersion: 2, layers: [{ opacity: 0.4 }] })
    expect(published.at(-1)?.layers[0]?.opacity).toBe(0.4)
  })

  it('rejects every queued edit when the server rejects a version', async () => {
    const error = new Error('地图场景版本冲突')
    let rejectFirst: ((reason: unknown) => void) | undefined
    const onFailure = vi.fn()
    const coordinator = new MapSceneMutationCoordinator({
      readScene: () => scene(1),
      persist: () => new Promise<MapScene>((_resolve, reject) => { rejectFirst = reject }),
      publish: vi.fn(),
      onFailure,
    })

    const first = coordinator.enqueue(scene(1, 0.8).layers)
    const second = coordinator.enqueue(scene(1, 0.6).layers)
    rejectFirst?.(error)

    await expect(first).rejects.toThrow('地图场景版本冲突')
    await expect(second).rejects.toThrow('地图场景版本冲突')
    expect(onFailure).toHaveBeenCalledWith(error)
  })
})
