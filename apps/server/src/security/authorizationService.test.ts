// +-------------------------------------------------------------------------
//
//   地理智能平台 - Casbin 授权服务单元测试
//
//   文件:       authorizationService.test.ts
//
//   日期:       2026年07月03日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'

import type { Database } from '../db/connection.js'
import type { AuditStore } from '../store/postgres/auditStore.js'
import {
  actionMatch,
  AuthorizationService,
  formatAuthorizationDeniedMessage,
} from './authorizationService.js'
import type { AuthContext } from './types.js'

/**
 * 直接测试生产 actionMatch 函数的逻辑，
 * 确保 policy action 不被当成正则：`read|create` 不应匹配 `reader`。
 */
describe('Casbin actionMatch', () => {
  it('matches exact action in pipe-delimited policy', () => {
    expect(actionMatch('read', 'read|create')).toBe(true)
    expect(actionMatch('create', 'read|create')).toBe(true)
    expect(actionMatch('update', 'read|create')).toBe(false)
    expect(actionMatch('delete', 'read|create')).toBe(false)
  })

  it('matches wildcard policy', () => {
    expect(actionMatch('read', '*')).toBe(true)
    expect(actionMatch('admin', '*')).toBe(true)
    expect(actionMatch('execute', '*')).toBe(true)
  })

  it('rejects non-string inputs', () => {
    expect(actionMatch(null, 'read')).toBe(false)
    expect(actionMatch('read', null)).toBe(false)
    expect(actionMatch(123, 'read')).toBe(false)
    expect(actionMatch('read', 456)).toBe(false)
  })

  it('does not treat policy action as regex — read|create does not match reader', () => {
    expect(actionMatch('reader', 'read|create')).toBe(false)
    expect(actionMatch('creater', 'read|create')).toBe(false)
  })

  it('tolerates whitespace around pipe segments', () => {
    expect(actionMatch('read', 'read | create')).toBe(true)
    expect(actionMatch('create', ' read|create ')).toBe(true)
  })

  it('rejects superstring matches', () => {
    expect(actionMatch('read', 'reader')).toBe(false)
    expect(actionMatch('create', 'recreate')).toBe(false)
  })
})

describe('AuthorizationService audit workspace boundary', () => {
  it('does not write an untrusted requested workspace into the audit foreign key', async () => {
    const recordEvent = vi.fn(async () => undefined)
    const service = new AuthorizationService(
      {} as Database,
      { recordEvent } as unknown as AuditStore,
    )

    await service.audit(
      {
        userId: 'user_1',
        roles: [{ role: 'viewer', workspaceId: 'workspace_owned' }],
      } as AuthContext,
      'workspace',
      'read',
      { workspaceId: 'workspace_unknown' },
      'denied',
    )

    expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: null,
      metadata: { requestedWorkspaceId: 'workspace_unknown' },
    }))
  })

  it('keeps a workspace foreign key when the actor has a binding to it', async () => {
    const recordEvent = vi.fn(async () => undefined)
    const service = new AuthorizationService(
      {} as Database,
      { recordEvent } as unknown as AuditStore,
    )

    await service.audit(
      {
        userId: 'user_1',
        roles: [{ role: 'viewer', workspaceId: 'workspace_owned' }],
      } as AuthContext,
      'workspace',
      'read',
      { workspaceId: 'workspace_owned' },
      'denied',
    )

    expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'workspace_owned',
      metadata: {},
    }))
  })
})

describe('AuthorizationService user-facing denial messages', () => {
  it('does not expose internal admin/admin policy names', () => {
    const message = formatAuthorizationDeniedMessage('admin', 'admin')

    expect(message).toBe('当前身份没有执行平台管理操作的权限。')
    expect(message).not.toContain('admin')
  })

  it('describes the requested resource and action in product language', () => {
    expect(formatAuthorizationDeniedMessage('runtime_config', 'update'))
      .toBe('当前身份没有修改运行配置的权限。')
    expect(formatAuthorizationDeniedMessage('layer', 'delete', 'hangzhou_districts'))
      .toBe('当前身份没有删除“hangzhou_districts”图层的权限。')
  })
})
