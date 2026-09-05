// +-------------------------------------------------------------------------
//
//   地理智能平台 - 内存事件总线
//
//   文件:       eventBus.ts
//
//   日期:       2026年06月05日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { errorLogPayload, logger } from '../observability/logger.js'

type Listener<T> = (item: T) => void

export class InMemoryEventBus<T> {
  private readonly subscribers = new Map<string, Set<Listener<T>>>()

  subscribe(key: string, listener: Listener<T>): () => void {
    if (!this.subscribers.has(key)) this.subscribers.set(key, new Set())
    this.subscribers.get(key)?.add(listener)
    return () => {
      const listeners = this.subscribers.get(key)
      listeners?.delete(listener)
      if (listeners && listeners.size === 0) this.subscribers.delete(key)
    }
  }

  publish(key: string, item: T): void {
    this.subscribers.get(key)?.forEach(callback => {
      try {
        callback(item)
      } catch (error) {
        logger.error({ error: errorLogPayload(error) }, 'event-bus subscriber failed')
      }
    })
  }

  clear(key: string): void {
    this.subscribers.delete(key)
  }
}
