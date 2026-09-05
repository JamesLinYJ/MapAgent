// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面工作台访问投影
//
//   文件:       workspaceAccess.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { AuthStatus } from './stores/authStore'
import type { DesktopBackendAvailability } from './stores/backendAvailabilityStore'

export interface DesktopWorkspaceAccess {
  backendActionsEnabled: boolean
  canAccessAccount: boolean
  canAccessDiagnostics: boolean
  canManageRuntimeConfiguration: boolean
  canAccessSecurity: boolean
  statusLabel: string
  unavailableReason?: string
}

export interface DesktopLoginVisibilityInput {
  authMode: 'interactive' | 'local_auto' | 'unknown'
  authStatus: AuthStatus
  backendAvailability: DesktopBackendAvailability
  hasAuthenticatedIdentity: boolean
}

export type ManagedDesktopStartupInput = DesktopLoginVisibilityInput

interface DesktopWorkspaceAccessInput {
  authMode?: 'interactive' | 'local_auto' | 'unknown'
  authStatus: AuthStatus
  backendAvailability: DesktopBackendAvailability
  backendError?: string | null
  authenticationError?: string
  hasAuthenticatedIdentity: boolean
  platformRoles?: readonly string[]
}

/**
 * 认证和后台健康只决定远程能力是否可用，不能决定 Renderer 壳是否挂载。
 * 权限敏感入口采用 fail-closed：只有在线且持有已验证角色时才投影。
 */
export function deriveDesktopWorkspaceAccess(
  input: DesktopWorkspaceAccessInput,
): DesktopWorkspaceAccess {
  const unavailableReason = describeUnavailableReason(input)
  const backendActionsEnabled = unavailableReason === undefined
  const platformAdmin = backendActionsEnabled
    && Boolean(input.platformRoles?.includes('platform_admin'))
  const interactiveIdentity = input.authMode !== 'local_auto'
  const managedLocalConfiguration = backendActionsEnabled && input.authMode === 'local_auto'

  return {
    backendActionsEnabled,
    canAccessAccount: backendActionsEnabled && interactiveIdentity,
    canAccessDiagnostics: platformAdmin,
    canManageRuntimeConfiguration: platformAdmin || managedLocalConfiguration,
    canAccessSecurity: platformAdmin && interactiveIdentity,
    statusLabel: backendActionsEnabled ? '工作台就绪' : statusLabelFor(input),
    ...(unavailableReason ? { unavailableReason } : {}),
  }
}

export function shouldShowDesktopLogin(input: DesktopLoginVisibilityInput): boolean {
  return input.authMode === 'interactive'
    && input.backendAvailability === 'online'
    && input.authStatus === 'unauthenticated'
    && !input.hasAuthenticatedIdentity
}

/**
 * 本机托管模式下，服务健康只是启动的中间状态。只有服务端身份
 * 投影也完成后才能呈现工作台，避免用户进入半成功界面。
 */
export function shouldShowManagedDesktopStartup(input: ManagedDesktopStartupInput): boolean {
  if (input.backendAvailability !== 'online' || input.hasAuthenticatedIdentity) return false
  return input.authMode === 'unknown' || input.authMode === 'local_auto'
}

function describeUnavailableReason(input: DesktopWorkspaceAccessInput): string | undefined {
  if (input.backendAvailability === 'checking') {
    return '正在检查本机服务。地图与本地布局可用，智能对话和数据操作将在连接完成后启用。'
  }
  if (input.backendAvailability === 'starting') {
    return '本机服务正在启动。地图与本地布局可用，智能对话和数据操作暂不可用。'
  }
  if (input.backendAvailability === 'offline') {
    return input.backendError?.trim()
      || '平台 API 当前离线。地图与本地布局仍可使用，智能对话和数据操作已安全禁用。'
  }
  if (input.authStatus === 'checking') {
    return '正在建立可验证的本机会话。工作台不会在身份确认前执行远程操作。'
  }
  if (!input.hasAuthenticatedIdentity || input.authStatus !== 'authenticated') {
    return input.authenticationError?.trim()
      || '尚未建立可验证的服务端身份。地图与本地布局可用，远程操作已安全禁用。'
  }
  return undefined
}

function statusLabelFor(input: DesktopWorkspaceAccessInput): string {
  if (input.backendAvailability === 'checking') return '正在检查服务'
  if (input.backendAvailability === 'starting') return '服务启动中'
  if (input.backendAvailability === 'offline') return '离线工作台'
  if (input.authStatus === 'checking') return '正在认证'
  return '未认证'
}
