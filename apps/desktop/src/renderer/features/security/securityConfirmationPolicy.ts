// +-------------------------------------------------------------------------
//
//   地理智能平台 - 安全管理危险操作确认策略
//
//   文件:       securityConfirmationPolicy.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type {
  AdminMembership,
  PlatformUser,
} from '@geo-agent-platform/shared-types'

import type { DesktopConfirmationRequest } from '../../../contracts/desktopIpc'

export function buildUserStatusConfirmation(
  row: Pick<PlatformUser, 'email' | 'status'>,
): DesktopConfirmationRequest | null {
  if (row.status === 'disabled') return null
  return {
    title: '禁用用户账号',
    message: `确定禁用“${row.email}”吗？`,
    detail: '禁用后该用户的现有会话将失效，并且无法继续登录。恢复账号不需要二次确认。',
    confirmLabel: '禁用并失效会话',
    cancelLabel: '保留账号',
    tone: 'danger',
  }
}

export function buildMembershipRemovalConfirmation(
  row: Pick<AdminMembership, 'email' | 'workspaceId'>,
): DesktopConfirmationRequest {
  return {
    title: '移除工作区成员',
    message: `确定移除“${row.email}”的工作区成员关系吗？`,
    detail: `工作区：${row.workspaceId}。移除后，该用户将失去由此成员关系授予的工作区权限。`,
    confirmLabel: '移除成员',
    cancelLabel: '保留成员',
    tone: 'danger',
  }
}
