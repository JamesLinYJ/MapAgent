// +-------------------------------------------------------------------------
//
//   地理智能平台 - Electron IPC 处理器
//
//   文件:       ipcHandlers.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
//
//   维护记录 (2026-07-30):
//     作者: JamesLinYJ
//     协助: OpenAI Codex:GPT-5.6 Sol
//     说明: 控制响应统一编码；系统日志改走独立的批量数据 IPC。
// --------------------------------------------------------------------------

import { clipboard, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { PRODUCT_CODENAME } from '@geo-agent-platform/shared-types/product-identity'

import {
  DESKTOP_IPC_CHANNELS,
  desktopApiOperationSchema,
  desktopUploadOperationSchema,
  desktopClipboardWriteSchema,
  desktopConfirmationRequestSchema,
  desktopControlRequestSchema,
  desktopDownloadRequestSchema,
  desktopDiagnosticExportRequestSchema,
  desktopDiagnosticExportResultSchema,
  desktopExportRequestSchema,
  desktopFileHandleReleaseRequestSchema,
  desktopFileSelectionRequestSchema,
  desktopImageBlobStageRequestSchema,
  desktopTextFileReadRequestSchema,
  desktopMicrophonePermissionRequestSchema,
  desktopMicrophonePermissionResultSchema,
  desktopMacosCliActionSchema,
  desktopMacosCliStatusSchema,
  desktopSupervisorLogsQuerySchema,
  desktopSupervisorLogsResponseSchema,
  desktopSupervisorLogSubscriptionSchema,
  desktopWindowCommandSchema,
} from '../contracts/desktopIpc.js'
import { encodeDesktopControlResponse } from './controlResponseEncoder.js'
import { encodeDesktopEvent } from './eventTransportEncoder.js'
import { fitDesktopLogPage } from './desktopLogPageTransport.js'
import { popupApplicationMenu } from './nativeMenus.js'
import type { DesktopApiGateway } from './apiGateway.js'
import type { DesktopAuthGateway } from './authGateway.js'
import type { DesktopControlGateway } from './controlGateway.js'
import type { DesktopDownloadService } from './downloadService.js'
import type { DesktopDiagnosticExportService } from './diagnosticExportService.js'
import type { DesktopExportService } from './exportService.js'
import type { FileHandleRegistry } from './fileHandleRegistry.js'
import type { MicrophonePermissionGate } from './microphonePermissionGate.js'
import type { MacosInstalledCliService } from './macosInstalledCliService.js'
import {
  reportRendererDiagnostic,
  type RendererDiagnosticLogger,
} from './rendererDiagnosticReporter.js'
import type { DesktopOperationsGateway } from './supervisorGateway.js'
import { isTrustedApplicationUrl } from './trustedApplicationLocation.js'
import type { WorkspaceWindowRegistry } from './windowRegistry.js'

export interface DesktopIpcDependencies {
  api: DesktopApiGateway
  auth: DesktopAuthGateway
  control: DesktopControlGateway
  downloads: DesktopDownloadService
  diagnosticExports: DesktopDiagnosticExportService
  exports: DesktopExportService
  files: FileHandleRegistry
  logger: RendererDiagnosticLogger
  microphone: MicrophonePermissionGate
  installedCli: MacosInstalledCliService
  supervisor: DesktopOperationsGateway
  windows: WorkspaceWindowRegistry
}

export function installDesktopIpcHandlers(dependencies: DesktopIpcDependencies): void {
  const logSubscriptionCleanupRegistered = new Set<number>()
  ipcMain.handle(DESKTOP_IPC_CHANNELS.apiRequest, async (event, input: unknown) => {
    requireWindow(event, dependencies.windows)
    return dependencies.api.request(desktopApiOperationSchema.parse(input))
  })
  ipcMain.handle(DESKTOP_IPC_CHANNELS.apiUpload, async (event, input: unknown) => {
    requireWindow(event, dependencies.windows)
    return dependencies.api.upload(
      event.sender.id,
      desktopUploadOperationSchema.parse(input),
      dependencies.files,
    )
  })
  ipcMain.handle(DESKTOP_IPC_CHANNELS.apiDownload, async (event, input: unknown) => {
    const window = requireWindow(event, dependencies.windows)
    return dependencies.downloads.save(window, desktopDownloadRequestSchema.parse(input))
  })
  ipcMain.handle(DESKTOP_IPC_CHANNELS.apiOpen, async (event, input: unknown) => {
    requireWindow(event, dependencies.windows)
    return dependencies.downloads.open(desktopDownloadRequestSchema.parse(input))
  })
  ipcMain.handle(DESKTOP_IPC_CHANNELS.authRequest, async (event, input: unknown) => {
    requireWindow(event, dependencies.windows)
    return encodeDesktopControlResponse(
      await dependencies.auth.handle(desktopControlRequestSchema.parse(input)),
    )
  })
  ipcMain.handle(DESKTOP_IPC_CHANNELS.clipboardWrite, (event, input: unknown) => {
    requireWindow(event, dependencies.windows)
    const request = desktopClipboardWriteSchema.parse(input)
    clipboard.writeText(request.text)
  })
  ipcMain.handle(DESKTOP_IPC_CHANNELS.dialogConfirm, async (event, input: unknown) => {
    const window = requireWindow(event, dependencies.windows)
    const request = desktopConfirmationRequestSchema.parse(input)
    const result = await dialog.showMessageBox(window, {
      type: request.tone === 'question' ? 'question' : 'warning',
      title: request.title,
      message: request.message,
      ...(request.detail ? { detail: request.detail } : {}),
      buttons: [request.cancelLabel, request.confirmLabel],
      defaultId: request.tone === 'danger' ? 0 : 1,
      cancelId: 0,
      noLink: true,
    })
    return result.response === 1
  })
  ipcMain.handle(DESKTOP_IPC_CHANNELS.diagnosticReport, (event, input: unknown) => {
    requireWindow(event, dependencies.windows)
    reportRendererDiagnostic(dependencies.logger, input)
  })
  ipcMain.handle(DESKTOP_IPC_CHANNELS.controlRequest, async (event, input: unknown) => {
    const window = requireWindow(event, dependencies.windows)
    return encodeDesktopControlResponse(
      await dependencies.control.handle(window, desktopControlRequestSchema.parse(input)),
    )
  })
  ipcMain.handle(DESKTOP_IPC_CHANNELS.supervisorRequest, async (event, input: unknown) => {
    requireWindow(event, dependencies.windows)
    return encodeDesktopControlResponse(
      await dependencies.supervisor.handle(desktopControlRequestSchema.parse(input)),
    )
  })
  ipcMain.handle(DESKTOP_IPC_CHANNELS.supervisorLogs, async (event, input: unknown) => {
    requireWindow(event, dependencies.windows)
    const query = desktopSupervisorLogsQuerySchema.parse(input)
    return desktopSupervisorLogsResponseSchema.parse(fitDesktopLogPage(
      await dependencies.supervisor.logs(query),
      query.afterSequence,
    ))
  })
  ipcMain.handle(DESKTOP_IPC_CHANNELS.supervisorLogHistory, async (event, input: unknown) => {
    requireWindow(event, dependencies.windows)
    const query = desktopSupervisorLogsQuerySchema.parse(input)
    return desktopSupervisorLogsResponseSchema.parse(fitDesktopLogPage(
      await dependencies.supervisor.history(query),
      query.afterSequence,
    ))
  })
  ipcMain.handle(DESKTOP_IPC_CHANNELS.supervisorLogSubscription, async (event, input: unknown) => {
    const window = requireWindow(event, dependencies.windows)
    const request = desktopSupervisorLogSubscriptionSchema.parse(input)
    await dependencies.supervisor.subscribeLogs(
      event.sender.id,
      request.active,
      request.filter,
      entry => {
        if (window.isDestroyed() || window.webContents.isDestroyed()) return
        window.webContents.send(DESKTOP_IPC_CHANNELS.event, encodeDesktopEvent({
          version: 1,
          event: 'supervisor:log',
          payload: entry,
        }))
      },
    )
    if (request.active && !logSubscriptionCleanupRegistered.has(event.sender.id)) {
      logSubscriptionCleanupRegistered.add(event.sender.id)
      event.sender.once('destroyed', () => {
        logSubscriptionCleanupRegistered.delete(event.sender.id)
        void dependencies.supervisor.subscribeLogs(event.sender.id, false, request.filter, () => {})
      })
    }
  })
  ipcMain.handle(DESKTOP_IPC_CHANNELS.supervisorDiagnosticExport, async (event, input: unknown) => {
    const window = requireWindow(event, dependencies.windows)
    desktopDiagnosticExportRequestSchema.parse(input)
    return desktopDiagnosticExportResultSchema.parse(
      await dependencies.diagnosticExports.create(
        window,
        await dependencies.supervisor.diagnosticBundle(),
      ),
    )
  })
  ipcMain.handle(DESKTOP_IPC_CHANNELS.fileSelect, async (event, input: unknown) => {
    const window = requireWindow(event, dependencies.windows)
    return dependencies.files.select(window, desktopFileSelectionRequestSchema.parse(input))
  })
  ipcMain.handle(DESKTOP_IPC_CHANNELS.fileStageImage, async (event, input: unknown) => {
    requireWindow(event, dependencies.windows)
    return dependencies.files.stageImage(
      event.sender.id,
      desktopImageBlobStageRequestSchema.parse(input),
    )
  })
  ipcMain.handle(DESKTOP_IPC_CHANNELS.fileRelease, async (event, input: unknown) => {
    requireWindow(event, dependencies.windows)
    const request = desktopFileHandleReleaseRequestSchema.parse(input)
    await dependencies.files.release(event.sender.id, request.handleId)
  })
  ipcMain.handle(DESKTOP_IPC_CHANNELS.fileReadText, async (event, input: unknown) => {
    requireWindow(event, dependencies.windows)
    return dependencies.files.readText(
      event.sender.id,
      desktopTextFileReadRequestSchema.parse(input),
    )
  })
  ipcMain.handle(DESKTOP_IPC_CHANNELS.microphonePermission, async (event, input: unknown) => {
    const window = requireWindow(event, dependencies.windows)
    desktopMicrophonePermissionRequestSchema.parse(input)
    const ownerWebContentsId = event.sender.id
    const initialIdentity = dependencies.auth.requireAuthorizationContext()
    dependencies.microphone.revoke(ownerWebContentsId)
    const result = await dialog.showMessageBox(window, {
      type: 'question',
      title: '允许本次使用麦克风',
      message: `${PRODUCT_CODENAME} 是否可以为本次语音识别使用麦克风？`,
      detail: '授权仅供当前窗口下一次音频请求使用，并将在 60 秒后失效。'
        + '语音可能由已配置的第三方语音服务处理。',
      buttons: ['取消', '允许本次使用'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    })
    if (result.response !== 1) {
      return desktopMicrophonePermissionResultSchema.parse({
        granted: false,
        message: '你已取消本次麦克风授权，语音识别未启动。',
      })
    }
    const confirmedIdentity = dependencies.auth.requireAuthorizationContext()
    if (
      confirmedIdentity.userId !== initialIdentity.userId
      || confirmedIdentity.revision !== initialIdentity.revision
      || window.isDestroyed()
      || event.sender.isDestroyed()
    ) {
      throw new Error('确认期间桌面身份或窗口已经变化，麦克风未获授权。')
    }
    const observeDestruction = dependencies.microphone.grant(ownerWebContentsId)
    if (observeDestruction) {
      event.sender.on('did-start-navigation', (_navigationEvent, _url, _isInPlace, isMainFrame) => {
        if (isMainFrame) dependencies.microphone.revoke(ownerWebContentsId)
      })
      event.sender.once('destroyed', () => {
        dependencies.microphone.releaseOwner(ownerWebContentsId)
      })
    }
    return desktopMicrophonePermissionResultSchema.parse({
      granted: true,
      message: null,
    })
  })
  ipcMain.handle(DESKTOP_IPC_CHANNELS.macosCliStatus, async (event) => {
    requireWindow(event, dependencies.windows)
    return desktopMacosCliStatusSchema.parse(await dependencies.installedCli.status())
  })
  ipcMain.handle(DESKTOP_IPC_CHANNELS.macosCliAction, async (event, input: unknown) => {
    requireWindow(event, dependencies.windows)
    return desktopMacosCliStatusSchema.parse(
      await dependencies.installedCli.perform(desktopMacosCliActionSchema.parse(input)),
    )
  })
  ipcMain.handle(DESKTOP_IPC_CHANNELS.exportRequest, async (event, input: unknown) => {
    const window = requireWindow(event, dependencies.windows)
    return dependencies.exports.create(window, desktopExportRequestSchema.parse(input))
  })
  ipcMain.handle(DESKTOP_IPC_CHANNELS.windowCommand, (event, input: unknown) => {
    const sourceWindow = requireWindow(event, dependencies.windows)
    const command = desktopWindowCommandSchema.parse(input)
    if (command.action === 'minimize') sourceWindow.minimize()
    else if (command.action === 'toggle-maximize') {
      if (sourceWindow.isMaximized()) sourceWindow.unmaximize()
      else sourceWindow.maximize()
    } else if (command.action === 'close') sourceWindow.close()
    else if (command.action === 'show-application-menu') popupApplicationMenu(sourceWindow)
    else if (command.action === 'set-taskbar-progress') {
      applyTaskbarProgress(sourceWindow, command.progress)
    }
    else if (command.action === 'open-workspace') dependencies.windows.open(command.workspace)
    else if (command.action === 'bind-workspace') dependencies.windows.bind(sourceWindow, command.workspace)
    else dependencies.windows.focus(command.workspaceId)
  })
}

function applyTaskbarProgress(
  window: ReturnType<typeof requireWindow>,
  progress: {
    state: 'none' | 'indeterminate' | 'normal' | 'paused' | 'error'
    value: number | null
  },
): void {
  if (progress.state === 'none') {
    window.setProgressBar(-1)
    return
  }
  if (progress.state === 'indeterminate') {
    window.setProgressBar(2, { mode: 'indeterminate' })
    return
  }
  window.setProgressBar(progress.value ?? 1, {
    mode: progress.state,
  })
}

function requireWindow(
  event: IpcMainInvokeEvent,
  windows: WorkspaceWindowRegistry,
) {
  const window = windows.getForWebContents(event.sender.id)
  if (!window || window.isDestroyed() || event.senderFrame !== window.webContents.mainFrame) {
    throw new Error('拒绝来自未知窗口或子框架的桌面 IPC 请求。')
  }
  const url = event.senderFrame.url
  if (!isTrustedApplicationUrl(url)) {
    throw new Error('拒绝来自非平台应用源的桌面 IPC 请求。')
  }
  return window
}
