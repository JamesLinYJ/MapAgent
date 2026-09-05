// +-------------------------------------------------------------------------
//
//   地理智能平台 - Renderer 桌面事件路由测试
//
//   文件:       DesktopEventRouter.test.ts
//
//   日期:       2026年08月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { DesktopBridge } from '../../../contracts/desktopBridge'
import type { DesktopEvent } from '../../../contracts/desktopIpc'
import { describe, expect, it, vi } from 'vitest'

import { DesktopEventRouter } from './DesktopEventRouter'

describe('DesktopEventRouter', () => {
  it('无论有多少逻辑消费者都只建立一个 Preload 读者', () => {
    const source = eventSource()
    const router = new DesktopEventRouter({
      source,
      realtime: realtimeSink(),
    })
    const first = vi.fn()
    const second = vi.fn()
    router.subscribe(first)
    router.subscribe(second)

    router.start()
    router.start()
    source.emit(desktopEvent('desktop:command', { command: 'open-map' }))

    expect(source.subscribe).toHaveBeenCalledOnce()
    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledOnce()
    router.stop()
    expect(source.unsubscribe).toHaveBeenCalledOnce()
  })

  it('先按到达顺序投影 transport 状态和推送，再交付逻辑消费者', () => {
    const source = eventSource()
    const calls: string[] = []
    const router = new DesktopEventRouter({
      source,
      realtime: {
        acceptDesktopMessage: () => calls.push('realtime:push'),
        setDesktopConnectionState: state => calls.push(`realtime:${state}`),
      },
    })
    router.subscribe(event => calls.push(`listener:${event.event}`))
    router.start()

    source.emit(desktopEvent('transport:status', { state: 'connected' }))
    source.emit(desktopEvent('transport:push', { type: 'run.event' }))

    expect(calls).toEqual([
      'realtime:connected',
      'listener:transport:status',
      'realtime:push',
      'listener:transport:push',
    ])
  })

  it('隔离单个消费者异常，不丢失同帧的其他交付', () => {
    const source = eventSource()
    const error = new Error('listener failed')
    const report = vi.fn()
    const healthy = vi.fn()
    const router = new DesktopEventRouter({
      source,
      realtime: realtimeSink(),
      onListenerError: report,
    })
    router.subscribe(() => { throw error })
    router.subscribe(healthy)
    router.start()

    const event = desktopEvent('desktop:command', { command: 'open-map' })
    source.emit(event)

    expect(report).toHaveBeenCalledWith(error)
    expect(healthy).toHaveBeenCalledWith(event)
  })
})

function eventSource(): DesktopBridge['events'] & {
  emit: (event: DesktopEvent) => void
  subscribe: ReturnType<typeof vi.fn<DesktopBridge['events']['subscribe']>>
  unsubscribe: ReturnType<typeof vi.fn<() => void>>
} {
  let listener: ((event: DesktopEvent) => void) | null = null
  const unsubscribe = vi.fn(() => { listener = null })
  const subscribe = vi.fn<DesktopBridge['events']['subscribe']>((next) => {
    listener = next
    return unsubscribe
  })
  return {
    subscribe,
    unsubscribe,
    emit: event => listener?.(event),
  }
}

function realtimeSink() {
  return {
    acceptDesktopMessage: vi.fn(),
    setDesktopConnectionState: vi.fn(),
  }
}

function desktopEvent(
  event: DesktopEvent['event'],
  payload: unknown,
): DesktopEvent {
  return { version: 1, event, payload }
}
