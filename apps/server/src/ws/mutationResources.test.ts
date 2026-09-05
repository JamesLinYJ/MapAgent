// +-------------------------------------------------------------------------
//
//   地理智能平台 - WS 写命令资源身份测试
//
//   文件:       mutationResources.test.ts
//
//   日期:       2026年08月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import type { AuthContext } from '../security/types.js'
import type { WsCommandContext } from './commandRegistry.js'
import { wsMutationResourceKeys } from './mutationResources.js'

describe('WS mutation resource identities', () => {
  it('同一带 ID 资源不受连接默认工作区影响，不同 ID 保持并行边界', () => {
    const payload = { threadId: 'thread_shared' }
    const fromWorkspaceA = wsMutationResourceKeys(
      'thread:update',
      payload,
      context('workspace_a'),
    )
    const fromWorkspaceB = wsMutationResourceKeys(
      'thread:update',
      payload,
      context('workspace_b'),
    )
    const differentThread = wsMutationResourceKeys(
      'thread:update',
      { threadId: 'thread_other' },
      context('workspace_a'),
    )

    expect(fromWorkspaceA).toEqual(fromWorkspaceB)
    expect(differentThread).not.toEqual(fromWorkspaceA)
  })

  it('全局配置共享互斥键，工作区内存仍按工作区分离', () => {
    expect(wsMutationResourceKeys(
      'runtime-config:update',
      {},
      context('workspace_a'),
    )).toEqual(wsMutationResourceKeys(
      'runtime-config:update',
      {},
      context('workspace_b'),
    ))
    expect(wsMutationResourceKeys(
      'memory:write',
      {},
      context('workspace_a'),
    )).not.toEqual(wsMutationResourceKeys(
      'memory:write',
      {},
      context('workspace_b'),
    ))
  })

  it('后台任务提升是按任务 ID 串行的写操作', () => {
    expect(wsMutationResourceKeys(
      'background-task:promote',
      { taskId: 'task_1' },
      context('workspace_a'),
    )).toEqual(wsMutationResourceKeys(
      'background-task:cancel',
      { taskId: 'task_1' },
      context('workspace_b'),
    ))
  })
})

function context(defaultWorkspaceId: string): WsCommandContext {
  return {
    auth: auth(defaultWorkspaceId),
  } as WsCommandContext
}

function auth(defaultWorkspaceId: string): AuthContext {
  return {
    userId: 'user_1',
    subject: 'user_1',
    email: 'user@example.test',
    displayName: '测试用户',
    authSessionId: 'auth_session_1',
    authSessionExpiresAt: null,
    csrfToken: 'csrf',
    defaultWorkspaceId,
    roles: [{ workspaceId: defaultWorkspaceId, role: 'analyst' }],
  }
}
