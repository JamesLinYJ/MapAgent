// +-------------------------------------------------------------------------
//
//   地理智能平台 - Electron 工作区窗口注册表
//
//   文件:       windowRegistry.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { app, BrowserWindow, dialog, shell } from 'electron'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import windowStateKeeper from 'electron-window-state'
import {
  PLATFORM_DESKTOP_APP_ORIGIN,
  PRODUCT_CODENAME,
} from '@geo-agent-platform/shared-types/product-identity'

import {
  DESKTOP_IPC_CHANNELS,
  desktopWorkspaceWindowDescriptorSchema,
  type DesktopWorkspaceWindowDescriptor,
} from '../contracts/desktopIpc.js'
import { encodeDesktopEvent } from './eventTransportEncoder.js'
import type { FileHandleRegistry } from './fileHandleRegistry.js'
import { installNativeContextMenu } from './nativeMenus.js'
import { secureWebPreferences } from './secureWebPreferences.js'
import {
  isTrustedApplicationUrl,
  isTrustedDevelopmentRendererUrl,
} from './trustedApplicationLocation.js'
import { buildWorkspaceWindowQuery } from './workspaceWindowLocation.js'

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
const BOOTSTRAP_WINDOW_KEY = '__geo_agent_platform_bootstrap__'

export class WorkspaceWindowRegistry {
  private readonly windows = new Map<string, BrowserWindow>()
  private readonly windowStates = new Map<BrowserWindow, windowStateKeeper.State>()
  private readonly windowTitles = new Map<BrowserWindow, string>()

  constructor(
    private readonly files: FileHandleRegistry,
    private readonly productName = PRODUCT_CODENAME,
  ) {}

  openBootstrap(): BrowserWindow {
    const existing = this.windows.get(BOOTSTRAP_WINDOW_KEY)
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore()
      existing.show()
      existing.focus()
      return existing
    }
    const window = this.createWindow(null)
    this.windows.set(BOOTSTRAP_WINDOW_KEY, window)
    return window
  }

  open(descriptor: DesktopWorkspaceWindowDescriptor): BrowserWindow {
    const workspace = desktopWorkspaceWindowDescriptorSchema.parse(descriptor)
    const existing = this.windows.get(workspace.workspaceId)
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore()
      existing.show()
      existing.focus()
      return existing
    }
    const window = this.createWindow(workspace)
    this.windows.set(workspace.workspaceId, window)
    return window
  }

  getForWebContents(webContentsId: number): BrowserWindow | null {
    for (const window of new Set(this.windows.values())) {
      if (!window.isDestroyed() && window.webContents.id === webContentsId) return window
    }
    return null
  }

  bind(sourceWindow: BrowserWindow, descriptor: DesktopWorkspaceWindowDescriptor): BrowserWindow {
    const workspace = desktopWorkspaceWindowDescriptorSchema.parse(descriptor)
    const existing = this.windows.get(workspace.workspaceId)
    if (existing && existing !== sourceWindow && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore()
      existing.show()
      existing.focus()
      sourceWindow.close()
      return existing
    }
    let alreadyBoundToWorkspace = false
    for (const [workspaceId, window] of this.windows.entries()) {
      if (window !== sourceWindow) continue
      if (workspaceId === workspace.workspaceId) alreadyBoundToWorkspace = true
      else this.windows.delete(workspaceId)
    }
    this.windows.set(workspace.workspaceId, sourceWindow)
    if (!alreadyBoundToWorkspace) {
      this.restoreWorkspaceWindowState(sourceWindow, workspace.workspaceId)
    }
    const title = `${workspace.workspaceName} — ${this.productName}`
    this.windowTitles.set(sourceWindow, title)
    sourceWindow.setTitle(title)
    return sourceWindow
  }

  first(): BrowserWindow | null {
    for (const window of new Set(this.windows.values())) {
      if (!window.isDestroyed()) return window
    }
    return null
  }

  focus(workspaceId: string): boolean {
    const window = this.windows.get(workspaceId)
    if (!window || window.isDestroyed()) return false
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
    return true
  }

  private createWindow(workspace: DesktopWorkspaceWindowDescriptor | null): BrowserWindow {
    const state = createWindowState(workspace?.workspaceId ?? BOOTSTRAP_WINDOW_KEY)
    const windowTitle = `${workspace?.workspaceName ?? `${this.productName} 工作台`} — ${this.productName}`
    const window = new BrowserWindow({
      width: Math.max(1_100, state.width),
      height: Math.max(700, state.height),
      ...(Number.isInteger(state.x) && Number.isInteger(state.y)
        ? { x: state.x, y: state.y }
        : {}),
      minWidth: 1024,
      minHeight: 700,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: '#eef3f5',
      title: windowTitle,
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: '#f4f7f8',
        symbolColor: '#21333c',
        height: 34,
      },
      webPreferences: secureWebPreferences({
        preload: path.resolve(moduleDirectory, '..', 'preload', 'index.cjs'),
        devTools: !app.isPackaged,
        spellcheck: true,
      }),
    })
    const webContentsId = window.webContents.id
    this.windowTitles.set(window, windowTitle)
    state.manage(window)
    this.windowStates.set(window, state)
    window.setMenuBarVisibility(false)
    window.once('ready-to-show', () => window.show())
    window.on('closed', () => {
      // Electron has already destroyed BrowserWindow.webContents when `closed`
      // fires. Release file handles with the identity captured at construction.
      this.files.releaseForWebContents(webContentsId)
      this.windowStates.delete(window)
      this.windowTitles.delete(window)
      for (const [workspaceId, registeredWindow] of this.windows.entries()) {
        if (registeredWindow === window) this.windows.delete(workspaceId)
      }
    })
    window.on('maximize', () => this.sendWindowState(window, 'window:maximized'))
    window.on('unmaximize', () => this.sendWindowState(window, 'window:restored'))
    window.on('page-title-updated', event => {
      event.preventDefault()
      const title = this.windowTitles.get(window)
      if (title) window.setTitle(title)
    })
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (isAllowedExternalUrl(url)) void confirmExternalNavigation(window, url)
      return { action: 'deny' }
    })
    window.webContents.on('will-navigate', (event, url) => {
      if (!isTrustedApplicationUrl(url)) event.preventDefault()
    })
    installNativeContextMenu(window)
    const developmentUrl = process.env.ELECTRON_RENDERER_URL
    const query = buildWorkspaceWindowQuery(workspace)
    if (developmentUrl) {
      if (!isTrustedDevelopmentRendererUrl(developmentUrl)) {
        throw new Error('Electron 开发 Renderer 必须使用本机回环 HTTP(S) 地址。')
      }
      const url = new URL(developmentUrl)
      url.search = query
      void window.loadURL(url.toString())
    } else {
      void window.loadURL(`${PLATFORM_DESKTOP_APP_ORIGIN}/index.html${query}`)
    }
    return window
  }

  private restoreWorkspaceWindowState(window: BrowserWindow, workspaceId: string): void {
    const previous = this.windowStates.get(window)
    previous?.saveState(window)
    previous?.unmanage()

    const state = createWindowState(workspaceId)
    const width = Math.max(1_100, state.width)
    const height = Math.max(700, state.height)
    if (window.isFullScreen()) window.setFullScreen(false)
    if (window.isMaximized()) window.unmaximize()
    if (Number.isInteger(state.x) && Number.isInteger(state.y)) {
      window.setBounds({ x: state.x, y: state.y, width, height })
    } else {
      window.setSize(width, height)
      window.center()
    }
    state.manage(window)
    this.windowStates.set(window, state)
  }

  private sendWindowState(
    window: BrowserWindow,
    event: 'window:maximized' | 'window:restored',
  ): void {
    window.webContents.send(DESKTOP_IPC_CHANNELS.event, encodeDesktopEvent({
      version: 1,
      event,
      payload: null,
    }))
  }
}

function createWindowState(workspaceId: string): windowStateKeeper.State {
  const digest = createHash('sha256').update(workspaceId).digest('hex').slice(0, 24)
  return windowStateKeeper({
    defaultWidth: 1580,
    defaultHeight: 960,
    file: `window-state-${digest}.json`,
  })
}

function isAllowedExternalUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'mailto:')
      && !url.username
      && !url.password
  } catch {
    return false
  }
}

async function confirmExternalNavigation(window: BrowserWindow, value: string): Promise<void> {
  const url = new URL(value)
  const choice = await dialog.showMessageBox(window, {
    type: 'question',
    title: '打开外部链接',
    message: '是否使用系统默认应用打开此外部链接？',
    detail: url.toString(),
    buttons: ['取消', '打开'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  })
  if (choice.response === 1) await shell.openExternal(url.toString())
}
