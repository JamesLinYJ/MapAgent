// +-------------------------------------------------------------------------
//
//   地理智能平台 - 账号中心页面
//
//   文件:       AccountCenterPage.tsx
//
//   日期:       2026年07月09日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { CalendarClock, Fingerprint, LogOut, ShieldCheck, UserRound, UsersRound } from 'lucide-react'
import type { ReactNode } from 'react'
import type { DesktopAuthProjection } from '../../../contracts/desktopIpc'
import { requestDesktopDocument } from '../../app/desktopNavigation'

interface AccountCenterPageProps {
  authMe: DesktopAuthProjection
  onLogout: () => Promise<void> | void
}

export function AccountCenterPage({ authMe, onLogout }: AccountCenterPageProps) {
  const displayName = authMe.user.displayName || authMe.user.email
  const defaultWorkspace = authMe.defaultWorkspace
  const canOpenSecurity = authMe.platformRoles.includes('platform_admin')

  return (
    <main className="account-page ui-page" aria-labelledby="account-page-title">
      <section className="account-shell ui-page__content">
        <header className="account-hero ui-page-header">
          <div>
            <span className="account-eyebrow">工作台账号</span>
            <h1 id="account-page-title">{displayName}</h1>
            <p>查看当前登录身份、工作区成员关系、权限范围和数据处理说明。</p>
          </div>
          <div className="account-hero__actions">
            <button className="account-action account-action--ghost" type="button" onClick={() => requestDesktopDocument('map')}>返回地图</button>
            <button className="account-action account-action--danger" type="button" onClick={() => void onLogout()}>
              <LogOut size={16} aria-hidden="true" />
              退出登录
            </button>
          </div>
        </header>

        <section className="account-grid" aria-label="账号详细信息">
          <article className="account-panel ui-card">
            <PanelHead icon={<UserRound size={18} />} title="身份信息" />
            <dl className="account-kv">
              <Row label="显示名称" value={displayName} />
              <Row label="邮箱" value={authMe.user.email} />
              <Row label="账号状态" value={authMe.user.status === 'active' ? '正常' : '已禁用'} />
              <Row label="最近登录" value={formatDateTime(authMe.user.lastLoginAt)} />
              <Row label="创建时间" value={formatDateTime(authMe.user.createdAt)} />
            </dl>
          </article>

          <article className="account-panel ui-card">
            <PanelHead icon={<UsersRound size={18} />} title="工作区" />
            {defaultWorkspace ? (
              <div className="account-workspace">
                <strong>{defaultWorkspace.name}</strong>
                <span>{defaultWorkspace.description || '暂无描述'}</span>
                <small>{defaultWorkspace.status === 'active' ? '工作区正常' : '工作区已归档'}</small>
              </div>
            ) : (
              <p className="account-muted">当前账号尚未绑定默认工作区。</p>
            )}
            <div className="account-list" aria-label="成员关系">
              {authMe.memberships.map(item => (
                <div key={item.membershipId} className="account-list__item">
                  <span>{shortId(item.workspaceId)}</span>
                  <strong>{formatRoleLabel(item.role)}</strong>
                </div>
              ))}
              {!authMe.memberships.length ? <p className="account-muted">暂无工作区成员关系。</p> : null}
            </div>
          </article>

          <article className="account-panel ui-card">
            <PanelHead icon={<ShieldCheck size={18} />} title="权限与安全" />
            <div className="account-pills" aria-label="平台角色">
              {authMe.platformRoles.length
                ? authMe.platformRoles.map(role => <span key={role}>{formatRoleLabel(role)}</span>)
                : <span>无平台级角色</span>}
            </div>
            <dl className="account-kv account-kv--compact">
              <Row label="权限项" value={`${authMe.permissions.length} 项`} />
              <Row label="请求保护" value="由 Electron 主进程代管" />
              <Row label="会话来源" value="Better Auth HTTP-only Cookie" />
            </dl>
            <div className="account-link-list">
              {canOpenSecurity ? <button type="button" onClick={() => requestDesktopDocument('security')}>打开安全管理</button> : null}
              <button type="button" onClick={() => requestDesktopDocument('privacy')}>查看隐私政策</button>
              <button type="button" onClick={() => requestDesktopDocument('terms')}>查看服务协议</button>
            </div>
          </article>

          <article className="account-panel ui-card">
            <PanelHead icon={<Fingerprint size={18} />} title="数据与隐私" />
            <p className="account-copy">
              本服务使用账号、工作区、运行记录、上传文件、工具调用和审计日志来提供气象分析、地图浏览、
              自动化流程、语音识别授权和安全管理功能。会话 Cookie 与 CSRF 令牌只保留在 Electron 主进程，
              不会投影到工作台 Renderer。
            </p>
            <div className="account-link-list">
              <button type="button" onClick={() => requestDesktopDocument('privacy')}>数据处理详情</button>
              <button type="button" onClick={() => requestDesktopDocument('terms')}>使用边界与责任</button>
            </div>
          </article>

          <article className="account-panel account-panel--wide ui-card">
            <PanelHead icon={<CalendarClock size={18} />} title="当前版本账号能力" />
            <ul className="account-capabilities">
              <li><strong>已启用：</strong>邮箱密码登录、注册、退出、工作区 RBAC、后台禁用用户、审计记录。</li>
              <li><strong>未启用：</strong>自助修改邮箱、找回密码和多因素认证；这些能力需要服务端邮件或额外认证插件后再开放。</li>
              <li><strong>安全边界：</strong>前端只展示当前 session 投影，所有资源访问仍由服务端 Better Auth + Casbin 校验。</li>
            </ul>
          </article>
        </section>
      </section>
    </main>
  )
}

function PanelHead({ icon, title }: { icon: ReactNode; title: string }) {
  return (
    <div className="account-panel__head">
      <span aria-hidden="true">{icon}</span>
      <h2>{title}</h2>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

function formatDateTime(value?: string | null): string {
  if (!value) return '暂无记录'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

function formatRoleLabel(role?: string): string {
  if (role === 'platform_admin') return '平台管理员'
  if (role === 'workspace_admin') return '工作区管理员'
  if (role === 'analyst') return '分析员'
  if (role === 'viewer') return '只读用户'
  return '未分配角色'
}

function shortId(value?: string | null): string {
  if (!value) return '未知工作区'
  return value.length > 18 ? `${value.slice(0, 14)}...` : value
}
