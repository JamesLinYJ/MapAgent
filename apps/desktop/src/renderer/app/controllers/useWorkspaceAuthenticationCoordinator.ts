// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工作区认证协调器
//
//   文件:       useWorkspaceAuthenticationCoordinator.ts
//
//   日期:       2026年07月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { useCallback, useEffect, useRef } from 'react'

import { logout } from '../../api/client'
import { formatUiError } from '../bootstrap'
import type { AuthStatus, DesktopAuthMode } from '../useWorkspaceBootstrap'

interface WorkspaceAuthenticationCoordinatorOptions {
  hasAuthenticatedIdentity: boolean
  authMode: DesktopAuthMode
  authStatus: AuthStatus
  backendOnlineRevision: number
  clearAuth: () => void
  retryAuth: () => void
  setUiError: (message: string | undefined) => void
}

export function shouldRetryAuthentication(
  lastRetriedOnlineRevision: number,
  currentOnlineRevision: number,
  authStatus: AuthStatus,
): boolean {
  return currentOnlineRevision > lastRetriedOnlineRevision && authStatus === 'error'
}

export function useWorkspaceAuthenticationCoordinator({
  hasAuthenticatedIdentity,
  authMode,
  authStatus,
  backendOnlineRevision,
  clearAuth,
  retryAuth,
  setUiError,
}: WorkspaceAuthenticationCoordinatorOptions) {
  // 只在真正发起重试时消耗 online revision。冷启动时后端可能先报
  // online，而早已发起的 Broker 稍后才超时；若在 checking 阶段就把
  // revision 当作已处理，这个唯一恢复信号会被永久丢失。
  const lastRetriedBackendOnlineRevision = useRef(0)
  useEffect(() => {
    if (shouldRetryAuthentication(
      lastRetriedBackendOnlineRevision.current,
      backendOnlineRevision,
      authStatus,
    )) {
      lastRetriedBackendOnlineRevision.current = backendOnlineRevision
      retryAuth()
    }
  }, [authStatus, backendOnlineRevision, retryAuth])

  const handleLogout = useCallback(async () => {
    if (!hasAuthenticatedIdentity) {
      retryAuth()
      return
    }
    try {
      await logout()
    } catch (error) {
      setUiError(formatUiError(error, '退出登录失败。'))
      return
    }
    clearAuth()
    setUiError(undefined)
    if (authMode === 'local_auto') retryAuth()
  }, [
    authMode,
    clearAuth,
    hasAuthenticatedIdentity,
    retryAuth,
    setUiError,
  ])

  return { handleLogout }
}
