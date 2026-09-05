// +-------------------------------------------------------------------------
//
//   地理智能平台 - 安全管理后台
//
//   文件:       SecurityAdminPage.tsx
//
//   日期:       2026年07月02日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { useEffect, useMemo, useState } from 'react'
import type {
  AdminMembership,
  AuditEvent,
  PlatformRole,
  PlatformUser,
  PlatformWorkspace,
  RbacPolicyRow,
} from '@geo-agent-platform/shared-types'
import {
  createAdminMembership,
  createAdminWorkspace,
  deleteAdminMembership,
  listAdminMemberships,
  listAdminRoles,
  listAdminUsers,
  listAdminWorkspaces,
  listAuditEvents,
  updateAdminUser,
} from '../../api/client'
import { requireDesktopBridge } from '../../api/transport'
import {
  buildMembershipRemovalConfirmation,
  buildUserStatusConfirmation,
} from './securityConfirmationPolicy'

type View = 'users' | 'workspaces' | 'memberships' | 'roles' | 'audit'
type AdminTableRow = PlatformUser | PlatformWorkspace | AdminMembership | RbacPolicyRow | AuditEvent
type AdminTableColumn = Readonly<{ key: string; label: string }>

const VIEWS: Array<{ id: View; label: string }> = [
  { id: 'users', label: '用户' },
  { id: 'workspaces', label: '工作区' },
  { id: 'memberships', label: '成员' },
  { id: 'roles', label: '权限矩阵' },
  { id: 'audit', label: '审计日志' },
]

const SECURITY_COLUMNS: Readonly<Record<View, readonly AdminTableColumn[]>> = {
  users: [
    { key: 'email', label: '邮箱' },
    { key: 'displayName', label: '显示名称' },
    { key: 'status', label: '状态' },
    { key: 'lastLoginAt', label: '最后登录时间' },
  ],
  workspaces: [
    { key: 'workspaceId', label: '工作区标识' },
    { key: 'name', label: '名称' },
    { key: 'status', label: '状态' },
    { key: 'createdByUserId', label: '创建者标识' },
  ],
  memberships: [
    { key: 'email', label: '邮箱' },
    { key: 'displayName', label: '显示名称' },
    { key: 'role', label: '角色' },
    { key: 'workspaceId', label: '工作区标识' },
  ],
  roles: [
    { key: 'ptype', label: '策略类型' },
    { key: 'v0', label: '主体' },
    { key: 'v1', label: '工作区' },
    { key: 'v2', label: '资源' },
    { key: 'v3', label: '操作' },
    { key: 'v4', label: '效果' },
  ],
  audit: [
    { key: 'createdAt', label: '发生时间' },
    { key: 'actorUserId', label: '操作者标识' },
    { key: 'workspaceId', label: '工作区标识' },
    { key: 'objectType', label: '对象类型' },
    { key: 'action', label: '操作' },
    { key: 'outcome', label: '结果' },
  ],
}

export default function SecurityAdminPage() {
  const [view, setView] = useState<View>('users')
  const [users, setUsers] = useState<PlatformUser[]>([])
  const [workspaces, setWorkspaces] = useState<PlatformWorkspace[]>([])
  const [memberships, setMemberships] = useState<AdminMembership[]>([])
  const [roles, setRoles] = useState<RbacPolicyRow[]>([])
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([])
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState('')
  const [workspaceName, setWorkspaceName] = useState('')
  const [workspaceDescription, setWorkspaceDescription] = useState('')
  const [memberUserId, setMemberUserId] = useState('')
  const [memberRole, setMemberRole] = useState<PlatformRole>('analyst')
  const [errorMessage, setErrorMessage] = useState<string>()
  const [isLoading, setIsLoading] = useState(false)

  const defaultWorkspaceId = selectedWorkspaceId || workspaces[0]?.workspaceId || ''

  async function refresh() {
    setIsLoading(true)
    setErrorMessage(undefined)
    try {
      const [nextUsers, nextWorkspaces, nextRoles, nextAudit] = await Promise.all([
        listAdminUsers(),
        listAdminWorkspaces(),
        listAdminRoles(),
        listAuditEvents(),
      ])
      setUsers(nextUsers)
      setWorkspaces(nextWorkspaces)
      setRoles(nextRoles)
      setAuditEvents(nextAudit)
      const workspaceId = selectedWorkspaceId || nextWorkspaces[0]?.workspaceId || ''
      setSelectedWorkspaceId(workspaceId)
      setMemberships(workspaceId ? await listAdminMemberships(workspaceId) : [])
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
    // 首次进入后台时加载完整安全投影；后续刷新由用户明确触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function refreshMemberships(workspaceId = defaultWorkspaceId) {
    if (!workspaceId) return
    await runAdminMutation(async () => {
      setSelectedWorkspaceId(workspaceId)
      setMemberships(await listAdminMemberships(workspaceId))
    })
  }

  async function handleCreateWorkspace() {
    if (!workspaceName.trim()) return
    await runAdminMutation(async () => {
      await createAdminWorkspace({ name: workspaceName.trim(), description: workspaceDescription.trim() })
      setWorkspaceName('')
      setWorkspaceDescription('')
      await refresh()
    })
  }

  async function handleAddMembership() {
    if (!defaultWorkspaceId || !memberUserId) return
    await runAdminMutation(async () => {
      await createAdminMembership({ workspaceId: defaultWorkspaceId, userId: memberUserId, role: memberRole })
      setMemberships(await listAdminMemberships(defaultWorkspaceId))
    })
  }

  async function handleToggleUser(row: PlatformUser) {
    await runAdminMutation(async () => {
      const confirmation = buildUserStatusConfirmation(row)
      if (confirmation) {
        const confirmed = await requireDesktopBridge().dialog.confirm(confirmation)
        if (!confirmed) return
      }
      await updateAdminUser(row.userId, { status: row.status === 'disabled' ? 'active' : 'disabled' })
      await refresh()
    })
  }

  async function handleDeleteMembership(row: AdminMembership) {
    await runAdminMutation(async () => {
      const confirmed = await requireDesktopBridge().dialog.confirm(
        buildMembershipRemovalConfirmation(row),
      )
      if (!confirmed) return
      await deleteAdminMembership(row.membershipId)
      if (defaultWorkspaceId) setMemberships(await listAdminMemberships(defaultWorkspaceId))
    })
  }

  async function runAdminMutation(action: () => Promise<void>) {
    setErrorMessage(undefined)
    try {
      await action()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const currentRows = useMemo<AdminTableRow[]>(() => {
    if (view === 'users') return users
    if (view === 'workspaces') return workspaces
    if (view === 'memberships') return memberships
    if (view === 'roles') return roles
    return auditEvents
  }, [auditEvents, memberships, roles, users, view, workspaces])
  const columns = SECURITY_COLUMNS[view]
  const hasActions = view === 'users' || view === 'memberships'

  return (
    <main className="digital-cartographer dc-security-page ui-page">
      <section className="dc-security-shell ui-page__content">
        <header className="dc-security-header ui-page-header">
          <div>
            <span className="dc-card__eyebrow">安全管理</span>
            <h1>身份、工作区与权限</h1>
          </div>
          <button className="dc-action-button" type="button" onClick={() => void refresh()} disabled={isLoading}>
            刷新
          </button>
        </header>
        {errorMessage ? <p className="dc-auth-card__error">{errorMessage}</p> : null}
        <nav className="dc-security-tabs" aria-label="安全管理视图">
          {VIEWS.map(item => (
            <button key={item.id} type="button" className={view === item.id ? 'is-active' : ''} onClick={() => setView(item.id)}>
              {item.label}
            </button>
          ))}
        </nav>
        {view === 'workspaces' ? (
          <form className="dc-security-form" onSubmit={(event) => { event.preventDefault(); void handleCreateWorkspace() }}>
            <input aria-label="工作区名称" value={workspaceName} onChange={event => setWorkspaceName(event.target.value)} placeholder="工作区名称" />
            <input aria-label="工作区说明" value={workspaceDescription} onChange={event => setWorkspaceDescription(event.target.value)} placeholder="说明" />
            <button className="dc-action-button dc-action-button--primary" type="submit">创建工作区</button>
          </form>
        ) : null}
        {view === 'memberships' ? (
          <form className="dc-security-form" onSubmit={(event) => { event.preventDefault(); void handleAddMembership() }}>
            <select aria-label="工作区" value={selectedWorkspaceId} onChange={event => void refreshMemberships(event.target.value)}>
              {workspaces.map(workspace => <option key={workspace.workspaceId} value={workspace.workspaceId}>{workspace.name}</option>)}
            </select>
            <select aria-label="用户" value={memberUserId} onChange={event => setMemberUserId(event.target.value)}>
              <option value="">选择用户</option>
              {users.map(user => <option key={user.userId} value={user.userId}>{user.email}</option>)}
            </select>
            <select aria-label="工作区角色" value={memberRole} onChange={event => setMemberRole(event.target.value as PlatformRole)}>
              <option value="workspace_admin">工作区管理员</option>
              <option value="analyst">分析员</option>
              <option value="viewer">只读用户</option>
            </select>
            <button className="dc-action-button dc-action-button--primary" type="submit">添加成员</button>
          </form>
        ) : null}
        <div className="dc-security-table-wrap">
          <table className="dc-security-table">
            <thead>
              <tr>
                {columns.map(column => <th key={column.key} scope="col">{column.label}</th>)}
                {hasActions ? <th scope="col">操作</th> : null}
              </tr>
            </thead>
            <tbody>
              {currentRows.length === 0 ? (
                <tr>
                  <td className="dc-security-table__empty" colSpan={columns.length + (hasActions ? 1 : 0)}>
                    {isLoading ? '正在加载安全数据…' : '当前视图暂无数据。'}
                  </td>
                </tr>
              ) : currentRows.map((row, index) => (
                <tr key={rowKey(row, view, index)}>
                  {columns.map(column => (
                    <td key={column.key} data-label={column.label}>
                      {formatCell(column.key, cellValue(row, column.key))}
                    </td>
                  ))}
                  {view === 'users' && isPlatformUser(row) ? (
                    <td data-label="操作">
                      <button
                        type="button"
                        title={row.status === 'disabled' ? '恢复后用户可重新登录' : '禁用后该用户现有会话将失效'}
                        onClick={() => void handleToggleUser(row)}
                      >
                        {row.status === 'disabled' ? '恢复' : '禁用并失效会话'}
                      </button>
                    </td>
                  ) : null}
                  {view === 'memberships' && isAdminMembership(row) ? (
                    <td data-label="操作">
                      <button type="button" onClick={() => void handleDeleteMembership(row)}>移除</button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  )
}

function cellValue(row: AdminTableRow, column: string): unknown {
  return (row as unknown as Record<string, unknown>)[column]
}

function isPlatformUser(row: AdminTableRow): row is PlatformUser {
  return 'subject' in row && 'lastLoginAt' in row
}

function isAdminMembership(row: AdminTableRow): row is AdminMembership {
  return 'membershipId' in row && 'email' in row
}

function rowKey(row: AdminTableRow, view: View, index: number): string {
  if ('membershipId' in row) return `membership-${row.membershipId}`
  if ('auditEventId' in row) return `audit-${row.auditEventId}`
  if ('ptype' in row) return `policy-${row.ptype}-${row.v0}-${row.v1}-${row.v2}-${row.v3}-${row.v4}-${index}`
  if ('userId' in row) return `user-${row.userId}`
  if ('workspaceId' in row) return `workspace-${row.workspaceId}`
  return `${view}-${index}`
}

function formatCell(column: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'object') return JSON.stringify(value)
  const translated = CELL_VALUE_LABELS[column]?.[String(value)]
  if (translated) return translated
  return String(value)
}

const CELL_VALUE_LABELS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  status: {
    active: '启用',
    disabled: '禁用',
    archived: '已归档',
  },
  role: {
    platform_admin: '平台管理员',
    workspace_admin: '工作区管理员',
    analyst: '分析员',
    viewer: '查看者',
  },
  ptype: {
    p: '权限策略',
    g: '角色绑定',
  },
  outcome: {
    allowed: '允许',
    denied: '拒绝',
    error: '错误',
  },
}
