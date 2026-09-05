// +-------------------------------------------------------------------------
//
//   地理智能平台 - 安全管理危险操作确认测试
//
//   文件:       SecurityAdminPage.test.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import SecurityAdminPage from './SecurityAdminPage.js'
import {
  buildMembershipRemovalConfirmation,
  buildUserStatusConfirmation,
} from './securityConfirmationPolicy.js'

describe('SecurityAdminPage confirmation policy', () => {
  it('uses localized column labels and a visible empty state', () => {
    const html = renderToStaticMarkup(createElement(SecurityAdminPage))

    expect(html).toContain('邮箱')
    expect(html).toContain('显示名称')
    expect(html).toContain('最后登录时间')
    expect(html).toContain('当前视图暂无数据。')
    expect(html).not.toContain('>displayName<')
    expect(html).not.toContain('>lastLoginAt<')
  })

  it('requires a danger confirmation before disabling an active user', () => {
    expect(buildUserStatusConfirmation({
      email: 'analyst@example.com',
      status: 'active',
    })).toEqual({
      title: '禁用用户账号',
      message: '确定禁用“analyst@example.com”吗？',
      detail: '禁用后该用户的现有会话将失效，并且无法继续登录。恢复账号不需要二次确认。',
      confirmLabel: '禁用并失效会话',
      cancelLabel: '保留账号',
      tone: 'danger',
    })
  })

  it('allows account recovery without a destructive confirmation', () => {
    expect(buildUserStatusConfirmation({
      email: 'disabled@example.com',
      status: 'disabled',
    })).toBeNull()
  })

  it('requires a danger confirmation before removing a membership', () => {
    expect(buildMembershipRemovalConfirmation({
      email: 'member@example.com',
      workspaceId: 'workspace_yuhang',
    })).toEqual({
      title: '移除工作区成员',
      message: '确定移除“member@example.com”的工作区成员关系吗？',
      detail: '工作区：workspace_yuhang。移除后，该用户将失去由此成员关系授予的工作区权限。',
      confirmLabel: '移除成员',
      cancelLabel: '保留成员',
      tone: 'danger',
    })
  })
})
