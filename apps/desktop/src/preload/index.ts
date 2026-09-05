// +-------------------------------------------------------------------------
//
//   地理智能平台 - Electron 安全预加载桥
//
//   文件:       index.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
//
//   维护记录 (2026-07-29):
//     作者: JamesLinYJ
//     协助: OpenAI Codex:GPT-5.6 Sol
//     说明: 删除 Renderer 文件路径反查，只暴露选择、受限文本读取和上传句柄。
//
//   维护记录 (2026-07-30):
//     作者: JamesLinYJ
//     协助: OpenAI Codex:GPT-5.6 Sol
//     说明: 统一解码认证与监督控制响应，并单独校验批量日志数据。
// --------------------------------------------------------------------------

import { contextBridge, ipcRenderer } from 'electron'
import {
  operationsOperationResultSchema,
  operationsSnapshotSchema,
} from '@geo-agent-platform/shared-types/operations'

import type { DesktopBridge } from '../contracts/desktopBridge.js'
import {
  DESKTOP_IPC_CHANNELS,
  desktopApiOperationSchema,
  desktopApiResponseSchema,
  desktopUploadOperationSchema,
  desktopAuthBootstrapResultSchema,
  desktopAuthCommandSchema,
  desktopAuthProjectionSchema,
  desktopClipboardWriteSchema,
  desktopConfirmationRequestSchema,
  desktopControlRequestSchema,
  desktopRendererDiagnosticSchema,
  desktopDownloadRequestSchema,
  desktopDownloadResultSchema,
  desktopDiagnosticExportRequestSchema,
  desktopDiagnosticExportResultSchema,
  desktopExportRequestSchema,
  desktopExportResultSchema,
  desktopFileHandleReleaseRequestSchema,
  desktopFileSelectionHandlesSchema,
  desktopFileSelectionRequestSchema,
  desktopFileSelectionHandleSchema,
  desktopImageBlobStageRequestSchema,
  desktopTextFileReadRequestSchema,
  desktopTextFileReadResultSchema,
  desktopMicrophonePermissionRequestSchema,
  desktopMicrophonePermissionResultSchema,
  desktopMacosCliActionSchema,
  desktopMacosCliStatusSchema,
  desktopProductSetupConnectionSchema,
  desktopProductSetupRestartResultSchema,
  desktopProductSetupStatusSchema,
  desktopProductSetupTestResultSchema,
  desktopSupervisorLogsQuerySchema,
  desktopSupervisorLogsResponseSchema,
  desktopSupervisorLogSubscriptionSchema,
  desktopWindowCommandSchema,
  type DesktopAuthCommand,
  type DesktopControlResponse,
} from '../contracts/desktopIpc.js'
import { decodeDesktopControlResponse } from './controlResponseDecoder.js'
import { createOrderedDesktopEventDispatcher } from './eventTransportDecoder.js'

const desktopPlatform = readDesktopPlatform(process.platform)

const bridge: DesktopBridge = {
  platform: desktopPlatform,
  api: {
    async request(input) {
      return desktopApiResponseSchema.parse(
        await ipcRenderer.invoke(
          DESKTOP_IPC_CHANNELS.apiRequest,
          desktopApiOperationSchema.parse(input),
        ),
      )
    },
    async upload(input) {
      return desktopApiResponseSchema.parse(
        await ipcRenderer.invoke(
          DESKTOP_IPC_CHANNELS.apiUpload,
          desktopUploadOperationSchema.parse(input),
        ),
      )
    },
    async download(input) {
      return desktopDownloadResultSchema.parse(
        await ipcRenderer.invoke(
          DESKTOP_IPC_CHANNELS.apiDownload,
          desktopDownloadRequestSchema.parse(input),
        ),
      )
    },
    async open(input) {
      return desktopDownloadResultSchema.parse(
        await ipcRenderer.invoke(
          DESKTOP_IPC_CHANNELS.apiOpen,
          desktopDownloadRequestSchema.parse(input),
        ),
      )
    },
  },
  auth: {
    async request(input) {
      const request = desktopControlRequestSchema.parse(input)
      const command = desktopAuthCommandSchema.parse({
        command: request.command,
        payload: request.payload,
      })
      const response = await decodeDesktopControlResponse(
        await ipcRenderer.invoke(
          DESKTOP_IPC_CHANNELS.authRequest,
          request,
        ),
      )
      return validateDesktopAuthResponse(command, response)
    },
  },
  clipboard: {
    async writeText(text) {
      await ipcRenderer.invoke(
        DESKTOP_IPC_CHANNELS.clipboardWrite,
        desktopClipboardWriteSchema.parse({ text }),
      )
    },
  },
  dialog: {
    async confirm(input) {
      const result: unknown = await ipcRenderer.invoke(
        DESKTOP_IPC_CHANNELS.dialogConfirm,
        desktopConfirmationRequestSchema.parse(input),
      )
      if (typeof result !== 'boolean') {
        throw new Error('桌面确认框返回了无效结果。')
      }
      return result
    },
  },
  diagnostics: {
    async report(input) {
      await ipcRenderer.invoke(
        DESKTOP_IPC_CHANNELS.diagnosticReport,
        desktopRendererDiagnosticSchema.parse(input),
      )
    },
  },
  control: {
    async request(input) {
      return await decodeDesktopControlResponse(
        await ipcRenderer.invoke(
          DESKTOP_IPC_CHANNELS.controlRequest,
          desktopControlRequestSchema.parse(input),
        ),
      )
    },
  },
  files: {
    async select(input) {
      return desktopFileSelectionHandlesSchema.parse(
        await ipcRenderer.invoke(
          DESKTOP_IPC_CHANNELS.fileSelect,
          desktopFileSelectionRequestSchema.parse(input),
        ),
      )
    },
    async stageImage(input) {
      return desktopFileSelectionHandleSchema.parse(
        await ipcRenderer.invoke(
          DESKTOP_IPC_CHANNELS.fileStageImage,
          desktopImageBlobStageRequestSchema.parse(input),
        ),
      )
    },
    async release(input) {
      await ipcRenderer.invoke(
        DESKTOP_IPC_CHANNELS.fileRelease,
        desktopFileHandleReleaseRequestSchema.parse(input),
      )
    },
    async readText(input) {
      return desktopTextFileReadResultSchema.parse(
        await ipcRenderer.invoke(
          DESKTOP_IPC_CHANNELS.fileReadText,
          desktopTextFileReadRequestSchema.parse(input),
        ),
      )
    },
  },
  permissions: {
    async requestSpeechMicrophone() {
      return desktopMicrophonePermissionResultSchema.parse(
        await ipcRenderer.invoke(
          DESKTOP_IPC_CHANNELS.microphonePermission,
          desktopMicrophonePermissionRequestSchema.parse({
            purpose: 'speech-recognition',
          }),
        ),
      )
    },
  },
  installedCli: {
    async status() {
      return desktopMacosCliStatusSchema.parse(
        await ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.macosCliStatus),
      )
    },
    async install() {
      return invokeMacosCliAction('install')
    },
    async repair() {
      return invokeMacosCliAction('repair')
    },
    async remove() {
      return invokeMacosCliAction('remove')
    },
  },
  setup: {
    async status() {
      return desktopProductSetupStatusSchema.parse(
        await ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.setupStatus),
      )
    },
    async test(input) {
      return desktopProductSetupTestResultSchema.parse(
        await ipcRenderer.invoke(
          DESKTOP_IPC_CHANNELS.setupTest,
          desktopProductSetupConnectionSchema.parse(input),
        ),
      )
    },
    async save(input) {
      return desktopProductSetupStatusSchema.parse(
        await ipcRenderer.invoke(
          DESKTOP_IPC_CHANNELS.setupSave,
          desktopProductSetupConnectionSchema.parse(input),
        ),
      )
    },
    async reset() {
      return desktopProductSetupStatusSchema.parse(
        await ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.setupReset),
      )
    },
    async restart() {
      return desktopProductSetupRestartResultSchema.parse(
        await ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.setupRestart),
      )
    },
  },
  export: {
    async create(input) {
      return desktopExportResultSchema.parse(
        await ipcRenderer.invoke(
          DESKTOP_IPC_CHANNELS.exportRequest,
          desktopExportRequestSchema.parse(input),
        ),
      )
    },
  },
  supervisor: {
    async status() {
      return operationsSnapshotSchema.parse(
        await invokeSupervisor('status', {}),
      )
    },
    async startAll(operationId) {
      return operationsOperationResultSchema.parse(
        await invokeSupervisor('start', { target: 'all', operationId }),
      )
    },
    async logs(query) {
      return desktopSupervisorLogsResponseSchema.parse(
        await ipcRenderer.invoke(
          DESKTOP_IPC_CHANNELS.supervisorLogs,
          desktopSupervisorLogsQuerySchema.parse(query),
        ),
      )
    },
    async history(query) {
      return desktopSupervisorLogsResponseSchema.parse(
        await ipcRenderer.invoke(
          DESKTOP_IPC_CHANNELS.supervisorLogHistory,
          desktopSupervisorLogsQuerySchema.parse(query),
        ),
      )
    },
    async subscribeLogs(active, filter) {
      await ipcRenderer.invoke(
        DESKTOP_IPC_CHANNELS.supervisorLogSubscription,
        desktopSupervisorLogSubscriptionSchema.parse({ active, filter }),
      )
    },
    async startDiagnostics() {
      const snapshot = await invokeSupervisor('diagnostics_start', {})
      return operationsSnapshotSchema.shape.observability.shape.diagnostics.parse(snapshot)
    },
    async stopDiagnostics() {
      const snapshot = await invokeSupervisor('diagnostics_stop', {})
      return operationsSnapshotSchema.shape.observability.shape.diagnostics.parse(snapshot)
    },
    async exportDiagnostics() {
      return desktopDiagnosticExportResultSchema.parse(
        await ipcRenderer.invoke(
          DESKTOP_IPC_CHANNELS.supervisorDiagnosticExport,
          desktopDiagnosticExportRequestSchema.parse({}),
        ),
      )
    },
  },
  window: {
    async command(input) {
      await ipcRenderer.invoke(
        DESKTOP_IPC_CHANNELS.windowCommand,
        desktopWindowCommandSchema.parse(input),
      )
    },
  },
  events: {
    subscribe(listener) {
      const dispatch = createOrderedDesktopEventDispatcher(listener, (error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error))
      })
      const handler = (_event: Electron.IpcRendererEvent, input: unknown) => {
        void dispatch(input)
      }
      ipcRenderer.on(DESKTOP_IPC_CHANNELS.event, handler)
      return () => ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.event, handler)
    },
  },
}

contextBridge.exposeInMainWorld('platformDesktop', bridge)

async function invokeMacosCliAction(
  action: 'install' | 'repair' | 'remove',
) {
  return desktopMacosCliStatusSchema.parse(
    await ipcRenderer.invoke(
      DESKTOP_IPC_CHANNELS.macosCliAction,
      desktopMacosCliActionSchema.parse(action),
    ),
  )
}

async function invokeSupervisor(
  command: 'status' | 'start' | 'diagnostics_start' | 'diagnostics_stop',
  payload: Record<string, unknown>,
): Promise<unknown> {
  const request = desktopControlRequestSchema.parse({
    version: 1,
    requestId: crypto.randomUUID(),
    command,
    payload,
  })
  const response = await decodeDesktopControlResponse(
    await ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.supervisorRequest, request),
  )
  if (!response.ok) {
    throw new Error(response.error?.message ?? '本机监督器请求失败。')
  }
  return response.data
}

function readDesktopPlatform(platform: NodeJS.Platform): DesktopBridge['platform'] {
  if (platform === 'win32' || platform === 'darwin' || platform === 'linux') return platform
  throw new Error(`平台桌面端不支持当前操作系统：${platform}`)
}

function validateDesktopAuthResponse(
  command: DesktopAuthCommand,
  response: DesktopControlResponse,
): DesktopControlResponse {
  if (!response.ok) return response
  if (command.command === 'bootstrap') {
    return {
      ...response,
      data: desktopAuthBootstrapResultSchema.parse(response.data),
    }
  }
  if (command.command === 'projection') {
    return {
      ...response,
      data: desktopAuthProjectionSchema.parse(response.data),
    }
  }
  if (response.data !== null) {
    throw new Error('桌面认证写操作返回了不允许投影到 Renderer 的数据。')
  }
  return response
}
