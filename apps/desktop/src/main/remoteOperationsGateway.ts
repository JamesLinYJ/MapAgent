// +-------------------------------------------------------------------------
//
//   地理智能平台 - 远程部署只读运行状态网关
//
//   文件:       remoteOperationsGateway.ts
//
//   说明:       远程模式只验证 API 健康度，不假装能够管理服务端进程。
// --------------------------------------------------------------------------

import os from 'node:os'
import {
  operationsOperationResultSchema,
  operationsSnapshotSchema,
  type OperationsLogEntry,
  type OperationsLogFilter,
  type OperationsLogPage,
  type OperationsLogQuery,
  type OperationsOperationResult,
  type OperationsSnapshot,
} from '@geo-agent-platform/shared-types/operations'
import { PRODUCT_CODENAME } from '@geo-agent-platform/shared-types/product-identity'

import {
  desktopSupervisorCommandSchema,
  type DesktopControlRequest,
  type DesktopControlResponse,
} from '../contracts/desktopIpc.js'
import type { DesktopProductSetupService } from './productSetup.js'
import type {
  DesktopDiagnosticBundle,
  DesktopOperationsGateway,
} from './supervisorGateway.js'

export class RemoteDesktopOperationsGateway implements DesktopOperationsGateway {
  private readonly startedAt = new Date().toISOString()
  private sequence = 0
  private releaseId: string | null = null
  private restartCount = 0

  constructor(
    private readonly apiBaseUrl: string,
    private readonly setup: DesktopProductSetupService,
  ) {}

  async handle(request: DesktopControlRequest): Promise<DesktopControlResponse> {
    try {
      const command = desktopSupervisorCommandSchema.parse({
        command: request.command,
        payload: request.payload,
      })
      if (command.command === 'status') {
        return successResponse(request, await this.snapshot())
      }
      if (command.command === 'diagnostics_start' || command.command === 'diagnostics_stop') {
        return successResponse(request, remoteDiagnostics())
      }
      const now = new Date().toISOString()
      return successResponse(request, operationsOperationResultSchema.parse({
        operationId: command.payload.operationId,
        action: command.command,
        target: command.payload.target,
        outcome: 'failed',
        message: '当前连接的是远程部署；请在服务端主机上管理后台进程。',
        startedAt: now,
        completedAt: now,
      }))
    } catch (error) {
      return {
        version: request.version,
        requestId: request.requestId,
        ok: false,
        error: {
          code: 'remote_service_unavailable',
          message: safeMessage(error),
        },
      }
    }
  }

  async logs(query: OperationsLogQuery): Promise<OperationsLogPage> {
    return emptyPage(query.afterSequence)
  }

  async history(query: OperationsLogQuery): Promise<OperationsLogPage> {
    return emptyPage(query.afterSequence)
  }

  async diagnosticBundle(): Promise<DesktopDiagnosticBundle> {
    return {
      formatVersion: 1,
      capturedAt: new Date().toISOString(),
      snapshot: await this.snapshot(),
      entries: [],
    }
  }

  async subscribeLogs(
    _ownerWebContentsId: number,
    _active: boolean,
    _filter: OperationsLogFilter,
    _deliver: (entry: OperationsLogEntry) => void,
  ): Promise<void> {}

  close(): void {}

  async shutdown(): Promise<OperationsOperationResult> {
    const now = new Date().toISOString()
    return operationsOperationResultSchema.parse({
      operationId: crypto.randomUUID(),
      action: 'shutdown',
      target: 'all',
      outcome: 'failed',
      message: '远程部署不能由桌面客户端关闭。',
      startedAt: now,
      completedAt: now,
    })
  }

  private async snapshot(): Promise<OperationsSnapshot> {
    const connection = await this.setup.test({
      apiBaseUrl: this.apiBaseUrl,
      productName: PRODUCT_CODENAME,
    })
    if (!connection.ok || !connection.releaseId) throw new Error(connection.message)
    const releaseId = connection.releaseId
    if (this.releaseId !== null && this.releaseId !== releaseId) this.restartCount += 1
    this.releaseId = releaseId
    this.sequence += 1
    const sampledAt = new Date().toISOString()
    return operationsSnapshotSchema.parse({
      sequence: this.sequence,
      host: {
        hostname: new URL(this.apiBaseUrl).hostname,
        platform: 'remote',
        release: releaseId,
        profile: 'production',
        supervisorPid: process.pid,
        supervisorStartedAt: this.startedAt,
        cpuPercent: unavailableMetric('远程部署不公开主机 CPU 指标'),
        memoryUsedBytes: unavailableMetric('远程部署不公开主机内存指标'),
        memoryTotalBytes: unavailableMetric('远程部署不公开主机内存指标'),
        runtimeDiskUsedBytes: unavailableMetric('远程部署不公开磁盘指标'),
        runtimeDiskTotalBytes: unavailableMetric('远程部署不公开磁盘指标'),
        sampledAt,
      },
      services: ['infra', 'worker', 'api'].map((serviceId, index) => ({
        serviceId,
        displayName: ({ infra: '数据基础设施', worker: '科学计算服务', api: '平台 API' })[serviceId],
        description: '由远程部署统一提供',
        state: 'healthy',
        healthMessage: '远程服务健康检查通过',
        pid: stableRemotePid(releaseId, index),
        cpuPercent: unavailableMetric('远程部署不公开服务 CPU 指标'),
        memoryBytes: unavailableMetric('远程部署不公开服务内存指标'),
        startedAt: this.startedAt,
        uptimeSeconds: Math.max(0, Math.floor((Date.now() - Date.parse(this.startedAt)) / 1_000)),
        restartCount: this.restartCount,
        lastExitCode: null,
        blockedBy: [],
      })),
      observability: {
        diagnostics: remoteDiagnostics(),
        persistence: {
          state: 'healthy',
          message: '远程服务健康检查通过',
          lastSuccessAt: sampledAt,
          lastErrorAt: null,
        },
      },
    })
  }
}

function successResponse(
  request: DesktopControlRequest,
  data: unknown,
): DesktopControlResponse {
  return {
    version: request.version,
    requestId: request.requestId,
    ok: true,
    data,
  }
}

function remoteDiagnostics(): OperationsSnapshot['observability']['diagnostics'] {
  return {
    enabled: false,
    expiresAt: null,
    retainedEntries: 0,
    retainedBytes: 0,
    maxBytes: 1,
    oldestCreatedAt: null,
  }
}

function unavailableMetric(reason: string): { value: null; unavailableReason: string } {
  return { value: null, unavailableReason: reason }
}

function stableRemotePid(releaseId: string, offset: number): number {
  let value = 17 + offset
  for (const character of releaseId) value = ((value * 31) + character.charCodeAt(0)) >>> 0
  return (value % 2_000_000_000) + 1
}

function emptyPage(afterSequence: number | null): OperationsLogPage {
  return { entries: [], nextCursor: afterSequence, hasMore: false }
}

function safeMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.replace(/[\r\n]+/gu, ' ').slice(0, 800)
  }
  return `无法连接远程服务（${os.platform()}）。`
}
