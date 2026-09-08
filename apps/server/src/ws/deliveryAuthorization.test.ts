// +-------------------------------------------------------------------------
//
//   地理智能平台 - 实时推送权限生命周期回归
//
//   文件:       deliveryAuthorization.test.ts
//   日期:       2026年09月08日
//   协助:       OpenAI ChatGPT
// --------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'
import type { AuthContext, AuthRoleBinding, AuthorizationScope } from '../security/types.js'
import type { SecurityServices } from '../security/routes.js'
import type { PlatformPersistenceFacade } from '../store/platformPersistenceFacade.js'
import { createWsDeliveryAuthorizer } from './deliveryAuthorization.js'

function fixture() {
  const auth: AuthContext = {
    userId: 'user_1', subject: 'auth_user_1', email: 'user@example.invalid', displayName: 'test',
    authSessionId: 'session_1', authSessionExpiresAt: null, csrfToken: '', defaultWorkspaceId: 'workspace_1',
    roles: [{ role: 'viewer', workspaceId: 'workspace_1' }],
  }
  let active = true
  let roles: AuthRoleBinding[] = [...auth.roles]
  let workspaceId: string | null = 'workspace_1'
  const security = {
    auth: {
      isAuthContextActive: vi.fn(async () => active),
      listUserRoles: vi.fn(async () => roles),
    },
    authorization: {
      can: vi.fn(async (current: AuthContext, _object: string, _action: string, scope: AuthorizationScope) =>
        current.roles.some(binding => binding.workspaceId === scope.workspaceId)),
    },
  } as unknown as SecurityServices
  const store = {
    getRun: vi.fn(() => ({ workspaceId, createdByUserId: 'user_1', visibility: 'workspace' })),
    getThread: vi.fn(() => ({ workspaceId, createdByUserId: 'user_1', visibility: 'workspace' })),
  } as unknown as Pick<PlatformPersistenceFacade, 'getRun' | 'getThread'>
  return {
    auth, security, store,
    authorize: createWsDeliveryAuthorizer({ auth, security, store }),
    expire: () => { active = false },
    revoke: () => { roles = [{ role: 'viewer', workspaceId: 'other_workspace' }] },
    orphan: () => { workspaceId = null },
  }
}

describe('WebSocket outbound authorization', () => {
  it.each(['run', 'thread'] as const)('rechecks current membership for every %s batch, not the handshake snapshot', async object => {
    const f = fixture()
    const scopes = [{ object, resourceId: 'resource_1' }]
    await f.authorize(scopes)
    f.revoke()
    await expect(f.authorize(scopes)).rejects.toThrow('权限已失效')
    expect(f.auth.roles[0]?.workspaceId).toBe('workspace_1')
    expect(f.security.auth.listUserRoles).toHaveBeenCalledTimes(2)
  })

  it('checks session validity even for an idle connection keepalive', async () => {
    const f = fixture()
    await f.authorize([{ object: 'connection' }])
    f.expire()
    await expect(f.authorize([{ object: 'connection' }])).rejects.toThrow('会话已失效')
  })

  it('fails closed on an unknown resource, missing ownership, or unavailable auth store', async () => {
    const f = fixture()
    f.orphan()
    await expect(f.authorize([{ object: 'run', resourceId: 'run_1' }])).rejects.toThrow()
    vi.mocked(f.store.getThread).mockImplementation(() => { throw new Error('deleted') })
    await expect(f.authorize([{ object: 'thread', resourceId: 'gone' }])).rejects.toThrow('deleted')
    vi.mocked(f.security.auth.isAuthContextActive).mockRejectedValue(new Error('database offline'))
    await expect(f.authorize([{ object: 'connection' }])).rejects.toThrow('database offline')
  })

  it('deduplicates scope checks within one synchronous delivery batch without caching across batches', async () => {
    const f = fixture()
    const scopes = Array.from({ length: 10 }, () => ({ object: 'run' as const, resourceId: 'run_1' }))
    await f.authorize(scopes)
    expect(f.security.authorization.can).toHaveBeenCalledTimes(1)
    await f.authorize(scopes)
    expect(f.security.authorization.can).toHaveBeenCalledTimes(2)
  })
})
