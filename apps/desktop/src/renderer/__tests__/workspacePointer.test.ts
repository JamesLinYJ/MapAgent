// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工作区 URL 指针隔离测试
//
//   文件:       workspacePointer.test.ts
//
//   日期:       2026年07月18日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { readWorkspacePointer, syncCleanWorkspaceUrl } from '../shared/workspacePointer'

describe('workspace pointer ownership', () => {
  beforeEach(() => {
    vi.stubGlobal('window', createWindowStub())
    window.localStorage.clear()
    window.history.replaceState(null, '', '/')
  })

  afterEach(() => vi.unstubAllGlobals())

  it('根路径不会读取旧版全局会话指针', () => {
    window.localStorage.setItem('geo-agent-platform.workspace.pointer.v1', JSON.stringify({
      activeSessionId: 'session_previous_user',
      activeThreadId: 'thread_previous_user',
      activeRunId: 'run_previous_user',
    }))

    expect(readWorkspacePointer()).toEqual({
      activeWorkspaceId: undefined,
      activeSessionId: undefined,
      activeRunId: undefined,
      activeThreadId: undefined,
      sessionSource: undefined,
    })
  })

  it('thread 和 run 选中状态只在所属 session 内恢复', () => {
    syncCleanWorkspaceUrl('session_a', 'run_a', 'thread_a')
    expect(readWorkspacePointer()).toEqual({
      activeWorkspaceId: undefined,
      activeSessionId: 'session_a',
      activeRunId: 'run_a',
      activeThreadId: 'thread_a',
      sessionSource: 'query',
    })

    window.history.replaceState(null, '', '/session/session_b')
    expect(readWorkspacePointer()).toEqual({
      activeWorkspaceId: undefined,
      activeSessionId: 'session_b',
      activeRunId: undefined,
      activeThreadId: undefined,
      sessionSource: 'route',
    })
  })

  it('无效的 route URL 编码会明确失败，不会静默切换会话', () => {
    window.history.replaceState(null, '', '/session/%E0%A4%A')

    expect(() => readWorkspacePointer()).toThrow('会话链接包含无效的 URL 编码。')
  })

  it('空白 route 会话 ID 会明确失败', () => {
    window.history.replaceState(null, '', '/session/%20')

    expect(() => readWorkspacePointer()).toThrow('会话链接缺少有效的会话 ID。')
  })
})

function createWindowStub(): Window {
  const values = new Map<string, string>()
  const location = {
    hash: '',
    href: 'http://127.0.0.1:5173/',
    origin: 'http://127.0.0.1:5173',
    pathname: '/',
    search: '',
  }
  const localStorage = {
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => values.delete(key),
    setItem: (key: string, value: string) => values.set(key, value),
  }
  const history = {
    state: null,
    replaceState: (_state: unknown, _unused: string, url?: string | URL | null) => {
      if (url === undefined || url === null) return
      const next = new URL(String(url), location.origin)
      location.href = next.href
      location.pathname = next.pathname
      location.search = next.search
      location.hash = next.hash
    },
  }
  return { history, localStorage, location } as unknown as Window
}
