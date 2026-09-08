// +-------------------------------------------------------------------------
//
//   地理智能平台 - 出站授权交付队列回归
//
//   文件:       WsDeliveryGate.test.ts
//   日期:       2026年09月08日
//   协助:       OpenAI ChatGPT
// --------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { WsDeliveryGate, type WsDeliveryScope } from './WsDeliveryGate.js'
import {
  clearRunDeliveries, installWsDeliveryAuthorization, reserveRunDelivery, sendRunWs, sendWs,
} from './subscriptions.js'

const scope: WsDeliveryScope = { object: 'run', resourceId: 'run_1' }

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

function socket() {
  let readyState: number = WebSocket.OPEN
  return {
    get readyState() { return readyState },
    bufferedAmount: 0,
    send: vi.fn((_body: string, callback: (error?: Error) => void) => callback()),
    terminate: vi.fn(() => { readyState = WebSocket.CLOSED }),
  } as unknown as WebSocket
}

describe('WsDeliveryGate', () => {
  it('keeps FIFO order and reauthorizes messages added during an earlier check', async () => {
    const blocked = deferred()
    const authorize = vi.fn().mockImplementationOnce(() => blocked.promise).mockResolvedValue(undefined)
    const sent: string[] = []
    const failure = vi.fn()
    const gate = new WsDeliveryGate(authorize, body => { sent.push(body) }, failure)
    gate.enqueue('first', scope)
    gate.enqueue('second', { object: 'thread', resourceId: 'thread_1' })
    expect(sent).toEqual([])
    expect(gate.queuedBytes).toBe(11)
    blocked.resolve()
    await vi.waitFor(() => expect(sent).toEqual(['first', 'second']))
    expect(authorize).toHaveBeenCalledTimes(2)
    expect(authorize.mock.calls[1]?.[0]).toEqual([{ object: 'thread', resourceId: 'thread_1' }])
    expect(gate.queuedBytes).toBe(0)
    expect(failure).not.toHaveBeenCalled()
  })

  it('discards active and queued bodies on denial and never falls back to raw delivery', async () => {
    const blocked = deferred()
    const sent = vi.fn()
    const failure = vi.fn()
    const gate = new WsDeliveryGate(async () => { await blocked.promise; throw new Error('revoked') }, sent, failure)
    gate.enqueue('private A', scope)
    gate.enqueue('private B', scope)
    blocked.resolve()
    await vi.waitFor(() => expect(failure).toHaveBeenCalledOnce())
    gate.enqueue('late private C', scope)
    expect(sent).not.toHaveBeenCalled()
    expect(gate.queuedBytes).toBe(0)
  })

  it('drops late authorization completions after close and releases queued bytes immediately', async () => {
    const blocked = deferred()
    const sent = vi.fn()
    const gate = new WsDeliveryGate(() => blocked.promise, sent, vi.fn())
    gate.enqueue('private', scope)
    gate.dispose()
    expect(gate.queuedBytes).toBe(0)
    blocked.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(sent).not.toHaveBeenCalled()
  })

  it('bounds message count while authorization is stalled, including the active batch', () => {
    const failure = vi.fn()
    const gate = new WsDeliveryGate(() => new Promise(() => {}), vi.fn(), failure, 2)
    gate.enqueue('a', scope)
    gate.enqueue('b', scope)
    gate.enqueue('c', scope)
    expect(failure).toHaveBeenCalledOnce()
    expect(gate.queuedBytes).toBe(0)
  })

  it.each(['direct', 'reserved'] as const)('shares one byte budget with %s messages', mode => {
    const ws = socket()
    installWsDeliveryAuthorization(ws, () => new Promise(() => {}))
    sendRunWs(ws, 'run_1', 'a'.repeat(7 * 1024 * 1024))
    if (mode === 'direct') sendWs(ws, 'b'.repeat(2 * 1024 * 1024))
    else {
      reserveRunDelivery(ws, 'run_2')
      sendRunWs(ws, 'run_2', 'b'.repeat(2 * 1024 * 1024))
    }
    expect(ws.terminate).toHaveBeenCalledOnce()
    expect(ws.send).not.toHaveBeenCalled()
  })

  it('fails closed when a scoped message has no authorization gate', () => {
    const ws = socket()
    sendRunWs(ws, 'run_1', 'private')
    expect(ws.terminate).toHaveBeenCalledOnce()
    expect(ws.send).not.toHaveBeenCalled()
  })

  it('does not revive scoped delivery after the connection queues were cleared', async () => {
    const ws = socket()
    const blocked = deferred()
    installWsDeliveryAuthorization(ws, () => blocked.promise)
    sendRunWs(ws, 'run_1', 'private')
    clearRunDeliveries(ws)
    sendRunWs(ws, 'run_1', 'late private')
    blocked.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(ws.send).not.toHaveBeenCalled()
  })
})
