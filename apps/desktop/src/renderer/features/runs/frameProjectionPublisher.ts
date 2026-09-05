// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运行投影逐帧发布器
//
//   文件:       frameProjectionPublisher.ts
//
//   日期:       2026年08月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { RunEvent } from '@geo-agent-platform/shared-types'

export interface ProjectionFrameScheduler {
  request(callback: () => void): number
  cancel(frameId: number): void
}

interface PendingProjection<T> {
  value: T
  publish: (value: T) => void
}

/**
 * 流协议仍逐条吸收和校验，这里只合并 Renderer 的发布时机。
 * 同一绘制帧只交付最新快照；终态、快照和导航边界可以立即发布。
 */
export class FrameProjectionPublisher<T> {
  private frameId: number | null = null
  private pending: PendingProjection<T> | null = null

  constructor(private readonly scheduler: ProjectionFrameScheduler = browserFrameScheduler) {}

  schedule(value: T, publish: (value: T) => void): void {
    this.pending = { value, publish }
    if (this.frameId !== null) return
    this.frameId = this.scheduler.request(() => {
      this.frameId = null
      const pending = this.pending
      this.pending = null
      if (pending) pending.publish(pending.value)
    })
  }

  publishNow(value: T, publish: (value: T) => void): void {
    this.cancel()
    publish(value)
  }

  cancel(): void {
    if (this.frameId !== null) this.scheduler.cancel(this.frameId)
    this.frameId = null
    this.pending = null
  }
}

/** 不允许等到下一绘制帧的服务端边界。 */
export function shouldPublishRunProjectionImmediately(
  event: Pick<RunEvent, 'type'>,
): boolean {
  return event.type === 'approval.required'
    || event.type === 'clarification.required'
    || event.type === 'run.completed'
    || event.type === 'run.failed'
}

const browserFrameScheduler: ProjectionFrameScheduler = {
  request(callback) {
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      return window.requestAnimationFrame(() => callback())
    }
    return setTimeout(callback, 0) as unknown as number
  },
  cancel(frameId) {
    if (typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
      window.cancelAnimationFrame(frameId)
      return
    }
    clearTimeout(frameId)
  },
}
