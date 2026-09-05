// +-------------------------------------------------------------------------
//
//   地理智能平台 - 服务生命周期测试
//
//   文件:       lifecycle.test.ts
//
//   日期:       2026年07月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { Server } from 'node:http'
import type { WebSocketServer } from 'ws'
import { describe, expect, it } from 'vitest'
import type { Database } from './db/connection.js'
import type { ApplicationInstanceLock } from './db/applicationInstanceLock.js'
import type { PlatformPersistenceFacade } from './store/platformPersistenceFacade.js'
import { drainApplicationLifecycle } from './lifecycle.js'

describe('application lifecycle drain', () => {
  it('closes admission transports before draining accepted work and durable stores', async () => {
    const events: string[] = []
    const server = {
      close(callback: (error?: Error) => void) {
        events.push('http-close-start')
        queueMicrotask(() => {
          events.push('http-closed')
          callback()
        })
      },
    } as unknown as Server
    const wsServer = {
      clients: new Set([{
        close(code: number) {
          events.push(`ws-client-close-${code}`)
        },
      }]),
      close(callback: () => void) {
        events.push('ws-close-start')
        queueMicrotask(() => {
          events.push('ws-closed')
          callback()
        })
      },
    } as unknown as WebSocketServer

    await drainApplicationLifecycle({
      server,
      wsServer,
      beforeDrain: async () => {
        events.push('tasks-drain')
      },
      store: {
        closeConversationStore: async () => {
          events.push('store-close')
        },
      } as unknown as PlatformPersistenceFacade,
      instanceLock: {
        release: async () => {
          events.push('lock-release')
        },
      } as unknown as ApplicationInstanceLock,
      db: {
        close: async () => {
          events.push('db-close')
        },
      } as unknown as Database,
      onShutdownStart: () => {},
    })

    expect(events.slice(0, 4)).toEqual([
      'http-close-start',
      'ws-client-close-1001',
      'ws-close-start',
      'tasks-drain',
    ])
    expect(events.slice(-3)).toEqual(['store-close', 'lock-release', 'db-close'])
  })
})
