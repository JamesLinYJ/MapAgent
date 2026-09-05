// +-------------------------------------------------------------------------
//
//   地理智能平台 - 首次设置 IPC 边界
//
//   文件:       productSetupIpc.ts
// --------------------------------------------------------------------------

import { ipcMain, type IpcMainInvokeEvent } from 'electron'

import {
  DESKTOP_IPC_CHANNELS,
  desktopProductSetupConnectionSchema,
  desktopProductSetupRestartResultSchema,
  desktopProductSetupStatusSchema,
  desktopProductSetupTestResultSchema,
} from '../contracts/desktopIpc.js'
import type { DesktopProductSetupService } from './productSetup.js'
import { isTrustedApplicationUrl } from './trustedApplicationLocation.js'
import type { WorkspaceWindowRegistry } from './windowRegistry.js'

export interface DesktopProductSetupIpcDependencies {
  setup: DesktopProductSetupService
  windows: WorkspaceWindowRegistry
  scheduleRestart(): void
}

export function installDesktopProductSetupIpcHandlers(
  dependencies: DesktopProductSetupIpcDependencies,
): void {
  ipcMain.handle(DESKTOP_IPC_CHANNELS.setupStatus, async event => {
    requireSetupWindow(event, dependencies.windows)
    return desktopProductSetupStatusSchema.parse(await dependencies.setup.status())
  })
  ipcMain.handle(DESKTOP_IPC_CHANNELS.setupTest, async (event, input: unknown) => {
    requireSetupWindow(event, dependencies.windows)
    return desktopProductSetupTestResultSchema.parse(
      await dependencies.setup.test(desktopProductSetupConnectionSchema.parse(input)),
    )
  })
  ipcMain.handle(DESKTOP_IPC_CHANNELS.setupSave, async (event, input: unknown) => {
    requireSetupWindow(event, dependencies.windows)
    return desktopProductSetupStatusSchema.parse(
      await dependencies.setup.save(desktopProductSetupConnectionSchema.parse(input)),
    )
  })
  ipcMain.handle(DESKTOP_IPC_CHANNELS.setupReset, async event => {
    requireSetupWindow(event, dependencies.windows)
    return desktopProductSetupStatusSchema.parse(await dependencies.setup.reset())
  })
  ipcMain.handle(DESKTOP_IPC_CHANNELS.setupRestart, event => {
    requireSetupWindow(event, dependencies.windows)
    dependencies.scheduleRestart()
    return desktopProductSetupRestartResultSchema.parse({ scheduled: true })
  })
}

function requireSetupWindow(
  event: IpcMainInvokeEvent,
  windows: WorkspaceWindowRegistry,
): void {
  const window = windows.getForWebContents(event.sender.id)
  if (!window || window.isDestroyed() || event.senderFrame !== window.webContents.mainFrame) {
    throw new Error('拒绝来自未知窗口或子框架的首次设置请求。')
  }
  if (!isTrustedApplicationUrl(event.senderFrame.url)) {
    throw new Error('拒绝来自非平台应用源的首次设置请求。')
  }
}
