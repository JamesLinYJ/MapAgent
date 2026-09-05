// +-------------------------------------------------------------------------
//
//   地理智能平台 - Renderer 桌面桥接口
//
//   文件:       desktopBridge.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type {
  DesktopApiOperation,
  DesktopApiResponse,
  DesktopControlRequest,
  DesktopControlResponse,
  DesktopConfirmationRequest,
  DesktopRendererDiagnostic,
  DesktopDownloadRequest,
  DesktopDownloadResult,
  DesktopDiagnosticExportResult,
  DesktopEvent,
  DesktopExportRequest,
  DesktopExportResult,
  DesktopFileHandleReleaseRequest,
  DesktopFileSelectionHandle,
  DesktopFileSelectionRequest,
  DesktopImageBlobStageRequest,
  DesktopTextFileReadRequest,
  DesktopTextFileReadResult,
  DesktopMicrophonePermissionResult,
  DesktopMacosCliStatus,
  DesktopProductSetupConnection,
  DesktopProductSetupRestartResult,
  DesktopProductSetupStatus,
  DesktopProductSetupTestResult,
  DesktopWindowCommand,
  DesktopUploadOperation,
} from './desktopIpc.js'
import type {
  OperationsOperationResult,
  OperationsLogFilter,
  OperationsLogPage,
  OperationsLogQuery,
  OperationsSnapshot,
} from '@geo-agent-platform/shared-types/operations'

export interface DesktopBridge {
  readonly platform: 'win32' | 'darwin' | 'linux'
  readonly api: {
    request(operation: DesktopApiOperation): Promise<DesktopApiResponse>
    upload(operation: DesktopUploadOperation): Promise<DesktopApiResponse>
    download(request: DesktopDownloadRequest): Promise<DesktopDownloadResult>
    open(request: DesktopDownloadRequest): Promise<DesktopDownloadResult>
  }
  readonly auth: {
    request(request: DesktopControlRequest): Promise<DesktopControlResponse>
  }
  readonly clipboard: {
    writeText(text: string): Promise<void>
  }
  readonly dialog: {
    confirm(request: DesktopConfirmationRequest): Promise<boolean>
  }
  readonly diagnostics: {
    report(diagnostic: DesktopRendererDiagnostic): Promise<void>
  }
  readonly control: {
    request(request: DesktopControlRequest): Promise<DesktopControlResponse>
  }
  readonly files: {
    select(request: DesktopFileSelectionRequest): Promise<DesktopFileSelectionHandle[]>
    stageImage(request: DesktopImageBlobStageRequest): Promise<DesktopFileSelectionHandle>
    release(request: DesktopFileHandleReleaseRequest): Promise<void>
    readText(request: DesktopTextFileReadRequest): Promise<DesktopTextFileReadResult>
  }
  readonly permissions: {
    requestSpeechMicrophone(): Promise<DesktopMicrophonePermissionResult>
  }
  readonly installedCli: {
    status(): Promise<DesktopMacosCliStatus>
    install(): Promise<DesktopMacosCliStatus>
    repair(): Promise<DesktopMacosCliStatus>
    remove(): Promise<DesktopMacosCliStatus>
  }
  readonly setup: {
    status(): Promise<DesktopProductSetupStatus>
    test(connection: DesktopProductSetupConnection): Promise<DesktopProductSetupTestResult>
    save(connection: DesktopProductSetupConnection): Promise<DesktopProductSetupStatus>
    reset(): Promise<DesktopProductSetupStatus>
    restart(): Promise<DesktopProductSetupRestartResult>
  }
  readonly export: {
    create(request: DesktopExportRequest): Promise<DesktopExportResult>
  }
  readonly supervisor: {
    status(): Promise<OperationsSnapshot>
    startAll(operationId: string): Promise<OperationsOperationResult>
    logs(query: OperationsLogQuery): Promise<OperationsLogPage>
    history(query: OperationsLogQuery): Promise<OperationsLogPage>
    subscribeLogs(active: boolean, filter: OperationsLogFilter): Promise<void>
    startDiagnostics(): Promise<OperationsSnapshot['observability']['diagnostics']>
    stopDiagnostics(): Promise<OperationsSnapshot['observability']['diagnostics']>
    exportDiagnostics(): Promise<DesktopDiagnosticExportResult>
  }
  readonly window: {
    command(command: DesktopWindowCommand): Promise<void>
  }
  readonly events: {
    subscribe(listener: (event: DesktopEvent) => void): () => void
  }
}
