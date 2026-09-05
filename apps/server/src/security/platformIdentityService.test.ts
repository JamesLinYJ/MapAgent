// +-------------------------------------------------------------------------
//
//   地理智能平台 - 平台身份投影应用服务测试
//
//   文件:       platformIdentityService.test.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { PlatformUser } from '@geo-agent-platform/shared-types/platform'
import { describe, expect, it, vi } from 'vitest'

import type { Database, DatabaseTransaction } from '../db/connection.js'
import {
  PlatformIdentityService,
  type PlatformIdentityDependencies,
} from './platformIdentityService.js'

const activeUser: PlatformUser = {
  userId: 'user_1',
  subject: 'auth_user_1',
  email: 'analyst@example.com',
  displayName: '分析员',
  status: 'active',
  lastLoginAt: '2026-07-16T00:00:00.000Z',
  createdAt: '2026-07-16T00:00:00.000Z',
  updatedAt: '2026-07-16T00:00:00.000Z',
}

describe('PlatformIdentityService', () => {
  it('creates the initial workspace and role in the same transaction as the user projection', async () => {
    const transactionExecutor = {} as DatabaseTransaction
    const transaction = vi.fn(async (work: (tx: DatabaseTransaction) => Promise<unknown>) => (
      work(transactionExecutor)
    ))
    const ensurePersonal = vi.fn().mockResolvedValue(undefined)
    const insertMembership = vi.fn().mockResolvedValue(true)
    const dependencies = createDependencies({
      db: createTestDatabase(transaction),
      users: {
        upsertIdentityProjection: vi.fn().mockResolvedValue({ created: true, user: activeUser }),
        getById: vi.fn(),
        getBySubject: vi.fn(),
      },
      workspaces: { ensurePersonal },
      memberships: {
        insert: insertMembership,
        listRoleBindings: vi.fn().mockResolvedValue([
          { workspaceId: 'workspace_1', role: 'analyst' },
        ]),
      },
    })

    const result = await new PlatformIdentityService(dependencies).ensureProjection({
      platformUserId: activeUser.userId,
      authUserId: activeUser.subject,
      email: activeUser.email,
      displayName: activeUser.displayName,
      personalWorkspaceId: 'workspace_1',
      bootstrapAdmin: false,
    })

    expect(transaction).toHaveBeenCalledTimes(1)
    expect(ensurePersonal).toHaveBeenCalledWith({
      workspaceId: 'workspace_1',
      userId: activeUser.userId,
      displayName: activeUser.displayName,
    }, transactionExecutor)
    expect(insertMembership).toHaveBeenCalledWith({
      workspaceId: 'workspace_1',
      userId: activeUser.userId,
      role: 'analyst',
    }, transactionExecutor)
    expect(result.roles).toEqual([{ workspaceId: 'workspace_1', role: 'analyst' }])
  })

  it('rejects expired or disabled sessions without treating them as active', async () => {
    const getSession = vi.fn()
      .mockResolvedValueOnce({ authUserId: activeUser.subject, expiresAt: new Date(Date.now() - 1_000) })
      .mockResolvedValueOnce({ authUserId: activeUser.subject, expiresAt: new Date(Date.now() + 60_000) })
    const getBySubject = vi.fn().mockResolvedValue({ ...activeUser, status: 'disabled' })
    const dependencies = createDependencies({
      authSessions: {
        get: getSession,
        revokeByAuthUserId: vi.fn(),
      },
      users: {
        upsertIdentityProjection: vi.fn(),
        getById: vi.fn(),
        getBySubject,
      },
    })
    const service = new PlatformIdentityService(dependencies)

    await expect(service.isAuthSessionActive('expired_session')).resolves.toBe(false)
    expect(getBySubject).not.toHaveBeenCalled()
    await expect(service.isAuthSessionActive('disabled_session')).resolves.toBe(false)
    expect(getBySubject).toHaveBeenCalledWith(activeUser.subject)
  })
})

function createDependencies(
  overrides: Partial<PlatformIdentityDependencies> = {},
): PlatformIdentityDependencies {
  const transaction = vi.fn(async (work: (tx: DatabaseTransaction) => Promise<unknown>) => (
    work({} as DatabaseTransaction)
  ))
  return {
    db: createTestDatabase(transaction),
    users: {
      upsertIdentityProjection: vi.fn(),
      getById: vi.fn(),
      getBySubject: vi.fn(),
    },
    workspaces: { ensurePersonal: vi.fn() },
    memberships: { insert: vi.fn(), listRoleBindings: vi.fn() },
    authSessions: { get: vi.fn(), revokeByAuthUserId: vi.fn() },
    ...overrides,
  }
}

function createTestDatabase(transaction: ReturnType<typeof vi.fn>): Database {
  // 该替身只实现应用服务所需的事务端口，不模拟 Drizzle 的其它能力。
  return { transaction } as unknown as Database
}
