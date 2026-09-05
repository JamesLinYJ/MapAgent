// +-------------------------------------------------------------------------
//
//   地理智能平台 - Electron WebSocket 认证边界测试
//
//   文件:       controlGateway.test.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { BrowserWindow } from 'electron'
import { describe, expect, it, vi } from 'vitest'

const socketState = vi.hoisted(() => ({
  sentFrames: [] as string[],
  closedWith: [] as Array<{ code: number; reason: string }>,
  nextResponse: null as string | null,
}))

vi.mock('ws', () => {
  class MockWebSocket {
    static readonly CONNECTING = 0
    static readonly OPEN = 1
    static readonly CLOSING = 2
    static readonly CLOSED = 3

    readyState = MockWebSocket.CONNECTING
    onopen: (() => void) | null = null
    onerror: (() => void) | null = null
    onmessage: ((event: { data: string }) => void) | null = null
    onclose: ((event: { code: number; reason: string }) => void) | null = null

    constructor(
      readonly url: string,
      readonly options: { headers?: Record<string, string>; origin?: string },
    ) {
      queueMicrotask(() => {
        this.readyState = MockWebSocket.OPEN
        this.onopen?.()
      })
    }

    send(value: string): void {
      socketState.sentFrames.push(value)
      const frame = JSON.parse(value) as { id: string }
      queueMicrotask(() => {
        this.onmessage?.({
          data: socketState.nextResponse ?? JSON.stringify({
              type: 'response',
              id: frame.id,
              payload: {
                ok: true,
                data: {
                  id: 'session_1',
                  visibility: 'workspace',
                  createdAt: '2026-08-31T00:00:00.000Z',
                },
              },
            }),
        })
        socketState.nextResponse = null
      })
    }

    close(code = 1000, reason = ''): void {
      socketState.closedWith.push({ code, reason })
      this.readyState = MockWebSocket.CLOSED
      queueMicrotask(() => this.onclose?.({ code, reason }))
    }
  }

  return { default: MockWebSocket }
})

import {
  DesktopControlGateway,
  type DesktopControlAuthorization,
} from './controlGateway.js'

describe('DesktopControlGateway authorization', () => {
  it('builds WS CSRF metadata exclusively from the Main authorization context', async () => {
    socketState.sentFrames.length = 0
    socketState.closedWith.length = 0
    const authorization: DesktopControlAuthorization = {
      cookieHeader: () => 'better-auth.session_token=main-only-cookie',
      requireAuthorizationContext: () => ({
        userId: 'user_1',
        csrfToken: 'main-only-csrf',
        revision: 7,
      }),
      onAuthorizationChanged: () => () => undefined,
    }
    const gateway = new DesktopControlGateway('http://127.0.0.1:8000', authorization)
    const window = fakeWindow()

    const response = await gateway.handle(window, {
      version: 1,
      requestId: crypto.randomUUID(),
      command: 'session:get-default',
      payload: {},
    })

    expect(response.ok).toBe(true)
    const frame = JSON.parse(socketState.sentFrames[0] ?? '{}') as {
      meta?: { csrfToken?: string }
    }
    expect(frame.meta?.csrfToken).toBe('main-only-csrf')
    expect(JSON.stringify(response)).not.toContain('main-only-csrf')
    expect(JSON.stringify(response)).not.toContain('main-only-cookie')
    gateway.close()
  })

  it('rejects control commands before opening a socket when Main has no authorization', async () => {
    socketState.sentFrames.length = 0
    socketState.closedWith.length = 0
    const authorization: DesktopControlAuthorization = {
      cookieHeader: () => '',
      requireAuthorizationContext: () => {
        throw new Error('not authenticated')
      },
      onAuthorizationChanged: () => () => undefined,
    }
    const gateway = new DesktopControlGateway('http://127.0.0.1:8000', authorization)

    const response = await gateway.handle(fakeWindow(), {
      version: 1,
      requestId: crypto.randomUUID(),
      command: 'session:get-default',
      payload: {},
    })

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'unauthorized' },
    })
    expect(socketState.sentFrames).toEqual([])
    gateway.close()
  })

  it('用应用关闭码拒绝无效控制帧，不触发 Electron InvalidAccessError', async () => {
    socketState.sentFrames.length = 0
    socketState.closedWith.length = 0
    socketState.nextResponse = 'not-json'
    const authorization: DesktopControlAuthorization = {
      cookieHeader: () => 'better-auth.session_token=test',
      requireAuthorizationContext: () => ({
        userId: 'user_1',
        csrfToken: 'csrf',
        revision: 1,
      }),
      onAuthorizationChanged: () => () => undefined,
    }
    const gateway = new DesktopControlGateway('http://127.0.0.1:8000', authorization)

    const response = await gateway.handle(fakeWindow(), {
      version: 1,
      requestId: crypto.randomUUID(),
      command: 'session:get-default',
      payload: {},
    })

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'control_unavailable',
        message: '服务端返回了无效控制帧。',
      },
    })
    expect(socketState.closedWith).toContainEqual({
      code: 4002,
      reason: '服务端返回了无效控制帧。',
    })
    gateway.close()
  })

  it('Main 使用共享命令契约拒绝信封合法但正文错误的响应', async () => {
    socketState.sentFrames.length = 0
    socketState.closedWith.length = 0
    const authorization: DesktopControlAuthorization = {
      cookieHeader: () => 'better-auth.session_token=test',
      requireAuthorizationContext: () => ({
        userId: 'user_1',
        csrfToken: 'csrf',
        revision: 1,
      }),
      onAuthorizationChanged: () => () => undefined,
    }
    const gateway = new DesktopControlGateway('http://127.0.0.1:8000', authorization)
    const requestId = crypto.randomUUID()
    socketState.nextResponse = JSON.stringify({
      type: 'response',
      id: requestId,
      payload: { ok: true, data: { fake: 'success' } },
    })

    const response = await gateway.handle(fakeWindow(), {
      version: 1,
      requestId,
      command: 'session:get-default',
      payload: {},
    })

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'control_unavailable' },
    })
    expect(socketState.closedWith).toContainEqual({
      code: 4002,
      reason: '服务端返回了无效控制响应。',
    })
    gateway.close()
  })
})

function fakeWindow(): BrowserWindow {
  return {
    webContents: {
      id: Math.floor(Math.random() * 1_000_000) + 1,
      send: vi.fn(),
    },
    isDestroyed: () => false,
    once: vi.fn(),
  } as unknown as BrowserWindow
}
