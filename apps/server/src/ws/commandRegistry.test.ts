// +-------------------------------------------------------------------------
//
//   地理智能平台 - WS 命令注册表测试
//
//   文件:       commandRegistry.test.ts
//
//   日期:       2026年07月07日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'

import { createDefaultCommandRegistry } from './defaultCommandRegistry.js'
import { WsCommandRegistry } from './commandRegistry.js'
import { clientMsgType, type ClientMsg } from './protocol.js'
import type { AuthContext } from '../security/types.js'
import { wsCommandContracts } from '@geo-agent-platform/shared-types'

describe('WsCommandRegistry', () => {
  it('rejects duplicate command registration', () => {
    const registry = new WsCommandRegistry()
    const definition = {
      type: 'provider:list' as const,
      handler: () => [],
    }

    registry.register(definition)

    expect(() => registry.register(definition)).toThrow("WS 命令 'provider:list' 重复注册")
  })

  it('validates payload schema before executing handlers', async () => {
    const registry = new WsCommandRegistry()
    registry.register({
      type: 'session:get' as const,
      handler: payload => payload.sessionId,
    })

    await expect(registry.execute(message('session:get', { sessionId: '' }), emptyContext()))
      .rejects.toThrow()
  })

  it('requires authenticated context for required commands', async () => {
    const registry = new WsCommandRegistry()
    registry.register({
      type: 'tool:list' as const,
      handler: () => [],
    })

    await expect(registry.execute(message('tool:list', {}), emptyContext()))
      .rejects.toThrow('WebSocket 命令需要登录。')
  })

  it('rejects authenticated commands without an authorization policy', async () => {
    const registry = new WsCommandRegistry()
    registry.register({
      type: 'tool:list' as const,
      handler: () => [],
    })

    await expect(registry.execute(message('tool:list', {}), emptyContext(fakeAuth())))
      .rejects.toThrow("WS 命令 'tool:list' 缺少授权策略。")
  })

  it('在 handler 后使用共享契约校验响应', async () => {
    const registry = new WsCommandRegistry()
    registry.register({ type: 'provider:list', handler: () => ({ invalid: true }) })
    registry.setAuthorize('provider:list', () => {})

    await expect(registry.execute(
      message('provider:list', {}),
      emptyContext(fakeAuth()),
    )).rejects.toThrow()
  })

  it('registers every protocol command exactly once', () => {
    const registry = createDefaultCommandRegistry()
    expect(new Set(registry.registeredTypes())).toEqual(new Set(clientMsgType.options))
  })

  it('derives command semantics from every shared contract', () => {
    const registry = createDefaultCommandRegistry()
    for (const type of clientMsgType.options) {
      const definition = registry.get(type)
      expect(definition).toMatchObject({
        type,
        auth: wsCommandContracts[type].auth,
        csrf: wsCommandContracts[type].csrf,
        category: wsCommandContracts[type].category,
      })
    }
  })

  it('requires a resource key before executing a write command', async () => {
    const registry = new WsCommandRegistry()
    registry.register({
      type: 'thread:update',
      handler: payload => ({
        id: payload.threadId,
        sessionId: 'session_1',
        title: payload.title,
        status: 'active',
        createdAt: '2026-08-31T00:00:00.000Z',
        updatedAt: '2026-08-31T00:00:00.000Z',
      }),
    })
    registry.setAuthorize('thread:update', () => {})

    await expect(registry.execute(
      message('thread:update', { threadId: 'thread_1', title: '更新' }),
      emptyContext(fakeAuth()),
    )).rejects.toThrow("WS 写命令 'thread:update' 缺少变更资源键。")
  })

  it('写命令入队前鉴权并在执行前重验，handler 只执行一次', async () => {
    const registry = new WsCommandRegistry()
    const authorize = vi.fn()
    const handler = vi.fn(() => ({ deleted: true }))
    registry.register({ type: 'tool-catalog:delete', handler })
    registry.setAuthorize('tool-catalog:delete', authorize)
    registry.setMutationResources('tool-catalog:delete', () => ['workspace_1:tool-catalog'])

    await expect(registry.execute(
      message('tool-catalog:delete', { toolKind: 'builtin', toolName: 'search' }),
      emptyContext(fakeAuth()),
    )).resolves.toEqual({ deleted: true })
    expect(authorize).toHaveBeenCalledTimes(2)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('排队后重新鉴权失败时不执行也不重试 handler', async () => {
    const registry = new WsCommandRegistry()
    const authorize = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('权限已撤销'))
    const handler = vi.fn(() => ({ deleted: true }))
    registry.register({ type: 'tool-catalog:delete', handler })
    registry.setAuthorize('tool-catalog:delete', authorize)
    registry.setMutationResources('tool-catalog:delete', () => ['workspace_1:tool-catalog'])

    await expect(registry.execute(
      message('tool-catalog:delete', { toolKind: 'builtin', toolName: 'search' }),
      emptyContext(fakeAuth()),
    )).rejects.toThrow('权限已撤销')
    expect(authorize).toHaveBeenCalledTimes(2)
    expect(handler).not.toHaveBeenCalled()
  })
})

function message(type: ClientMsg['type'], payload: Record<string, unknown>): ClientMsg {
  return { id: 'test', type, payload } as unknown as ClientMsg
}

function emptyContext(auth: AuthContext | null = null): Parameters<WsCommandRegistry['execute']>[1] {
  return {
    dependencies: {} as Parameters<WsCommandRegistry['execute']>[1]['dependencies'],
    runtime: {} as Parameters<WsCommandRegistry['execute']>[1]['runtime'],
    runTasks: {} as Parameters<WsCommandRegistry['execute']>[1]['runTasks'],
    files: {} as Parameters<WsCommandRegistry['execute']>[1]['files'],
    ws: {} as Parameters<WsCommandRegistry['execute']>[1]['ws'],
    subscriptions: new Map(),
    auth,
    connectionId: 'connection_1',
    setResponseDelivery: () => {},
  }
}

function fakeAuth(): AuthContext {
  return {
    userId: 'user_1',
    subject: 'user_1',
    email: 'test@example.com',
    displayName: 'Test User',
    authSessionId: 'session_1',
    authSessionExpiresAt: null,
    csrfToken: 'csrf',
    defaultWorkspaceId: 'workspace_1',
    roles: [{ workspaceId: 'workspace_1', role: 'analyst' }],
  }
}
