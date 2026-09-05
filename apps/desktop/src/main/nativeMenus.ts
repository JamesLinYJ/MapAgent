// +-------------------------------------------------------------------------
//
//   地理智能平台 - Electron 原生菜单
//
//   文件:       nativeMenus.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
  app,
  type BaseWindow,
  BrowserWindow,
  clipboard,
  dialog,
  Menu,
  type MessageBoxOptions,
  type MenuItem,
  type MenuItemConstructorOptions,
} from 'electron'
import { PRODUCT_CODENAME } from '@geo-agent-platform/shared-types/product-identity'

import {
  DESKTOP_IPC_CHANNELS,
  type DesktopMenuCommand,
} from '../contracts/desktopIpc.js'
import type { DesktopAuthenticatedIdentity } from './authGateway.js'
import type { DesktopShutdownCoordinator } from './desktopShutdownCoordinator.js'
import { encodeDesktopEvent } from './eventTransportEncoder.js'

interface NativeMenuAuthorization {
  currentAuthorizationContext(): DesktopAuthenticatedIdentity | null
  onAuthorizationChanged(listener: () => void): () => void
}

export interface NativeApplicationMenuOptions {
  authorization: NativeMenuAuthorization
  shutdown: Pick<DesktopShutdownCoordinator, 'requestStopAllAndQuit'>
  localServiceControl?: boolean
  managedLocalIdentity?: boolean
  productName?: string
}

/**
 * 原生菜单只消费 Main 保存的服务端身份投影。登录、退出或角色变化都会重建
 * 菜单；未认证状态下不把管理入口静态泄露给 Renderer。
 */
export function installNativeApplicationMenu(
  options: NativeApplicationMenuOptions,
): () => void {
  const rebuild = (): void => {
    const access = deriveNativeMenuAccess(
      options.authorization.currentAuthorizationContext(),
      options.localServiceControl ?? true,
      options.managedLocalIdentity ?? false,
    )
    Menu.setApplicationMenu(Menu.buildFromTemplate(applicationMenuTemplate(access, options)))
  }
  const unsubscribe = options.authorization.onAuthorizationChanged(rebuild)
  rebuild()
  return unsubscribe
}

export function popupApplicationMenu(window: BrowserWindow): void {
  Menu.getApplicationMenu()?.popup({
    window,
    x: 8,
    y: 34,
  })
}

export function installNativeContextMenu(window: BrowserWindow): void {
  window.webContents.on('context-menu', (_event, params) => {
    const template: MenuItemConstructorOptions[] = []
    if (params.misspelledWord && params.dictionarySuggestions.length) {
      template.push(
        ...params.dictionarySuggestions.slice(0, 5).map(suggestion => ({
          label: suggestion,
          click: () => window.webContents.replaceMisspelling(suggestion),
        })),
        { type: 'separator' },
      )
    }
    if (params.isEditable) {
      template.push(
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      )
    } else if (params.selectionText) {
      template.push({ role: 'copy', label: '复制' })
    }
    if (params.linkURL) {
      if (template.length) template.push({ type: 'separator' })
      template.push({
        label: '复制链接地址',
        click: () => clipboard.writeText(params.linkURL),
      })
    }
    if (!params.isEditable) {
      if (template.length) template.push({ type: 'separator' })
      template.push(
        {
          label: '返回地图',
          accelerator: 'CommandOrControl+1',
          click: () => sendCommand(window, 'open-map'),
        },
        {
          label: '命令搜索',
          accelerator: 'Alt+Q',
          click: () => sendCommand(window, 'focus-command'),
        },
      )
    }
    Menu.buildFromTemplate(template).popup({ window })
  })
}

export interface NativeMenuAccess {
  canAccessAccount: boolean
  canAccessDiagnostics: boolean
  canAccessSecurity: boolean
  canStopAllAndQuit: boolean
}

export function deriveNativeMenuAccess(
  identity: DesktopAuthenticatedIdentity | null,
  localServiceControl = true,
  managedLocalIdentity = false,
): NativeMenuAccess {
  const platformAdministrator = identity?.platformRoles.includes('platform_admin') ?? false
  return {
    canAccessAccount: identity !== null && !managedLocalIdentity,
    canAccessDiagnostics: platformAdministrator,
    canAccessSecurity: platformAdministrator && !managedLocalIdentity,
    canStopAllAndQuit: platformAdministrator && localServiceControl,
  }
}

function applicationMenuTemplate(
  access: NativeMenuAccess,
  options: NativeApplicationMenuOptions,
): MenuItemConstructorOptions[] {
  const productName = options.productName ?? PRODUCT_CODENAME
  const managementItems = managementMenuItems(access)
  return [
    {
      label: '工程',
      submenu: [
        commandItem('新建分析', 'new-analysis', 'CommandOrControl+N'),
        commandItem('打开工作区', 'open-workspace', 'CommandOrControl+O'),
        { type: 'separator' },
        commandItem('导出成果', 'export-results', 'CommandOrControl+Shift+E'),
        { type: 'separator' },
        { role: 'close', label: '关闭窗口' },
        { role: 'quit', label: `退出 ${productName}` },
        ...(access.canStopAllAndQuit
          ? [
              { type: 'separator' as const },
              {
                label: '停止全部并退出',
                click: (_item: MenuItem, window: BaseWindow | undefined) => {
                  const target = window instanceof BrowserWindow
                    ? window
                    : BrowserWindow.getFocusedWindow()
                  void options.shutdown.requestStopAllAndQuit(target).catch(error => (
                    showShutdownFailure(target, error, productName)
                  ))
                },
              },
            ]
          : []),
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'pasteAndMatchStyle', label: '粘贴并匹配样式' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        commandItem('地图', 'open-map', 'CommandOrControl+1'),
        commandItem('工具与自动化', 'open-tools', 'CommandOrControl+2'),
        commandItem('智能体工作流', 'open-workflow', 'CommandOrControl+3'),
        commandItem('分析结果', 'open-results', 'CommandOrControl+4'),
        { type: 'separator' },
        commandItem('显示/隐藏内容面板', 'toggle-contents', 'CommandOrControl+Alt+L'),
        commandItem('显示/隐藏智能对话', 'toggle-assistant', 'CommandOrControl+Alt+A'),
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大界面' },
        { role: 'zoomOut', label: '缩小界面' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    ...(managementItems.length > 0
      ? [{ label: '管理', submenu: managementItems }]
      : []),
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'close', label: '关闭' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        commandItem('命令搜索', 'focus-command', 'Alt+Q'),
        commandItem('工作台与服务设置', 'open-connection-settings'),
        { type: 'separator' },
        {
          label: `关于 ${productName}`,
          click: (_item, window) => {
            const target = window instanceof BrowserWindow ? window : BrowserWindow.getFocusedWindow()
            app.showAboutPanel()
            target?.focus()
          },
        },
      ],
    },
  ]
}

function managementMenuItems(access: NativeMenuAccess): MenuItemConstructorOptions[] {
  return [
    ...(access.canAccessAccount ? [commandItem('账号中心', 'open-account')] : []),
    ...(access.canAccessSecurity ? [commandItem('安全管理', 'open-security')] : []),
    ...(access.canAccessDiagnostics ? [commandItem('配置与诊断', 'open-diagnostics')] : []),
    // 系统日志是 API/认证离线时的本机恢复入口，不依赖服务端身份投影。
    commandItem('系统日志', 'open-system-logs', 'CommandOrControl+Shift+L'),
  ]
}

function commandItem(
  label: string,
  command: DesktopMenuCommand,
  accelerator?: string,
): MenuItemConstructorOptions {
  return {
    label,
    accelerator,
    click: (_item, window) => {
      const target = window instanceof BrowserWindow ? window : BrowserWindow.getFocusedWindow()
      if (target) sendCommand(target, command)
    },
  }
}

function sendCommand(window: BrowserWindow, command: DesktopMenuCommand): void {
  window.webContents.send(DESKTOP_IPC_CHANNELS.event, encodeDesktopEvent({
    version: 1,
    event: 'desktop:command',
    payload: { command },
  }))
}

async function showShutdownFailure(
  window: BrowserWindow | null,
  error: unknown,
  productName: string,
): Promise<void> {
  const message = error instanceof Error
    ? error.message.replace(/[\r\n]+/gu, ' ').slice(0, 500)
    : '停止后台服务失败。'
  const options: MessageBoxOptions = {
    type: 'error',
    title: '未停止后台服务',
    message,
    detail: `${productName} Desktop 将继续运行；普通退出也不会停止后台服务。`,
    buttons: ['知道了'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  }
  if (window) await dialog.showMessageBox(window, options)
  else await dialog.showMessageBox(options)
}
