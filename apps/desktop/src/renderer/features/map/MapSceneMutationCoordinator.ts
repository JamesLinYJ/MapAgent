// +-------------------------------------------------------------------------
//
//   地理智能平台 - 地图场景变更协调器
//
//   文件:       MapSceneMutationCoordinator.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { MapScene, MapSceneLayer, MapSceneUpdate } from '@geo-agent-platform/shared-types'

interface MutationWaiter {
  resolve: () => void
  reject: (error: unknown) => void
}

interface PendingMutation {
  layers: MapSceneLayer[]
  waiters: MutationWaiter[]
}

interface MapSceneMutationDependencies {
  readScene: () => MapScene | null
  persist: (update: MapSceneUpdate) => Promise<MapScene>
  publish: (scene: MapScene) => void
  onFailure: (error: unknown) => void
}

/**
 * 串行提交 MapScene 版本更新，并将提交期间产生的高频编辑合并为最新目标状态。
 * 该协调器不重试版本冲突；失败后由调用方重新读取服务端事实。
 */
export class MapSceneMutationCoordinator {
  private committedScene: MapScene | null = null
  private pending: PendingMutation | null = null
  private running = false

  constructor(private readonly dependencies: MapSceneMutationDependencies) {}

  syncRemote(scene: MapScene, publish = false): void {
    if (!this.committedScene || scene.version > this.committedScene.version) {
      this.committedScene = scene
    }
    if (publish) this.publishScene(scene)
  }

  enqueue(layers: MapSceneLayer[]): Promise<void> {
    const base = this.committedScene ?? this.dependencies.readScene()
    if (!base) return Promise.reject(new Error('当前对话尚无可更新的地图场景。'))
    if (!this.committedScene) this.committedScene = base

    this.dependencies.publish({ ...base, layers })

    const completion = new Promise<void>((resolve, reject) => {
      if (this.pending) {
        this.pending.layers = layers
        this.pending.waiters.push({ resolve, reject })
      } else {
        this.pending = { layers, waiters: [{ resolve, reject }] }
      }
    })

    if (!this.running) void this.drain()
    return completion
  }

  private async drain(): Promise<void> {
    this.running = true
    try {
      while (this.pending) {
        const mutation = this.pending
        this.pending = null
        const base = this.committedScene ?? this.dependencies.readScene()
        if (!base) {
          const error = new Error('当前对话尚无可更新的地图场景。')
          this.rejectMutation(mutation, error)
          this.rejectPending(error)
          this.dependencies.onFailure(error)
          return
        }

        try {
          const committed = await this.dependencies.persist({
            threadId: base.threadId,
            expectedVersion: base.version,
            layers: mutation.layers,
          })
          this.committedScene = committed
          this.publishScene(committed)
          mutation.waiters.forEach(waiter => waiter.resolve())
        } catch (error) {
          this.rejectMutation(mutation, error)
          this.rejectPending(error)
          this.dependencies.onFailure(error)
          return
        }
      }
    } finally {
      this.running = false
    }
  }

  private publishScene(scene: MapScene): void {
    this.dependencies.publish(this.pending ? { ...scene, layers: this.pending.layers } : scene)
  }

  private rejectMutation(mutation: PendingMutation, error: unknown): void {
    mutation.waiters.forEach(waiter => waiter.reject(error))
  }

  private rejectPending(error: unknown): void {
    if (!this.pending) return
    const pending = this.pending
    this.pending = null
    this.rejectMutation(pending, error)
  }
}
