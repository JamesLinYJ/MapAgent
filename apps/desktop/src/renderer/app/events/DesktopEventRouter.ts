// +-------------------------------------------------------------------------
//
//   地理智能平台 - Renderer 桌面事件路由
//
//   文件:       DesktopEventRouter.ts
//
//   日期:       2026年08月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { DesktopBridge } from '../../../contracts/desktopBridge'
import type { DesktopEvent } from '../../../contracts/desktopIpc'

type DesktopEventListener = (event: DesktopEvent) => void

interface DesktopRealtimeEventSink {
  acceptDesktopMessage(input: unknown): void
  setDesktopConnectionState(state: 'connected' | 'disconnected', reason?: string): void
}

interface DesktopEventRouterOptions {
  source: DesktopBridge['events']
  realtime: DesktopRealtimeEventSink
  onListenerError?: (error: unknown) => void
}

/**
 * Renderer 的唯一桌面事件读者。
 *
 * Preload 只向这个实例交付一条有序事件流；路由器先把实时
 * transport 事件交给运行投影，再向桌面命令、日志等窄消费者扇出。
 * 一个消费者失败不能阻断后续消费者或下一个事件。
 */
export class DesktopEventRouter {
  private readonly listeners = new Set<DesktopEventListener>()
  private unsubscribeSource: (() => void) | null = null

  constructor(private readonly options: DesktopEventRouterOptions) {}

  start(): void {
    if (this.unsubscribeSource) return
    this.unsubscribeSource = this.options.source.subscribe(event => this.route(event))
  }

  stop(): void {
    this.unsubscribeSource?.()
    this.unsubscribeSource = null
  }

  subscribe(listener: DesktopEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private route(event: DesktopEvent): void {
    try {
      this.routeRealtimeEvent(event)
    } catch (error) {
      this.reportListenerError(error)
    }
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        this.reportListenerError(error)
      }
    }
  }

  private routeRealtimeEvent(event: DesktopEvent): void {
    if (event.event === 'transport:push') {
      this.options.realtime.acceptDesktopMessage(event.payload)
      return
    }
    if (event.event !== 'transport:status') return
    const payload = event.payload
    if (!payload || typeof payload !== 'object' || !('state' in payload)) return
    if (payload.state === 'connected') {
      this.options.realtime.setDesktopConnectionState('connected')
      return
    }
    if (payload.state === 'disconnected') {
      this.options.realtime.setDesktopConnectionState(
        'disconnected',
        'reason' in payload && typeof payload.reason === 'string' ? payload.reason : undefined,
      )
    }
  }

  private reportListenerError(error: unknown): void {
    this.options.onListenerError?.(error)
  }
}
