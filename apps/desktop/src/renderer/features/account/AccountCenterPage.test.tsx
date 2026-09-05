// +-------------------------------------------------------------------------
//
//   地理智能平台 - 账号中心安全入口测试
//
//   文件:       AccountCenterPage.test.tsx
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import type { DesktopAuthProjection } from '../../../contracts/desktopIpc.js'
import { AccountCenterPage } from './AccountCenterPage.js'

describe('AccountCenterPage security access', () => {
  it('does not expose platform security management to a workspace administrator', () => {
    const html = renderToStaticMarkup(
      <AccountCenterPage authMe={projection([])} onLogout={vi.fn()} />,
    )

    expect(html).not.toContain('打开安全管理')
  })

  it('shows platform security management to a platform administrator', () => {
    const html = renderToStaticMarkup(
      <AccountCenterPage
        authMe={projection(['platform_admin'])}
        onLogout={vi.fn()}
      />,
    )

    expect(html).toContain('打开安全管理')
  })
})

function projection(
  platformRoles: DesktopAuthProjection['platformRoles'],
): DesktopAuthProjection {
  const now = '2026-07-29T00:00:00.000Z'
  return {
    user: {
      userId: 'user_1',
      subject: 'auth_1',
      email: 'admin@example.com',
      displayName: '管理员',
      status: 'active',
      lastLoginAt: now,
      createdAt: now,
      updatedAt: now,
    },
    defaultWorkspace: null,
    memberships: [{
      membershipId: 'membership_1',
      workspaceId: 'workspace_1',
      userId: 'user_1',
      role: 'workspace_admin',
      createdAt: now,
    }],
    platformRoles,
    permissions: [],
    requestProtection: 'main_managed',
  }
}
