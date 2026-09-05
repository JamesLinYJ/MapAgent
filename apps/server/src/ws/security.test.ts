// +-------------------------------------------------------------------------
//
//   地理智能平台 - WebSocket 授权策略测试
//
//   文件:       security.test.ts
//
//   日期:       2026年08月20日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5
//
//   维护记录 (2026-08-30):
//     作者: JamesLinYJ
//     协助: OpenAI Codex:GPT-5.6 Sol
//     说明: 补充对话用量命令按目标资源工作区、所有者与可见性授权的回归。
// --------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'
import type { WsControlCommand } from '@geo-agent-platform/shared-types'

import type { AuthContext } from '../security/types.js'
import type { WsCommandContext, WsCommandRegistry } from './commandRegistry.js'
import { registerWsAuthorizationPolicies } from './security.js'

type Authorize = NonNullable<Parameters<WsCommandRegistry['setAuthorize']>[1]>

const localDesktopAuth: AuthContext = {
  userId: 'user_local_desktop',
  subject: 'auth_local_desktop',
  email: 'desktop@local-desktop.geo-agent-platform.invalid',
  displayName: '本机工作台',
  authSessionId: 'auth_session_local_desktop',
  authSessionExpiresAt: '2099-01-01T00:00:00.000Z',
  csrfToken: 'csrf_local_desktop',
  defaultWorkspaceId: 'workspace_local_desktop',
  roles: [{ workspaceId: 'workspace_local_desktop', role: 'analyst' }],
}

describe('WebSocket runtime configuration authorization', () => {
  it.each([
    ['provider:custom:list', 'read'],
    ['provider:credential:stage', 'update'],
    ['provider:custom:discover-models', 'update'],
    ['provider:custom:test', 'update'],
    ['provider:custom:upsert', 'update'],
    ['provider:custom:delete', 'update'],
    ['tool-catalog:upsert', 'update'],
    ['tool-catalog:delete', 'update'],
    ['runtime-config:update', 'update'],
  ] as const)('grants the protected local desktop only %s configuration access', async (command, action) => {
    const { audit, enforce, invoke } = policyHarness()

    await invoke(command, localDesktopAuth)

    expect(enforce).not.toHaveBeenCalled()
    expect(audit).toHaveBeenCalledWith(
      localDesktopAuth,
      'runtime_config',
      action,
      { workspaceId: localDesktopAuth.defaultWorkspaceId },
      'allowed',
      { wsCommand: command, principalType: 'local_desktop' },
    )
  })

  it('keeps remote analyst configuration access behind Casbin and records the concrete command', async () => {
    const { enforce, invoke } = policyHarness()
    const remoteAnalyst: AuthContext = {
      ...localDesktopAuth,
      userId: 'user_remote_analyst',
      subject: 'auth_remote_analyst',
      email: 'analyst@example.com',
    }

    await invoke('tool-catalog:upsert', remoteAnalyst)

    expect(enforce).toHaveBeenCalledWith(
      remoteAnalyst,
      'runtime_config',
      'update',
      { workspaceId: remoteAnalyst.defaultWorkspaceId },
      { wsCommand: 'tool-catalog:upsert' },
    )
  })

  it('执行授权前重新读取当前角色，并拒绝已经失去全部工作区角色的连接', async () => {
    const remoteAnalyst: AuthContext = {
      ...localDesktopAuth,
      userId: 'user_revoked',
      subject: 'auth_revoked',
      email: 'revoked@example.com',
    }
    const { enforce, invoke, listUserRoles } = policyHarness({ currentRoles: [] })

    await expect(invoke('runtime-config:update', remoteAnalyst))
      .rejects.toThrow('已失去工作区权限')
    expect(listUserRoles).toHaveBeenCalledWith(remoteAnalyst.userId)
    expect(enforce).not.toHaveBeenCalled()
  })
})

describe('WebSocket thread usage authorization', () => {
  it('uses the target thread workspace, owner, and visibility scope', async () => {
    const targetThread = {
      id: 'thread_secondary_private',
      workspaceId: 'workspace_secondary',
      createdByUserId: 'user_thread_owner',
      visibility: 'private',
    }
    const secondaryWorkspaceAuth: AuthContext = {
      ...localDesktopAuth,
      roles: [
        ...localDesktopAuth.roles,
        { workspaceId: 'workspace_secondary', role: 'viewer' },
      ],
    }
    const { assertResourceWorkspace, getThread, invoke } = policyHarness({ targetThread })

    await invoke('usage:thread-summary', secondaryWorkspaceAuth, { threadId: targetThread.id })

    expect(getThread).toHaveBeenCalledWith(targetThread.id)
    expect(assertResourceWorkspace).toHaveBeenCalledWith(
      secondaryWorkspaceAuth,
      'thread',
      'read',
      {
        workspaceId: targetThread.workspaceId,
        createdByUserId: targetThread.createdByUserId,
        visibility: targetThread.visibility,
        resourceId: targetThread.id,
      },
    )
  })

  it('rejects an unauthorized target thread before usage aggregation', async () => {
    const targetThread = {
      id: 'thread_foreign_private',
      workspaceId: 'workspace_foreign',
      createdByUserId: 'user_foreign',
      visibility: 'private',
    }
    const { invoke } = policyHarness({
      targetThread,
      denyResource: true,
    })

    await expect(invoke('usage:thread-summary', localDesktopAuth, {
      threadId: targetThread.id,
    })).rejects.toThrow('无权查看目标对话')
  })
})

function policyHarness(options: {
  targetThread?: {
    id: string
    workspaceId: string
    createdByUserId: string
    visibility: string
  }
  denyResource?: boolean
  currentRoles?: AuthContext['roles']
} = {}): {
  authorizers: Map<string, Authorize>
  audit: ReturnType<typeof vi.fn>
  enforce: ReturnType<typeof vi.fn>
  assertResourceWorkspace: ReturnType<typeof vi.fn>
  getThread: ReturnType<typeof vi.fn>
  listUserRoles: ReturnType<typeof vi.fn>
  invoke(command: WsControlCommand, auth: AuthContext, payload?: Record<string, unknown>): Promise<void>
} {
  const authorizers = new Map<string, Authorize>()
  const registry = {
    setAuthorize: vi.fn((type: string, authorize: Authorize) => {
      authorizers.set(type, authorize)
    }),
  } as unknown as WsCommandRegistry
  const audit = vi.fn(async () => undefined)
  const enforce = vi.fn(async () => undefined)
  const assertResourceWorkspace = vi.fn(async () => {
    if (options.denyResource) throw new Error('无权查看目标对话。')
  })
  const getThread = vi.fn((threadId: string) => {
    if (!options.targetThread || options.targetThread.id !== threadId) {
      throw new Error(`对话 '${threadId}' 不存在。`)
    }
    return options.targetThread
  })
  let invokedRoles = localDesktopAuth.roles
  const listUserRoles = vi.fn(async (_userId: string) => options.currentRoles ?? invokedRoles)
  registerWsAuthorizationPolicies(registry)
  return {
    authorizers,
    audit,
    enforce,
    assertResourceWorkspace,
    getThread,
    listUserRoles,
    async invoke(command, auth, payload = {}) {
      invokedRoles = auth.roles
      const authorize = authorizers.get(command)
      if (!authorize) throw new Error(`命令 '${command}' 没有授权策略。`)
      await authorize(payload, {
        msg: { type: command, id: 'request_test', payload },
        auth,
        dependencies: {
          store: { getThread },
          security: {
            auth: {
              isAuthContextActive: vi.fn(async () => true),
              listUserRoles,
            },
            authorization: { audit, enforce, assertResourceWorkspace },
          },
        },
      } as unknown as WsCommandContext)
    },
  }
}
