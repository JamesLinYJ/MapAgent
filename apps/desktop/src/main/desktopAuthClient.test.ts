// +-------------------------------------------------------------------------
//
//   地理智能平台 - Electron 进程内认证客户端测试
//
//   文件:       desktopAuthClient.test.ts
//
//   日期:       2026年08月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'

import { InMemoryDesktopAuthClient } from './desktopAuthClient.js'

describe('InMemoryDesktopAuthClient', () => {
  it('只在当前实例内存中保存服务端会话 Cookie', async () => {
    const fetchApi = vi.fn(async () => new Response(JSON.stringify({ user: { id: 'user_1' } }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'set-cookie': 'better-auth.session_token=session_1; Path=/; HttpOnly; SameSite=Lax',
      },
    }))
    const first = new InMemoryDesktopAuthClient('http://127.0.0.1:8000', fetchApi)
    const second = new InMemoryDesktopAuthClient('http://127.0.0.1:8000', fetchApi)

    await first.signIn.email({ email: 'user@example.com', password: 'test-password' })

    expect(first.getCookie()).toBe('better-auth.session_token=session_1')
    expect(second.getCookie()).toBe('')
    expect(fetchApi).toHaveBeenCalledWith(
      'http://127.0.0.1:8000/api/auth/sign-in/email',
      expect.objectContaining({ credentials: 'omit', redirect: 'error' }),
    )
  })

  it('发送后续请求时使用内存 Cookie，退出后立即清空', async () => {
    const fetchApi = vi.fn()
      .mockResolvedValueOnce(new Response('{}', {
        status: 200,
        headers: { 'set-cookie': 'better-auth.session_token=session_1; Path=/; HttpOnly' },
      }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    const client = new InMemoryDesktopAuthClient('http://127.0.0.1:8000', fetchApi)
    await client.signIn.email({ email: 'user@example.com', password: 'test-password' })

    await client.signOut()

    const signOutHeaders = new Headers(fetchApi.mock.calls[1]?.[1]?.headers)
    expect(signOutHeaders.get('cookie')).toBe('better-auth.session_token=session_1')
    expect(client.getCookie()).toBe('')
  })

  it('把服务端认证失败收窄为稳定错误且不保存 Cookie', async () => {
    const client = new InMemoryDesktopAuthClient(
      'http://127.0.0.1:8000',
      async () => Response.json({ message: '账号或密码错误' }, { status: 401 }),
    )

    const result = await client.signIn.email({
      email: 'user@example.com',
      password: 'wrong-password',
    })

    expect(result).toEqual({
      data: null,
      error: { message: '账号或密码错误', statusText: 'HTTP 401' },
    })
    expect(client.getCookie()).toBe('')
  })
})
