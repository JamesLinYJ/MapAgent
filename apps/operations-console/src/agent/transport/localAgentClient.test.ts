// +-------------------------------------------------------------------------
//
//   地理智能平台 - 本机 Agent WebSocket 客户端测试
//
//   文件:       localAgentClient.test.ts
//
//   日期:       2026年07月27日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { once } from 'node:events'
import { readFile } from 'node:fs/promises'

import type { AddressInfo } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { LocalAgentClient, localAgentWsUrl } from './localAgentClient.js'

const servers: WebSocketServer[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) {
    for (const socket of server.clients) socket.terminate()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

describe('LocalAgentClient', () => {
  it('只消费共享控制信封与命令契约，不维护本地协议副本', async () => {
    const source = await readFile(new URL('./localAgentClient.ts', import.meta.url), 'utf8')
    expect(source).toContain('parseWsControlRequest({')
    expect(source).toContain('wsControlResponseEnvelopeSchema.safeParse(')
    expect(source).toContain('wsServerPushSchema.safeParse(')
    expect(source).not.toContain('const envelopeSchema =')
    expect(source).not.toContain('const RUN_PUSH_TYPES =')
  })

  it('sends the Better Auth cookie, trusted Origin and CSRF metadata over JSONL', async () => {
    const received = vi.fn()
    const server = await openServer((socket, request) => {
      expect(request.headers.cookie).toBe('better-auth.session_token=local')
      expect(request.headers.origin).toBe('http://127.0.0.1:8000')
      socket.on('message', data => {
        const frame: unknown = JSON.parse(data.toString().trim())
        received(frame)
        const id = isRecord(frame) && typeof frame.id === 'string' ? frame.id : null
        const response = `${JSON.stringify({
          type: 'response',
          id,
          payload: { ok: true, data: { unsubscribed: true, runId: 'run_1' } },
        })}\n`
        const midpoint = Math.floor(response.length / 2)
        socket.send(response.slice(0, midpoint))
        socket.send(response.slice(midpoint))
      })
    })
    const client = await connect(server)

    await expect(client.send(
      'run:unsubscribe',
      { runId: 'run_1' },
      z.object({ unsubscribed: z.literal(true), runId: z.literal('run_1') }),
    )).resolves.toEqual({ unsubscribed: true, runId: 'run_1' })

    expect(received).toHaveBeenCalledWith(expect.objectContaining({
      type: 'run:unsubscribe',
      payload: { runId: 'run_1' },
      meta: { csrfToken: 'csrf-local-agent' },
    }))
    client.close()
  })

  it('delivers only recognized server push envelopes', async () => {
    const item = {
      itemId: 'item_1', itemType: 'message', runId: 'run_1', threadId: 'thread_1',
      turnId: null, callId: null, role: 'assistant', body: '', name: null,
      arguments: null, output: null, isError: false, phase: null, status: 'running',
      metadata: {}, timestamp: '2026-08-08T00:00:00.000Z',
    }
    const server = await openServer(socket => {
      setTimeout(() => {
        socket.send(`${JSON.stringify({
          type: 'run.item',
          id: null,
          payload: { data: {
            updateType: 'item_upsert', schemaVersion: 1, streamId: 'stream_1',
            cursor: { sequence: 0, utf16Offset: 0 }, item,
          } },
        })}\n`)
        socket.send(`${JSON.stringify({
          type: 'run.item.delta',
          id: null,
          payload: { data: {
            updateType: 'text_delta', schemaVersion: 1, streamId: 'stream_1',
            runId: 'run_1', threadId: 'thread_1', itemId: 'item_1',
            sequence: 1, utf16Offset: 0, text: '杭州',
          } },
        })}\n`)
        socket.send(`${JSON.stringify({
          type: 'untrusted.extension',
          id: null,
          payload: { data: 'ignored' },
        })}\n`)
      }, 5)
    })
    const client = await connect(server)
    const pushes: string[] = []
    client.onPush(message => pushes.push(message.type))

    await vi.waitFor(() => expect(pushes).toEqual(['run.item', 'run.item.delta']))
    client.close()
  })

  it('disconnects when a recognized push violates its cursor protocol', async () => {
    const server = await openServer(socket => {
      setTimeout(() => socket.send(`${JSON.stringify({
        type: 'run.item.delta', id: null,
        payload: { data: { itemId: 'item_1', text: '杭州' } },
      })}\n`), 5)
    })
    const client = await connect(server)
    const disconnected = vi.fn()
    client.onDisconnected(disconnected)

    await vi.waitFor(() => expect(disconnected).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('不符合协议') }),
    ))
  })

  it('hard-fails malformed protocol responses and rejects pending writes', async () => {
    const server = await openServer(socket => {
      socket.on('message', () => socket.send('{not-json}\n'))
    })
    const client = await connect(server)
    const disconnected = vi.fn()
    client.onDisconnected(disconnected)

    await expect(client.send('run:get', { runId: 'run_1' }, z.unknown()))
      .rejects.toThrow('不是合法 JSON')
    expect(disconnected).toHaveBeenCalledOnce()
  })

  it('即使调用方使用宽松 Schema，也会先按共享命令契约拒绝错误响应', async () => {
    const server = await openServer(socket => {
      socket.on('message', data => {
        const request = JSON.parse(data.toString().trim()) as { id: string }
        socket.send(`${JSON.stringify({
          type: 'response',
          id: request.id,
          payload: { ok: true, data: { status: '伪造成功' } },
        })}\n`)
      })
    })
    const client = await connect(server)

    await expect(client.send('run:get', { runId: 'run_1' }, z.unknown()))
      .rejects.toThrow('不符合共享协议')
    client.close()
  })

  it('rejects requests above the 64 KiB protocol limit before transmission', async () => {
    const received = vi.fn()
    const server = await openServer(socket => socket.on('message', received))
    const client = await connect(server)

    await expect(client.send('run:start', { query: '杭'.repeat(70_000) }, z.unknown()))
      .rejects.toThrow('超过 64 KiB')
    expect(received).not.toHaveBeenCalled()
    client.close()
  })

  it('requires a session cookie and normalizes only HTTP(S) endpoints', async () => {
    expect(localAgentWsUrl('https://example.test:8443/api?secret=no')).toBe('wss://example.test:8443/ws')
    expect(() => localAgentWsUrl('file:///tmp/geo-agent-platform')).toThrow('http 或 https')

    await expect(LocalAgentClient.connect({
      appBaseUrl: 'http://127.0.0.1:1',
      origin: 'http://127.0.0.1:8000',
      headers: new Headers(),
      csrfToken: 'csrf',
      timeoutMs: 10,
    })).rejects.toThrow('缺少 Better Auth Cookie')
  })
})

async function openServer(
  onConnection: (socket: WebSocket, request: import('node:http').IncomingMessage) => void,
): Promise<WebSocketServer> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  servers.push(server)
  server.on('connection', onConnection)
  await once(server, 'listening')
  return server
}

async function connect(server: WebSocketServer): Promise<LocalAgentClient> {
  const address = server.address() as AddressInfo
  return LocalAgentClient.connect({
    appBaseUrl: `http://127.0.0.1:${address.port}`,
    origin: 'http://127.0.0.1:8000',
    headers: new Headers({ cookie: 'better-auth.session_token=local' }),
    csrfToken: 'csrf-local-agent',
    timeoutMs: 2_000,
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
