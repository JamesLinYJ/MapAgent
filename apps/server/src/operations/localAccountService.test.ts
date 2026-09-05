// +-------------------------------------------------------------------------
//
//   地理智能平台 - 本地特权账户管理服务测试
//
//   文件:       localAccountService.test.ts
//
//   日期:       2026年07月21日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { PlatformUser } from '@geo-agent-platform/shared-types/platform'
import { describe, expect, it, vi } from 'vitest'

import type { Database, DatabaseTransaction } from '../db/connection.js'
import type { LocalConsoleAuthorization } from '../security/authService.js'
import type { LocalManagedAccount } from '../store/postgres/localAccountRepository.js'
import {
  LocalAccountService,
  type LocalAccountServiceDependencies,
} from './localAccountService.js'

const authorization: LocalConsoleAuthorization = {
  authUserId: 'auth_console',
  email: 'console-test@console.geo-agent-platform.invalid',
  keyVersion: 'test-key-version',
  headers: new Headers({ cookie: 'session=test' }),
}

const targetAdmin: LocalManagedAccount = {
  authUserId: 'auth_target',
  email: 'target@example.com',
  displayName: '目标管理员',
  authRole: 'admin',
  banned: false,
  platformUserId: 'user_target',
  platformStatus: 'active',
  platformRoles: [{ workspaceId: 'workspace_target', role: 'platform_admin' }],
}

describe('LocalAccountService', () => {
  it('creates a recovery admin through Better Auth and projects platform roles without auditing the password', async () => {
    const createdPlatformUser = platformUserFor(targetAdmin)
    const audit = vi.fn().mockResolvedValue(undefined)
    const getByEmail = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(targetAdmin)
    const dependencies = createDependencies({
      auth: {
        ...createDependencies().auth,
        createLocalAdminUser: vi.fn().mockResolvedValue({
          id: targetAdmin.authUserId,
          email: targetAdmin.email,
          name: targetAdmin.displayName,
          role: 'admin',
          banned: false,
        }),
      },
      identity: {
        ensureProjection: vi.fn().mockResolvedValue({
          user: createdPlatformUser,
          roles: targetAdmin.platformRoles,
        }),
      },
      accounts: { list: vi.fn(), getByEmail, countActivePlatformAdmins: vi.fn() },
      audit: { recordEvent: audit },
    })
    const service = new LocalAccountService(dependencies)

    await expect(service.createPlatformAdmin({
      email: 'TARGET@example.com',
      displayName: targetAdmin.displayName,
      password: 'correct-horse-battery',
    })).resolves.toEqual(targetAdmin)

    expect(dependencies.auth.createLocalAdminUser).toHaveBeenCalledWith(
      authorization,
      {
        email: targetAdmin.email,
        name: targetAdmin.displayName,
        password: 'correct-horse-battery',
      },
    )
    expect(dependencies.identity.ensureProjection).toHaveBeenCalledWith(expect.objectContaining({
      authUserId: targetAdmin.authUserId,
      bootstrapAdmin: true,
    }))
    expect(JSON.stringify(audit.mock.calls)).not.toContain('correct-horse-battery')
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: null,
      action: 'local_console.admin.create',
      objectId: targetAdmin.platformUserId,
    }))
  })

  it('rejects disabling the last active platform admin before changing either fact source', async () => {
    const dependencies = createDependencies({
      accounts: {
        getByEmail: vi.fn().mockResolvedValue(targetAdmin),
        list: vi.fn().mockResolvedValue([targetAdmin]),
        countActivePlatformAdmins: vi.fn().mockResolvedValue(1),
      },
    })
    const service = new LocalAccountService(dependencies)

    await expect(service.setAccountEnabled(targetAdmin.email, false))
      .rejects.toThrow('最后一个可用的平台管理员')
    expect(dependencies.auth.setLocalUserBanned).not.toHaveBeenCalled()
    expect(dependencies.users.update).not.toHaveBeenCalled()
  })

  it('compensates the Better Auth role when the platform membership transaction fails', async () => {
    const regularTarget: LocalManagedAccount = {
      ...targetAdmin,
      authRole: 'user',
      platformRoles: [{ workspaceId: 'workspace_target', role: 'analyst' }],
    }
    const setRole = vi.fn().mockResolvedValue(undefined)
    const dependencies = createDependencies({
      auth: { ...createDependencies().auth, setLocalAuthRole: setRole },
      accounts: {
        getByEmail: vi.fn().mockResolvedValue(regularTarget),
        list: vi.fn().mockResolvedValue([regularTarget]),
        countActivePlatformAdmins: vi.fn(),
      },
      memberships: {
        insert: vi.fn().mockRejectedValue(new Error('membership failed')),
        deleteRoleBinding: vi.fn(),
        deleteRoleForUser: vi.fn(),
      },
    })
    const service = new LocalAccountService(dependencies)

    await expect(service.grantPlatformAdmin(regularTarget.email))
      .rejects.toThrow('补偿操作已执行')
    expect(setRole.mock.calls).toEqual([
      [authorization, regularTarget.authUserId, ['user', 'admin']],
      [authorization, regularTarget.authUserId, 'user'],
    ])
  })

  it('removes a newly granted platform role when the success audit cannot be persisted', async () => {
    const regularTarget: LocalManagedAccount = {
      ...targetAdmin,
      authRole: 'user',
      platformRoles: [{ workspaceId: 'workspace_target', role: 'analyst' }],
    }
    const setRole = vi.fn().mockResolvedValue(undefined)
    const deleteRole = vi.fn().mockResolvedValue(true)
    const dependencies = createDependencies({
      auth: { ...createDependencies().auth, setLocalAuthRole: setRole },
      accounts: {
        getByEmail: vi.fn().mockResolvedValue(regularTarget),
        list: vi.fn(),
        countActivePlatformAdmins: vi.fn(),
      },
      memberships: {
        insert: vi.fn().mockResolvedValue(true),
        deleteRoleBinding: deleteRole,
        deleteRoleForUser: vi.fn(),
      },
      audit: {
        recordEvent: vi.fn()
          .mockRejectedValueOnce(new Error('audit failed'))
          .mockResolvedValue(undefined),
      },
    })
    const service = new LocalAccountService(dependencies)

    await expect(service.grantPlatformAdmin(regularTarget.email))
      .rejects.toThrow('补偿操作已执行')
    expect(deleteRole).toHaveBeenCalledWith({
      workspaceId: expect.stringMatching(/^workspace_/u),
      userId: regularTarget.platformUserId,
      role: 'platform_admin',
    })
    expect(dependencies.workspaces.ensurePersonal).toHaveBeenCalledWith({
      workspaceId: expect.stringMatching(/^workspace_/u),
      userId: regularTarget.platformUserId,
      displayName: regularTarget.displayName,
    }, expect.anything())
    expect(setRole.mock.calls).toEqual([
      [authorization, regularTarget.authUserId, ['user', 'admin']],
      [authorization, regularTarget.authUserId, 'user'],
    ])
  })

  it('restores both role facts when session revocation fails after administrator removal', async () => {
    const setRole = vi.fn().mockResolvedValue(undefined)
    const insert = vi.fn().mockResolvedValue(true)
    const dependencies = createDependencies({
      auth: {
        ...createDependencies().auth,
        setLocalAuthRole: setRole,
        revokeLocalUserSessions: vi.fn().mockRejectedValue(new Error('session failure')),
      },
      accounts: {
        getByEmail: vi.fn().mockResolvedValue(targetAdmin),
        list: vi.fn(),
        countActivePlatformAdmins: vi.fn().mockResolvedValue(2),
      },
      memberships: {
        insert,
        deleteRoleBinding: vi.fn(),
        deleteRoleForUser: vi.fn().mockResolvedValue([
          { membershipId: 'membership_admin', workspaceId: 'workspace_target' },
        ]),
      },
    })
    const service = new LocalAccountService(dependencies)

    await expect(service.revokePlatformAdmin(targetAdmin.email))
      .rejects.toThrow('重新检查认证角色与平台角色')
    expect(insert).toHaveBeenCalledWith({
      workspaceId: 'workspace_target',
      userId: targetAdmin.platformUserId,
      role: 'platform_admin',
    }, expect.anything())
    expect(setRole.mock.calls).toEqual([
      [authorization, targetAdmin.authUserId, 'user'],
      [authorization, targetAdmin.authUserId, 'admin'],
    ])
  })

  it('resets a password only through Better Auth and revokes all existing sessions', async () => {
    const setPassword = vi.fn().mockResolvedValue(undefined)
    const revokeSessions = vi.fn().mockResolvedValue(undefined)
    const dependencies = createDependencies({
      auth: {
        ...createDependencies().auth,
        setLocalUserPassword: setPassword,
        revokeLocalUserSessions: revokeSessions,
      },
      accounts: {
        getByEmail: vi.fn().mockResolvedValue(targetAdmin),
        list: vi.fn(),
        countActivePlatformAdmins: vi.fn(),
      },
    })
    const service = new LocalAccountService(dependencies)

    await service.resetPassword(targetAdmin.email, 'new-secure-password')

    expect(setPassword).toHaveBeenCalledWith(authorization, targetAdmin.authUserId, 'new-secure-password')
    expect(revokeSessions).toHaveBeenCalledWith(authorization, targetAdmin.authUserId)
  })

  it('allows cleanup of an already banned administrator without misidentifying it as the last usable admin', async () => {
    const bannedTarget = { ...targetAdmin, banned: true }
    const countActive = vi.fn().mockResolvedValue(1)
    const dependencies = createDependencies({
      accounts: {
        getByEmail: vi.fn().mockResolvedValue(bannedTarget),
        list: vi.fn(),
        countActivePlatformAdmins: countActive,
      },
      memberships: {
        insert: vi.fn(),
        deleteRoleBinding: vi.fn(),
        deleteRoleForUser: vi.fn().mockResolvedValue([
          { membershipId: 'membership_admin', workspaceId: 'workspace_target' },
        ]),
      },
    })
    const service = new LocalAccountService(dependencies)

    await expect(service.revokePlatformAdmin(bannedTarget.email)).resolves.toEqual(bannedTarget)
    expect(countActive).not.toHaveBeenCalled()
  })

  it('reports that sessions were revoked when the success audit fails', async () => {
    const audit = vi.fn()
      .mockRejectedValueOnce(new Error('audit failed'))
      .mockResolvedValue(undefined)
    const dependencies = createDependencies({
      accounts: {
        getByEmail: vi.fn().mockResolvedValue(targetAdmin),
        list: vi.fn(),
        countActivePlatformAdmins: vi.fn(),
      },
      audit: { recordEvent: audit },
    })
    const service = new LocalAccountService(dependencies)

    await expect(service.revokeSessions(targetAdmin.email))
      .rejects.toThrow('登录会话已撤销，但审计事件写入失败')
    expect(audit).toHaveBeenLastCalledWith(expect.objectContaining({
      outcome: 'error',
      metadata: expect.objectContaining({ sessionsRevoked: true }),
    }))
  })

  it('opens a fresh Console service-principal session for each write without auditing the root secret', async () => {
    const audit = vi.fn().mockResolvedValue(undefined)
    const dependencies = createDependencies({
      accounts: {
        getByEmail: vi.fn().mockResolvedValue(targetAdmin),
        list: vi.fn(),
        countActivePlatformAdmins: vi.fn(),
      },
      audit: { recordEvent: audit },
    })
    const service = new LocalAccountService(dependencies)

    await service.revokeSessions(targetAdmin.email)

    expect(dependencies.auth.withLocalConsoleAuthorization).toHaveBeenCalledWith(
      'test-root-secret-that-is-long-enough',
      expect.any(Function),
    )
    expect(JSON.stringify(audit.mock.calls)).not.toContain('test-root-secret-that-is-long-enough')
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ authority: 'local_root', rootKeyVersion: 'test-key-version' }),
    }))
  })
})

function createDependencies(
  overrides: Partial<LocalAccountServiceDependencies> = {},
): LocalAccountServiceDependencies {
  const transaction = vi.fn(async (work: (tx: DatabaseTransaction) => Promise<unknown>) => (
    work({} as DatabaseTransaction)
  ))
  return {
    db: { transaction } as unknown as Database,
    auth: {
      createLocalAdminUser: vi.fn(),
      withLocalConsoleAuthorization: vi.fn(async (
        _rootSecret: string,
        action: (value: LocalConsoleAuthorization) => Promise<unknown>,
      ) => action(authorization)),
      setLocalAuthRole: vi.fn(),
      setLocalUserPassword: vi.fn(),
      setLocalUserBanned: vi.fn(),
      revokeLocalUserSessions: vi.fn(),
    },
    identity: { ensureProjection: vi.fn() },
    accounts: { list: vi.fn(), getByEmail: vi.fn(), countActivePlatformAdmins: vi.fn() },
    users: { update: vi.fn() },
    workspaces: { ensurePersonal: vi.fn().mockResolvedValue(undefined) },
    memberships: { insert: vi.fn(), deleteRoleBinding: vi.fn(), deleteRoleForUser: vi.fn() },
    audit: { recordEvent: vi.fn().mockResolvedValue(undefined) },
    actor: { osUser: 'tester', hostname: 'test-host', processId: 42 },
    rootSecret: 'test-root-secret-that-is-long-enough',
    rootKeyVersion: 'test-key-version',
    minPasswordLength: 12,
    ...overrides,
  }
}

function platformUserFor(account: LocalManagedAccount): PlatformUser {
  if (!account.platformUserId || !account.platformStatus) throw new Error('测试账户缺少平台投影。')
  return {
    userId: account.platformUserId,
    subject: account.authUserId,
    email: account.email,
    displayName: account.displayName,
    status: account.platformStatus,
    lastLoginAt: null,
    createdAt: '2026-07-21T00:00:00.000Z',
    updatedAt: '2026-07-21T00:00:00.000Z',
  }
}
