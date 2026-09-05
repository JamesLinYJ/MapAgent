// +-------------------------------------------------------------------------
//
//   地理智能平台 - WebSocket 发送边界测试
//
//   文件:       subscriptions.test.ts
//
//   日期:       2026年07月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { WebSocket } from 'ws'
import { describe, expect, it, vi } from 'vitest'
import { analysisRunSchema, conversationItemSchema } from '../schemas/types.js'
import { PlatformEventHub } from '../store/platformEventHub.js'
import {
  clearRunDeliveries,
  reserveRunCapture,
  reserveRunDelivery,
  sendRunSnapshot,
  sendRunWs,
  sendWs,
  subscribeToRun,
  type RunSubscriptionStore,
} from './subscriptions.js'

describe('sendWs transport boundary', () => {
  it('terminates one failed connection when the send callback reports an error', () => {
    const terminate = vi.fn()
    const ws = {
      readyState: WebSocket.OPEN,
      send: vi.fn((_message: string, callback: (error?: Error) => void) => {
        callback(new Error('socket write failed'))
      }),
      terminate,
    } as unknown as WebSocket

    expect(() => sendWs(ws, '{}\n')).not.toThrow()
    expect(terminate).toHaveBeenCalledOnce()
  })

  it('contains synchronous send failures', () => {
    const terminate = vi.fn()
    const ws = {
      readyState: WebSocket.OPEN,
      send: vi.fn(() => {
        throw new Error('socket already closed')
      }),
      terminate,
    } as unknown as WebSocket

    expect(() => sendWs(ws, '{}\n')).not.toThrow()
    expect(terminate).toHaveBeenCalledOnce()
  })

  it('disconnects a slow subscriber before its WebSocket buffer grows without bound', () => {
    const terminate = vi.fn()
    const ws = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 8 * 1024 * 1024,
      send: vi.fn(),
      terminate,
    } as unknown as WebSocket

    sendWs(ws, '{"type":"run.item.delta"}\n')

    expect(ws.send).not.toHaveBeenCalled()
    expect(terminate).toHaveBeenCalledOnce()
  })

  it('delivers a long reserved linked queue in start order when later work finishes first', () => {
    const sent: string[] = []
    const ws = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      send: vi.fn((message: string, callback: (error?: Error) => void) => {
        sent.push(message)
        callback()
      }),
      terminate: vi.fn(),
    } as unknown as WebSocket
    const deliveries = Array.from({ length: 1_000 }, () => reserveRunDelivery(ws, 'run_1'))

    for (let index = deliveries.length - 1; index > 0; index -= 1) {
      deliveries[index]?.(JSON.stringify({ type: 'response', sequence: index }) + '\n')
    }
    sendRunWs(ws, 'run_2', '{"type":"run.event"}\n')

    expect(sent.map(message => JSON.parse(message).type)).toEqual(['run.event'])
    deliveries[0]?.(JSON.stringify({ type: 'response', sequence: 0 }) + '\n')
    deliveries[0]?.(JSON.stringify({ type: 'duplicate', sequence: 0 }) + '\n')
    expect(sent.slice(1).map(message => JSON.parse(message).sequence))
      .toEqual(Array.from({ length: 1_000 }, (_, index) => index))
  })

  it('uses one connection high-water mark for socket and queued bytes', () => {
    const terminate = vi.fn()
    const ws = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 6 * 1024 * 1024,
      send: vi.fn(),
      terminate,
    } as unknown as WebSocket
    const deliverFirst = reserveRunDelivery(ws, 'run_1')

    sendRunWs(ws, 'run_1', 'x'.repeat(3 * 1024 * 1024))
    deliverFirst('{"type":"response"}\n')

    expect(ws.send).not.toHaveBeenCalled()
    expect(terminate).toHaveBeenCalledOnce()
  })

  it('counts reserved run bytes before sending an unrelated direct message', () => {
    let readyState: number = WebSocket.OPEN
    const terminate = vi.fn(() => { readyState = WebSocket.CLOSED })
    const ws = {
      get readyState() { return readyState },
      bufferedAmount: 0,
      send: vi.fn(),
      terminate,
    } as unknown as WebSocket
    reserveRunDelivery(ws, 'run_1')

    sendRunWs(ws, 'run_1', 'x'.repeat(7 * 1024 * 1024))
    sendWs(ws, 'y'.repeat(2 * 1024 * 1024))

    expect(ws.send).not.toHaveBeenCalled()
    expect(terminate).toHaveBeenCalledOnce()
    expect(readyState).toBe(WebSocket.CLOSED)
  })

  it('sends full item states and body deltas as distinct correlated pushes', () => {
    const sent: string[] = []
    const ws = {
      readyState: WebSocket.OPEN,
      send: vi.fn((message: string, callback: (error?: Error) => void) => {
        sent.push(message)
        callback()
      }),
      terminate: vi.fn(),
    } as unknown as WebSocket
    const events = new PlatformEventHub()
    const store = {
      getRun: () => ({ id: 'run_1' }),
    } as unknown as RunSubscriptionStore
    const subscriptions = new Map<string, () => void>()
    const item = conversationItemSchema.parse({
      itemId: 'item_1', itemType: 'message', runId: 'run_1', role: 'assistant',
      body: '', status: 'running', timestamp: new Date(0).toISOString(),
    })
    subscribeToRun(ws, 'run_1', store, events, subscriptions)

    events.conversationItemUpserts.publish('run_1', {
      updateType: 'item_upsert', schemaVersion: 1, streamId: 'stream_1',
      cursor: { sequence: 0, utf16Offset: 0 }, item,
    })
    events.conversationItemDeltas.publish('run_1', {
      updateType: 'text_delta', schemaVersion: 1, streamId: 'stream_1',
      runId: 'run_1', threadId: null, itemId: 'item_1',
      sequence: 1, utf16Offset: 0, text: '杭州',
    })

    expect(sent.map(message => JSON.parse(message).type)).toEqual(['run.item', 'run.item.delta'])
    expect(JSON.parse(sent[1] ?? '{}').payload.data).toMatchObject({
      streamId: 'stream_1', sequence: 1, utf16Offset: 0, text: '杭州',
    })
    subscriptions.get('run_1')?.()
  })

  it('serializes concurrent snapshot capture and delivery per connection and run', async () => {
    const sent: string[] = []
    const ws = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      send: vi.fn((message: string, callback: (error?: Error) => void) => {
        sent.push(message)
        callback()
      }),
      terminate: vi.fn(),
    } as unknown as WebSocket
    const run = analysisRunSchema.parse({
      id: 'run_1', sessionId: 'session_1', threadId: 'thread_1', visibility: 'workspace',
      userQuery: '测试', status: 'completed', createdAt: new Date(0).toISOString(),
      updatedAt: new Date(1).toISOString(),
      state: { sessionId: 'session_1', threadId: 'thread_1', userQuery: '测试' },
    })
    const oldItem = conversationItemSchema.parse({
      itemId: 'item_1', itemType: 'message', runId: 'run_1', threadId: 'thread_1',
      role: 'assistant', body: '部分', status: 'running', timestamp: new Date(0).toISOString(),
    })
    const finalItem = conversationItemSchema.parse({
      ...oldItem, body: '部分正文已完成', status: 'completed',
    })
    let calls = 0
    let releaseOldSnapshot!: () => void
    const oldSnapshotBlocked = new Promise<void>(resolve => { releaseOldSnapshot = resolve })
    const store: RunSubscriptionStore = {
      getRun: () => run,
      getThread: () => ({}),
      listPresentationSnapshot: async () => {
        calls += 1
        if (calls === 1) {
          await oldSnapshotBlocked
          return {
            items: [oldItem],
            events: [],
            itemStream: {
              streamId: 'stream_old',
              cursors: [{ itemId: oldItem.itemId, sequence: 1, utf16Offset: 2 }],
            },
            sourceSequence: 1,
          }
        }
        return {
          items: [finalItem],
          events: [],
          itemStream: {
            streamId: 'stream_new',
            cursors: [{ itemId: finalItem.itemId, sequence: 0, utf16Offset: 7 }],
          },
          sourceSequence: 2,
        }
      },
    }

    const first = sendRunSnapshot(ws, 'run_1', store)
    await vi.waitFor(() => expect(calls).toBe(1))
    const second = sendRunSnapshot(ws, 'run_1', store)
    await Promise.resolve()
    expect(calls).toBe(1)
    releaseOldSnapshot()
    await Promise.all([first, second])

    expect(sent.map(message => JSON.parse(message).payload.data.itemStream.streamId))
      .toEqual(['stream_old', 'stream_new'])
  })

  it('keeps one capture in flight while 1000 run updates request snapshots', async () => {
    let readyState: number = WebSocket.OPEN
    const ws = {
      get readyState() { return readyState },
      bufferedAmount: 0,
      send: vi.fn((_message: string, callback: (error?: Error) => void) => callback()),
      terminate: vi.fn(() => { readyState = WebSocket.CLOSED }),
    } as unknown as WebSocket
    const events = new PlatformEventHub()
    const subscriptions = new Map<string, () => void>()
    let releaseFirstCapture!: () => void
    const firstCaptureBlocked = new Promise<void>(resolve => { releaseFirstCapture = resolve })
    let calls = 0
    let inFlight = 0
    let maxInFlight = 0
    const store = {
      getRun: () => ({ id: 'run_1' }),
      getThread: () => ({}),
      listPresentationSnapshot: async () => {
        calls += 1
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        try {
          await firstCaptureBlocked
          return {
            items: [],
            events: [],
            itemStream: { streamId: 'stream_1', cursors: [] },
            sourceSequence: 0,
          }
        } finally {
          inFlight -= 1
        }
      },
    } as unknown as RunSubscriptionStore
    subscribeToRun(ws, 'run_1', store, events, subscriptions)

    for (let index = 0; index < 1_000; index += 1) {
      events.runs.publish('run_1', { id: 'run_1' } as never)
    }
    await vi.waitFor(() => expect(calls).toBe(1))
    expect(maxInFlight).toBe(1)

    readyState = WebSocket.CLOSED
    clearRunDeliveries(ws)
    releaseFirstCapture()
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toBe(1)
    subscriptions.get('run_1')?.()
  })

  it('detaches linked queues on normal close so late capture and delivery callbacks are inert', async () => {
    let readyState: number = WebSocket.OPEN
    const sent: string[] = []
    const ws = {
      get readyState() { return readyState },
      bufferedAmount: 0,
      send: vi.fn((message: string, callback: (error?: Error) => void) => {
        sent.push(message)
        callback()
      }),
      terminate: vi.fn(),
    } as unknown as WebSocket
    let releaseCapture!: () => void
    const captureBlocked = new Promise<void>(resolve => { releaseCapture = resolve })
    const capture = reserveRunCapture<string>(ws, 'run_1')
    const result = capture.start(async () => {
      await captureBlocked
      return 'late snapshot'
    })
    sendRunWs(ws, 'run_1', '{"type":"run.event"}\n')

    readyState = WebSocket.CLOSED
    clearRunDeliveries(ws)
    capture.deliver('{"type":"response"}\n')
    releaseCapture()

    await expect(result).rejects.toThrow('closed')
    await Promise.resolve()
    expect(sent).toEqual([])
  })

  it('terminates and clears reserved deliveries when snapshot projection fails', async () => {
    const sent: string[] = []
    let readyState: number = WebSocket.OPEN
    const terminate = vi.fn(() => { readyState = WebSocket.CLOSED })
    const ws = {
      get readyState() { return readyState },
      bufferedAmount: 0,
      send: vi.fn((message: string, callback: (error?: Error) => void) => {
        sent.push(message)
        callback()
      }),
      terminate,
    } as unknown as WebSocket
    const store = {
      getRun: () => { throw new Error('must not project a failed snapshot') },
      getThread: () => ({}),
      listPresentationSnapshot: async () => { throw new Error('snapshot storage failed') },
    } as RunSubscriptionStore

    const failedSnapshot = sendRunSnapshot(ws, 'run_1', store)
    sendRunWs(ws, 'run_1', '{"type":"run.item"}\n')
    await failedSnapshot

    expect(sent).toEqual([])
    expect(terminate).toHaveBeenCalledOnce()
    expect(readyState).toBe(WebSocket.CLOSED)
  })
})
