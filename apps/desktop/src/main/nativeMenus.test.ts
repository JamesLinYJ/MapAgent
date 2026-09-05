// +-------------------------------------------------------------------------
//
//   地理智能平台 - Electron 原生菜单权限测试
//
//   文件:       nativeMenus.test.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { MenuItemConstructorOptions } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const electronState = vi.hoisted(() => ({
  focusedWindow: null as object | null,
  templates: [] as MenuItemConstructorOptions[][],
}))

vi.mock('electron', () => {
  class MockBrowserWindow {
    static getFocusedWindow() {
      return electronState.focusedWindow
    }

    readonly webContents = {
      send: vi.fn(),
      replaceMisspelling: vi.fn(),
      on: vi.fn(),
    }

    focus = vi.fn()
  }
  return {
    app: { showAboutPanel: vi.fn() },
    BrowserWindow: MockBrowserWindow,
    clipboard: { writeText: vi.fn() },
    dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })) },
    Menu: {
      buildFromTemplate: vi.fn((template: MenuItemConstructorOptions[]) => {
        electronState.templates.push(template)
        return { template, popup: vi.fn() }
      }),
      setApplicationMenu: vi.fn(),
      getApplicationMenu: vi.fn(() => null),
    },
  }
})

import { BrowserWindow } from 'electron'
import type { DesktopAuthenticatedIdentity } from './authGateway.js'
import { deriveNativeMenuAccess, installNativeApplicationMenu } from './nativeMenus.js'

describe('native application menu authorization', () => {
  beforeEach(() => {
    electronState.focusedWindow = null
    electronState.templates.length = 0
  })

  it('rebuilds account, security and diagnostics from the current Main identity', async () => {
    let identity: DesktopAuthenticatedIdentity | null = null
    let authorizationChanged = (): void => undefined
    const unsubscribe = vi.fn()
    const shutdown = { requestStopAllAndQuit: vi.fn(async () => 'completed' as const) }
    const dispose = installNativeApplicationMenu({
      authorization: {
        currentAuthorizationContext: () => identity,
        onAuthorizationChanged(listener) {
          authorizationChanged = listener
          return unsubscribe
        },
      },
      shutdown,
      productName: '团队地理工作台',
    })

    expect(menuLabels('管理')).toEqual(['系统日志'])
    expect(menuLabels('工程')).toContain('退出 团队地理工作台')
    expect(menuLabels('帮助')).toContain('关于 团队地理工作台')
    expect(menuLabels('工程')).not.toContain('停止全部并退出')

    identity = authenticated(['viewer'])
    authorizationChanged()
    expect(menuLabels('管理')).toEqual(['账号中心', '系统日志'])
    expect(menuLabels('工程')).not.toContain('停止全部并退出')

    identity = authenticated(['platform_admin'])
    authorizationChanged()
    expect(menuLabels('管理')).toEqual([
      '账号中心',
      '安全管理',
      '配置与诊断',
      '系统日志',
    ])
    expect(menuLabels('工程')).toContain('停止全部并退出')

    const focusedWindow = new BrowserWindow()
    electronState.focusedWindow = focusedWindow
    const shutdownItem = submenu('工程').find(item => item.label === '停止全部并退出')
    shutdownItem?.click?.({} as never, focusedWindow, {} as never)
    await vi.waitFor(() => expect(shutdown.requestStopAllAndQuit).toHaveBeenCalledWith(
      focusedWindow,
    ))

    identity = null
    authorizationChanged()
    expect(menuLabels('管理')).toEqual(['系统日志'])
    expect(menuLabels('工程')).not.toContain('停止全部并退出')

    dispose()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('hides account and security actions for the app-managed local identity', () => {
    expect(deriveNativeMenuAccess(authenticated(['platform_admin']), true, true)).toEqual({
      canAccessAccount: false,
      canAccessDiagnostics: true,
      canAccessSecurity: false,
      canStopAllAndQuit: true,
    })
  })
})

function authenticated(
  platformRoles: DesktopAuthenticatedIdentity['platformRoles'],
): DesktopAuthenticatedIdentity {
  return {
    userId: 'user_1',
    csrfToken: 'main-only-csrf',
    revision: 1,
    platformRoles,
    permissions: [],
  }
}

function menuLabels(label: string): Array<string | undefined> {
  return submenu(label)
    .filter(item => item.type !== 'separator')
    .map(item => item.label)
}

function submenu(label: string): MenuItemConstructorOptions[] {
  const menu = electronState.templates.at(-1)?.find(item => item.label === label)
  return Array.isArray(menu?.submenu) ? menu.submenu : []
}
