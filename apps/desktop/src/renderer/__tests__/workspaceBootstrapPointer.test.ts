// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工作区启动指针测试
//
//   文件:       workspaceBootstrapPointer.test.ts
//
//   日期:       2026年07月07日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'
import type { DesktopWorkspaceBootstrapSnapshot } from '../../contracts/desktopIpc'

import { loadBootstrapFromWorkspacePointer } from '../app/useWorkspaceBootstrap'
import { PlatformTransportError } from '../api/errors'

describe('loadBootstrapFromWorkspacePointer', () => {
  it('优先使用可访问的分享 session', async () => {
    const calls: Array<string | undefined> = []
    const result = await loadBootstrapFromWorkspacePointer({
      activeSessionId: 'session_shared',
      sessionSource: 'route',
    }, async sessionId => {
      calls.push(sessionId)
      return snapshot(sessionId ?? 'session_default')
    })

    expect(result.session.id).toBe('session_shared')
    expect(calls).toEqual(['session_shared'])
  })

  it('根路径不携带历史用户的 session 指针', async () => {
    const calls: Array<string | undefined> = []
    const result = await loadBootstrapFromWorkspacePointer({}, async sessionId => {
      calls.push(sessionId)
      return snapshot(sessionId ?? 'session_default')
    })

    expect(result.session.id).toBe('session_default')
    expect(calls).toEqual([undefined])
  })

  it('显式 URL session 不可访问时保留权限错误', async () => {
    const calls: Array<string | undefined> = []
    await expect(loadBootstrapFromWorkspacePointer({
      activeSessionId: 'session_foreign',
      sessionSource: 'route',
    }, async sessionId => {
      calls.push(sessionId)
      throw new PlatformTransportError('无权访问该会话。', {
        transport: 'websocket',
        code: 'forbidden',
      })
    })).rejects.toMatchObject({ code: 'forbidden' })
    expect(calls).toEqual(['session_foreign'])
  })
})

function snapshot(sessionId: string): DesktopWorkspaceBootstrapSnapshot {
  const now = '2026-07-07T00:00:00.000Z'
  return {
    auth: {
      user: {
        userId: 'user_1',
        subject: 'user_1',
        email: 'user@example.com',
        displayName: '测试用户',
        status: 'active',
        lastLoginAt: null,
        createdAt: now,
        updatedAt: now,
      },
      defaultWorkspace: {
        workspaceId: 'workspace_1',
        name: '个人工作区',
        description: '',
        status: 'active',
        createdByUserId: 'user_1',
        createdAt: now,
        updatedAt: now,
      },
      memberships: [],
      platformRoles: [],
      permissions: [],
      requestProtection: 'main_managed',
    },
    session: {
      id: sessionId,
      workspaceId: 'workspace_1',
      createdByUserId: 'user_1',
      visibility: 'private',
      createdAt: now,
      status: 'active',
      latestThreadId: null,
      latestRunId: null,
      latestUploadedLayerKey: null,
      latestMeteorologicalDatasetId: null,
    },
    threads: [],
    providers: [],
    tools: [],
  }
}
