// +-------------------------------------------------------------------------
//
//   地理智能平台 - Desktop 高风险关闭协调器
//
//   文件:       desktopShutdownCoordinator.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { BrowserWindow } from 'electron'
import type { OperationsOperationResult } from '@geo-agent-platform/shared-types/operations'
import { PRODUCT_CODENAME } from '@geo-agent-platform/shared-types/product-identity'

import type { DesktopAuthenticatedIdentity } from './authGateway.js'

export const STOP_ALL_CONFIRMATION_TEXT = '停止全部'

export interface DesktopShutdownAuthorization {
  requireAuthorizationContext(): DesktopAuthenticatedIdentity
}

export interface DesktopShutdownSupervisor {
  shutdown(): Promise<OperationsOperationResult>
}

export interface DesktopShutdownConfirmation {
  request(
    parent: BrowserWindow | null,
    input: {
      title: string
      message: string
      detail: string
      expectedText: string
    },
  ): Promise<string | null>
}

export interface DesktopShutdownApplication {
  quit(): void
}

/**
 * 普通 Electron 退出不经过本协调器。只有原生高风险菜单显式调用时，才会
 * 重新验证 Main 身份、要求输入确认短语，并通过本机 token 握手后的
 * Supervisor 专用 shutdown 方法停止三个后台服务。
 */
export class DesktopShutdownCoordinator {
  constructor(
    private readonly authorization: DesktopShutdownAuthorization,
    private readonly supervisor: DesktopShutdownSupervisor,
    private readonly confirmation: DesktopShutdownConfirmation,
    private readonly application: DesktopShutdownApplication,
    private readonly productName = PRODUCT_CODENAME,
  ) {}

  async requestStopAllAndQuit(parent: BrowserWindow | null): Promise<'canceled' | 'completed'> {
    const initialIdentity = requirePlatformAdministrator(
      this.authorization.requireAuthorizationContext(),
    )
    const enteredText = await this.confirmation.request(parent, {
      title: `停止全部服务并退出 ${this.productName}`,
      message: '此操作会停止 API、Python Worker、PostgreSQL/PostGIS，并关闭本机监督器。',
      detail: `正在运行的分析、上传和后台任务会被中断。普通“退出 ${this.productName}”不会停止这些服务。`,
      expectedText: STOP_ALL_CONFIRMATION_TEXT,
    })
    if (enteredText === null) return 'canceled'
    if (enteredText !== STOP_ALL_CONFIRMATION_TEXT) {
      throw new Error(`确认文字不匹配；请输入“${STOP_ALL_CONFIRMATION_TEXT}”。`)
    }

    const confirmedIdentity = requirePlatformAdministrator(
      this.authorization.requireAuthorizationContext(),
    )
    if (
      confirmedIdentity.userId !== initialIdentity.userId
      || confirmedIdentity.revision !== initialIdentity.revision
    ) {
      throw new Error('确认期间桌面身份或权限已经变化，未停止后台服务。')
    }

    const result = await this.supervisor.shutdown()
    if (
      result.action !== 'shutdown'
      || result.target !== 'all'
      || result.outcome !== 'succeeded'
    ) {
      throw new Error(result.message || '监督器未确认全部服务已经停止。')
    }
    this.application.quit()
    return 'completed'
  }
}

function requirePlatformAdministrator(
  identity: DesktopAuthenticatedIdentity,
): DesktopAuthenticatedIdentity {
  if (!identity.platformRoles.includes('platform_admin')) {
    throw new Error('只有当前已认证的平台管理员可以停止全部后台服务。')
  }
  return identity
}
