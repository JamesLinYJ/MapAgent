// +-------------------------------------------------------------------------
//
//   地理智能平台 - 顶部导航栏组件
//
//   文件:       TopBar.tsx
//
//   日期:       2026年05月09日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

// 模块职责
//
// 提供浅色 Workbench 顶部控制条。它只承接全局导航、工作区和账户入口；
// 运行状态、成果数量与主要操作由各自业务面板负责，避免标题栏形成第二事实源。

import { useState } from 'react'
import { FileText, LockKeyhole, LogOut, Menu, PanelLeft, Search, ShieldCheck, UserRound } from 'lucide-react'
import type { PlatformWorkspace } from '@geo-agent-platform/shared-types'
import type { DesktopAuthProjection } from '../../../contracts/desktopIpc'
import { useProductIdentity } from '../ProductIdentityContext'
import type { DesktopDocument } from './WorkspaceLayout'
import { requestDesktopCommand } from '../desktopNavigation'
import { requireDesktopBridge } from '../../api/transport'

interface TopBarProps {
  authMe: DesktopAuthProjection | null
  workspaces: readonly PlatformWorkspace[]
  activeWorkspaceId: string | null
  managedLocalIdentity?: boolean
  onLogout?: () => Promise<void> | void
  unavailableReason?: string
  onOpenDocument: (document: DesktopDocument) => void
  onOpenWorkspace: (workspaceId: string) => void
}

export function TopBar({
  authMe,
  workspaces,
  activeWorkspaceId,
  managedLocalIdentity = false,
  onLogout,
  unavailableReason,
  onOpenDocument,
  onOpenWorkspace,
}: TopBarProps) {
  const { productName } = useProductIdentity()
  const [accountOpen, setAccountOpen] = useState(false)
  const canOpenSecurity = authMe?.platformRoles.includes('platform_admin') ?? false
  const displayName = authMe ? authMe.user.displayName || authMe.user.email : '本机工作台'
  const roleLabel = authMe
    ? formatRoleLabel(authMe.platformRoles[0] ?? authMe.memberships[0]?.role)
    : '身份待验证'
  const workspaceLabel = authMe?.defaultWorkspace?.name
    ?? shortWorkspaceId(authMe?.defaultWorkspace?.workspaceId ?? authMe?.memberships[0]?.workspaceId)

  return (
    <header className="workbench-chrome">
      <div className="workbench-chrome__left" aria-label="工作台控制">
        <button
          className="workbench-chrome__icon"
          type="button"
          aria-label="打开应用菜单"
          title="应用菜单"
          onClick={() => void requireDesktopBridge().window.command({ action: 'show-application-menu' })}
        >
          <Menu size={18} />
        </button>
        <button
          className="workbench-chrome__icon"
          type="button"
          aria-label="显示或隐藏内容面板"
          title="内容面板 (Ctrl+Alt+L)"
          onClick={() => requestDesktopCommand('toggle-contents')}
        >
          <PanelLeft size={17} />
        </button>
        <button
          className="workbench-chrome__icon"
          type="button"
          aria-label="聚焦命令搜索"
          title="命令搜索 (Alt+Q)"
          onClick={() => requestDesktopCommand('focus-command')}
        >
          <Search size={17} />
        </button>
        <span className="workbench-chrome__divider" />
        <span className="workbench-chrome__brand">
          <strong>{productName}</strong>
          <small>GIS 工作台</small>
        </span>
      </div>

      <div className="workbench-chrome__right">
        {workspaces.length > 0 ? (
          <label className="workbench-workspace-picker">
            <span>工作区</span>
            <select
              id="geo-agent-platform-workspace-picker"
              aria-label="打开工作区窗口"
              value={activeWorkspaceId ?? ''}
              onChange={event => onOpenWorkspace(event.currentTarget.value)}
            >
              {workspaces.map(workspace => (
                <option key={workspace.workspaceId} value={workspace.workspaceId}>
                  {workspace.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {authMe && managedLocalIdentity ? (
          <div
            className="workbench-account"
            role="status"
            aria-label="本机身份：应用自动连接"
            title="由本机客户端自动建立服务会话，无需登录"
          >
            <span className="workbench-account__button">
              <span className="workbench-account__avatar" aria-hidden="true"><ShieldCheck size={14} /></span>
              <span className="workbench-account__copy">
                <strong>本机工作台</strong>
                <small>自动连接</small>
              </span>
            </span>
          </div>
        ) : authMe ? <div className="workbench-account">
          <button
            className="workbench-account__button"
            type="button"
            aria-label={`账号菜单：${displayName}`}
            aria-haspopup="menu"
            aria-expanded={accountOpen}
            onClick={() => setAccountOpen(open => !open)}
          >
            <span className="workbench-account__avatar" aria-hidden="true">{accountInitial(displayName)}</span>
            <span className="workbench-account__copy">
              <strong>{displayName}</strong>
              <small>{roleLabel}</small>
            </span>
          </button>
          {accountOpen ? (
            <div className="workbench-account__menu" role="menu">
              <div className="workbench-account__identity">
                <strong>{displayName}</strong>
                <span>{authMe.user.email}</span>
                <small>{workspaceLabel || '未绑定工作区'}</small>
              </div>
              <button className="workbench-account__item" type="button" role="menuitem" onClick={() => {
                setAccountOpen(false)
                onOpenDocument('account')
              }}>
                <UserRound size={15} aria-hidden="true" />
                <span>账号中心</span>
              </button>
              {canOpenSecurity ? (
                <button className="workbench-account__item" type="button" role="menuitem" onClick={() => {
                  setAccountOpen(false)
                  onOpenDocument('security')
                }}>
                  <ShieldCheck size={15} aria-hidden="true" />
                  <span>安全管理</span>
                </button>
              ) : null}
              <button className="workbench-account__item" type="button" role="menuitem" onClick={() => {
                setAccountOpen(false)
                onOpenDocument('terms')
              }}>
                <FileText size={15} aria-hidden="true" />
                <span>服务协议与隐私政策</span>
              </button>
              {onLogout ? <button
                className="workbench-account__item workbench-account__item--danger"
                type="button"
                role="menuitem"
                onClick={() => {
                  setAccountOpen(false)
                  void onLogout()
                }}
              >
                <LogOut size={15} aria-hidden="true" />
                <span>退出登录</span>
              </button> : null}
            </div>
          ) : null}
        </div> : (
          <div
            className="workbench-account workbench-account--restricted"
            role="status"
            aria-label="身份状态：未验证"
            title={unavailableReason}
          >
            <span className="workbench-account__button">
              <span className="workbench-account__avatar" aria-hidden="true"><LockKeyhole size={13} /></span>
              <span className="workbench-account__copy">
                <strong>{displayName}</strong>
                <small>{roleLabel}</small>
              </span>
            </span>
          </div>
        )}
      </div>
    </header>
  )
}

function accountInitial(value: string): string {
  return value.trim().slice(0, 1).toUpperCase() || 'G'
}

function shortWorkspaceId(value?: string | null): string {
  if (!value) return ''
  return value.length > 14 ? `${value.slice(0, 10)}…` : value
}

function formatRoleLabel(role?: string): string {
  if (role === 'platform_admin') return '平台管理员'
  if (role === 'workspace_admin') return '工作区管理员'
  if (role === 'analyst') return '分析员'
  if (role === 'viewer') return '只读用户'
  return '已登录'
}
