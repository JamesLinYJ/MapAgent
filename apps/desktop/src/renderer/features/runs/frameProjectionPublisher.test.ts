// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运行投影逐帧发布器测试
//
//   文件:       frameProjectionPublisher.test.ts
//
//   日期:       2026年08月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'

import {
  FrameProjectionPublisher,
  shouldPublishRunProjectionImmediately,
  type ProjectionFrameScheduler,
} from './frameProjectionPublisher'

describe('FrameProjectionPublisher', () => {
  it('同一绘制帧只发布最新的完整快照', () => {
    const scheduler = controlledScheduler()
    const publisher = new FrameProjectionPublisher<number>(scheduler)
    const publish = vi.fn()

    publisher.schedule(1, publish)
    publisher.schedule(2, publish)
    publisher.schedule(3, publish)

    expect(scheduler.request).toHaveBeenCalledOnce()
    expect(publish).not.toHaveBeenCalled()
    scheduler.flush()
    expect(publish).toHaveBeenCalledOnce()
    expect(publish).toHaveBeenCalledWith(3)
  })

  it('终态立即发布并取消尚未绘制的旧快照', () => {
    const scheduler = controlledScheduler()
    const publisher = new FrameProjectionPublisher<number>(scheduler)
    const publish = vi.fn()

    publisher.schedule(1, publish)
    publisher.publishNow(2, publish)
    scheduler.flush()

    expect(scheduler.cancel).toHaveBeenCalledOnce()
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith(2)
  })

  it('审批、澄清、终态和错误事件都立即发布', () => {
    expect(shouldPublishRunProjectionImmediately({ type: 'approval.required' })).toBe(true)
    expect(shouldPublishRunProjectionImmediately({ type: 'clarification.required' })).toBe(true)
    expect(shouldPublishRunProjectionImmediately({ type: 'run.completed' })).toBe(true)
    expect(shouldPublishRunProjectionImmediately({ type: 'run.failed' })).toBe(true)
    expect(shouldPublishRunProjectionImmediately({ type: 'tool.completed' })).toBe(false)
  })
})

function controlledScheduler(): ProjectionFrameScheduler & {
  request: ReturnType<typeof vi.fn<(callback: () => void) => number>>
  cancel: ReturnType<typeof vi.fn<(frameId: number) => void>>
  flush: () => void
} {
  let callback: (() => void) | null = null
  return {
    request: vi.fn((next: () => void) => {
      callback = next
      return 1
    }),
    cancel: vi.fn(() => { callback = null }),
    flush: () => {
      const pending = callback
      callback = null
      pending?.()
    },
  }
}
