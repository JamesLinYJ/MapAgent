// +-------------------------------------------------------------------------
//
//   地理智能平台 - Desktop 高风险关闭协调器测试
//
//   文件:       desktopShutdownCoordinator.test.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { BrowserWindow } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { PRODUCT_CODENAME } from '@geo-agent-platform/shared-types/product-identity'

import type { DesktopAuthenticatedIdentity } from './authGateway.js'
import {
  DesktopShutdownCoordinator,
  STOP_ALL_CONFIRMATION_TEXT,
} from './desktopShutdownCoordinator.js'

describe('DesktopShutdownCoordinator', () => {
  it('quits only after an authenticated platform admin confirms and Supervisor succeeds', async () => {
    const order: string[] = []
    const authorization = {
      requireAuthorizationContext: vi.fn(() => administrator()),
    }
    const confirmation = {
      request: vi.fn(async () => {
        order.push('confirmed')
        return STOP_ALL_CONFIRMATION_TEXT
      }),
    }
    const supervisor = {
      shutdown: vi.fn(async () => {
        order.push('shutdown')
        return succeededShutdown()
      }),
    }
    const application = {
      quit: vi.fn(() => {
        order.push('quit')
      }),
    }
    const coordinator = new DesktopShutdownCoordinator(
      authorization,
      supervisor,
      confirmation,
      application,
    )

    await expect(coordinator.requestStopAllAndQuit(null)).resolves.toBe('completed')

    expect(authorization.requireAuthorizationContext).toHaveBeenCalledTimes(2)
    expect(confirmation.request).toHaveBeenCalledWith(null, expect.objectContaining({
      expectedText: STOP_ALL_CONFIRMATION_TEXT,
      message: expect.stringContaining('PostgreSQL/PostGIS'),
      detail: expect.stringContaining(`普通“退出 ${PRODUCT_CODENAME}”不会停止`),
    }))
    expect(order).toEqual(['confirmed', 'shutdown', 'quit'])
  })

  it('fails closed before prompting when the current identity is not platform_admin', async () => {
    const confirmation = { request: vi.fn() }
    const supervisor = { shutdown: vi.fn() }
    const application = { quit: vi.fn() }
    const coordinator = new DesktopShutdownCoordinator(
      { requireAuthorizationContext: () => administrator(['analyst']) },
      supervisor,
      confirmation,
      application,
    )

    await expect(coordinator.requestStopAllAndQuit(null)).rejects.toThrow(
      '只有当前已认证的平台管理员',
    )
    expect(confirmation.request).not.toHaveBeenCalled()
    expect(supervisor.shutdown).not.toHaveBeenCalled()
    expect(application.quit).not.toHaveBeenCalled()
  })

  it('does not contact Supervisor for cancellation, mismatched text, or changed identity', async () => {
    const supervisor = { shutdown: vi.fn() }
    const application = { quit: vi.fn() }
    const canceled = new DesktopShutdownCoordinator(
      { requireAuthorizationContext: () => administrator() },
      supervisor,
      { request: async () => null },
      application,
    )
    await expect(canceled.requestStopAllAndQuit(null)).resolves.toBe('canceled')

    const mismatched = new DesktopShutdownCoordinator(
      { requireAuthorizationContext: () => administrator() },
      supervisor,
      { request: async () => 'stop all' },
      application,
    )
    await expect(mismatched.requestStopAllAndQuit(null)).rejects.toThrow('确认文字不匹配')

    const padded = new DesktopShutdownCoordinator(
      { requireAuthorizationContext: () => administrator() },
      supervisor,
      { request: async () => ` ${STOP_ALL_CONFIRMATION_TEXT} ` },
      application,
    )
    await expect(padded.requestStopAllAndQuit(null)).rejects.toThrow('确认文字不匹配')

    let revision = 1
    const changed = new DesktopShutdownCoordinator(
      {
        requireAuthorizationContext: () => administrator(
          ['platform_admin'],
          revision++,
        ),
      },
      supervisor,
      { request: async () => STOP_ALL_CONFIRMATION_TEXT },
      application,
    )
    await expect(changed.requestStopAllAndQuit(null)).rejects.toThrow(
      '身份或权限已经变化',
    )
    expect(supervisor.shutdown).not.toHaveBeenCalled()
    expect(application.quit).not.toHaveBeenCalled()
  })

  it('keeps Desktop running when Supervisor does not report a successful shutdown', async () => {
    const application = { quit: vi.fn() }
    const coordinator = new DesktopShutdownCoordinator(
      { requireAuthorizationContext: () => administrator() },
      {
        shutdown: async () => ({
          ...succeededShutdown(),
          outcome: 'partial' as const,
          message: 'Worker 未停止。',
        }),
      },
      { request: async () => STOP_ALL_CONFIRMATION_TEXT },
      application,
    )

    await expect(
      coordinator.requestStopAllAndQuit({} as BrowserWindow),
    ).rejects.toThrow('Worker 未停止')
    expect(application.quit).not.toHaveBeenCalled()
  })
})

function administrator(
  platformRoles: DesktopAuthenticatedIdentity['platformRoles'] = ['platform_admin'],
  revision = 1,
): DesktopAuthenticatedIdentity {
  return {
    userId: 'user_1',
    csrfToken: 'main-only-csrf',
    revision,
    platformRoles,
    permissions: [],
  }
}

function succeededShutdown() {
  return {
    operationId: '019fa8d2-d331-7c48-a667-68383b815be6',
    action: 'shutdown' as const,
    target: 'all' as const,
    outcome: 'succeeded' as const,
    message: '监督器与全部受监督服务已关闭。',
    startedAt: '2026-07-29T10:00:00.000Z',
    completedAt: '2026-07-29T10:00:05.000Z',
  }
}
