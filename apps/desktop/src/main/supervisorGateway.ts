// +-------------------------------------------------------------------------
//
//   地理智能平台 - Electron Supervisor 网关
//
//   文件:       supervisorGateway.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
//
//   维护记录 (2026-07-30):
//     作者: JamesLinYJ
//     协助: OpenAI Codex:GPT-5.6 Sol
//     说明: 日志查询从监督命令分支拆为独立的只读数据入口。
// --------------------------------------------------------------------------

import { readFile } from 'node:fs/promises'
import { OperationsClient } from '@geo-agent-platform/operations-supervisor/client'
import { matchesOperationsLogFilter } from '@geo-agent-platform/operations-supervisor/log-buffer'
import { resolveOperationsPaths } from '@geo-agent-platform/operations-supervisor/paths'

import {
  desktopSupervisorCommandSchema,
  type DesktopControlRequest,
  type DesktopControlResponse,
} from '../contracts/desktopIpc.js'
import {
  operationsLogEntrySchema,
  type OperationsLogEntry,
  type OperationsLogFilter,
  type OperationsLogPage,
  type OperationsLogQuery,
  type OperationsOperationResult,
  type OperationsSnapshot,
} from '@geo-agent-platform/shared-types/operations'
import type { DesktopRuntimeConfig } from './runtimeConfig.js'

interface DesktopLogSource {
  read(query: OperationsLogQuery): Promise<OperationsLogPage>
  readHistory(query: OperationsLogQuery): Promise<OperationsLogPage>
  onLog(listener: (entry: OperationsLogEntry) => void): () => void
  persistenceState(): OperationsSnapshot['observability']['persistence']
}

interface LogSubscription {
  filter: OperationsLogFilter
  deliver: (entry: OperationsLogEntry) => void
}

export interface DesktopDiagnosticBundle {
  formatVersion: 1
  capturedAt: string
  snapshot: OperationsSnapshot
  entries: OperationsLogEntry[]
}

export interface DesktopOperationsGateway {
  handle(request: DesktopControlRequest): Promise<DesktopControlResponse>
  logs(query: OperationsLogQuery): Promise<OperationsLogPage>
  history(query: OperationsLogQuery): Promise<OperationsLogPage>
  diagnosticBundle(): Promise<DesktopDiagnosticBundle>
  subscribeLogs(
    ownerWebContentsId: number,
    active: boolean,
    filter: OperationsLogFilter,
    deliver: (entry: OperationsLogEntry) => void,
  ): Promise<void>
  close(): void
  shutdown(): Promise<OperationsOperationResult>
}

const BROAD_LOG_FILTER: OperationsLogFilter = {
  services: ['infra', 'worker', 'api'],
  levels: [],
  streams: [],
  categories: [],
  events: [],
  retentions: [],
  correlationId: '',
  search: '',
  includeSupervisor: true,
  afterSequence: null,
}

export class DesktopSupervisorGateway implements DesktopOperationsGateway {
  private client: OperationsClient | null = null
  private clientEventDisposer: (() => void) | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private subscriptionSync: Promise<void> | null = null
  private queuedSupervisorLogs: OperationsLogEntry[] | null = null
  private readonly logSubscriptions = new Map<number, LogSubscription>()
  private readonly disposeLocalLog: (() => void) | null
  private lastSupervisorSequence = 0
  private daemonId: string | null = null
  private closed = false

  constructor(
    private readonly runtime: DesktopRuntimeConfig,
    private readonly localLogs?: DesktopLogSource,
  ) {
    this.disposeLocalLog = localLogs?.onLog(entry => this.dispatchLog(entry)) ?? null
  }

  async handle(request: DesktopControlRequest): Promise<DesktopControlResponse> {
    try {
      const command = desktopSupervisorCommandSchema.parse({
        command: request.command,
        payload: request.payload,
      })
      const client = await this.connect()
      let data: unknown
      if (command.command === 'status') {
        data = this.mergePersistenceState(await client.status())
      } else if (command.command === 'diagnostics_start') {
        data = await client.startDiagnostics()
      } else if (command.command === 'diagnostics_stop') {
        data = await client.stopDiagnostics()
      } else {
        data = await client.operate({
          action: command.command,
          target: command.payload.target,
          operationId: command.payload.operationId,
          ...(command.command === 'stop' && command.payload.keepInfra !== undefined
            ? { keepInfra: command.payload.keepInfra }
            : {}),
        })
      }
      return { version: request.version, requestId: request.requestId, ok: true, data }
    } catch (error) {
      this.releaseClient()
      return {
        version: request.version,
        requestId: request.requestId,
        ok: false,
        error: { code: 'supervisor_unavailable', message: safeMessage(error) },
      }
    }
  }

  async logs(query: OperationsLogQuery): Promise<OperationsLogPage> {
    try {
      return await this.readLogs(query)
    } catch (error) {
      throw new Error(safeMessage(error))
    }
  }

  async history(query: OperationsLogQuery): Promise<OperationsLogPage> {
    const local = await this.localLogs?.readHistory(query) ?? emptyPage(query.afterSequence)
    const client = await this.connect()
    const supervisor = await client.historyLogs(query.services, query.tail, query)
    return mergeLogPages(supervisor, local, query.tail)
  }

  async diagnosticBundle(): Promise<DesktopDiagnosticBundle> {
    const client = await this.connect()
    const localLogs = this.localLogs
    const [snapshot, supervisorEntries, localEntries] = await Promise.all([
      client.status(),
      collectLogPages(query => client.logs(query.services, query.tail, query)),
      localLogs
        ? collectLogPages(query => localLogs.read(query))
        : Promise.resolve([]),
    ])
    const entries = deduplicateLogs([...supervisorEntries, ...localEntries])
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    return {
      formatVersion: 1,
      capturedAt: new Date().toISOString(),
      snapshot: this.mergePersistenceState(snapshot),
      entries,
    }
  }

  async subscribeLogs(
    ownerWebContentsId: number,
    active: boolean,
    filter: OperationsLogFilter,
    deliver: (entry: OperationsLogEntry) => void,
  ): Promise<void> {
    if (!active) {
      this.logSubscriptions.delete(ownerWebContentsId)
      if (this.logSubscriptions.size === 0 && this.client) {
        await this.client.subscribe({ metrics: false, logs: false })
      }
      return
    }
    this.logSubscriptions.set(ownerWebContentsId, { filter, deliver })
    await this.ensureLogSubscription()
  }

  close(): void {
    this.closed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.disposeLocalLog?.()
    this.logSubscriptions.clear()
    this.releaseClient()
  }

  /** 最高风险关闭仍由 Main 的独立文字确认边界调用。 */
  async shutdown(): Promise<OperationsOperationResult> {
    try {
      return await (await this.connect()).shutdown()
    } catch (error) {
      this.releaseClient()
      throw new Error(safeMessage(error))
    }
  }

  private async readLogs(query: OperationsLogQuery): Promise<OperationsLogPage> {
    const local = await this.localLogs?.read(query) ?? emptyPage(query.afterSequence)
    try {
      const client = await this.connect()
      const supervisor = await client.logs(query.services, query.tail, query)
      return mergeLogPages(supervisor, local, query.tail)
    } catch (error) {
      this.releaseClient()
      if (!query.includeSupervisor) throw error
      const unavailable = operationsLogEntrySchema.parse({
        sequence: 1_999_999_999,
        serviceId: null,
        component: 'desktop',
        processId: process.pid,
        stream: 'supervisor',
        level: 'error',
        event: 'system.supervisor.unavailable',
        category: 'system',
        retention: 'diagnostic',
        correlation: {},
        message: `Supervisor 日志不可用：${safeMessage(error)}`,
        errorStack: null,
        attributes: {},
        createdAt: new Date().toISOString(),
      })
      return mergeLogPages(
        { entries: matchesOperationsLogFilter(unavailable, query) ? [unavailable] : [], nextCursor: null, hasMore: false },
        local,
        query.tail,
      )
    }
  }

  private async ensureLogSubscription(): Promise<void> {
    if (this.logSubscriptions.size === 0 || this.closed) return
    if (this.subscriptionSync) return this.subscriptionSync
    this.subscriptionSync = this.synchronizeLogSubscription()
    try {
      await this.subscriptionSync
    } finally {
      this.subscriptionSync = null
    }
  }

  private async synchronizeLogSubscription(): Promise<void> {
    try {
      const client = await this.connect()
      const catchupEntries: OperationsLogEntry[] = []
      this.queuedSupervisorLogs = catchupEntries
      await client.subscribe({ metrics: false, logs: true, logFilter: BROAD_LOG_FILTER })
      let cursor = this.lastSupervisorSequence
      while (this.logSubscriptions.size > 0 && !this.closed) {
        const missed = await client.logs(['infra', 'worker', 'api'], 10_000, {
          ...BROAD_LOG_FILTER,
          afterSequence: cursor,
        })
        catchupEntries.push(...missed.entries)
        const nextCursor = missed.nextCursor
        if (!missed.hasMore || nextCursor === null || nextCursor <= cursor) break
        cursor = nextCursor
      }
      this.queuedSupervisorLogs = null
      for (const entry of catchupEntries.sort((left, right) => left.sequence - right.sequence)) {
        this.dispatchSupervisorLog(entry)
      }
      if (this.logSubscriptions.size === 0 && !this.closed) {
        await client.subscribe({ metrics: false, logs: false })
      }
    } catch {
      this.queuedSupervisorLogs = null
      this.releaseClient()
      this.scheduleReconnect()
    }
  }

  private async connect(): Promise<OperationsClient> {
    if (this.client) return this.client
    const paths = await resolveOperationsPaths({
      projectRoot: this.runtime.projectRoot,
      runtimeRoot: this.runtime.runtimeRoot,
      tokenFile: this.runtime.supervisorTokenFile,
      profile: this.runtime.profile,
    })
    const token = (await readFile(paths.tokenFile, 'utf8')).trim()
    const client = await OperationsClient.connect({ endpoint: paths.endpoint, token, interactive: false })
    if (this.daemonId !== null && this.daemonId !== client.server.daemonId) this.lastSupervisorSequence = 0
    this.daemonId = client.server.daemonId
    this.clientEventDisposer = client.onEvent(event => {
      if (event.event !== 'log') return
      if (this.queuedSupervisorLogs) this.queuedSupervisorLogs.push(event.entry)
      else this.dispatchSupervisorLog(event.entry)
    })
    client.onDisconnected(() => {
      if (this.client !== client) return
      this.releaseClient(false)
      this.scheduleReconnect()
    })
    this.client = client
    return client
  }

  private dispatchSupervisorLog(entry: OperationsLogEntry): void {
    if (entry.sequence <= this.lastSupervisorSequence) return
    this.lastSupervisorSequence = entry.sequence
    this.dispatchLog(entry)
  }

  private dispatchLog(entry: OperationsLogEntry): void {
    for (const subscription of this.logSubscriptions.values()) {
      if (matchesOperationsLogFilter(entry, subscription.filter)) subscription.deliver(entry)
    }
  }

  private mergePersistenceState(snapshot: OperationsSnapshot): OperationsSnapshot {
    const local = this.localLogs?.persistenceState()
    if (!local || local.state === 'healthy') return snapshot
    return {
      ...snapshot,
      observability: { ...snapshot.observability, persistence: local },
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.logSubscriptions.size === 0 || this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.ensureLogSubscription()
    }, 1_000)
    this.reconnectTimer.unref()
  }

  private releaseClient(close = true): void {
    const client = this.client
    this.client = null
    this.clientEventDisposer?.()
    this.clientEventDisposer = null
    this.queuedSupervisorLogs = null
    if (close) client?.close()
  }
}

function mergeLogPages(
  supervisor: OperationsLogPage,
  desktop: OperationsLogPage,
  tail: number,
): OperationsLogPage {
  if (tail === 0) return emptyPage(null)
  const entries = [...supervisor.entries, ...desktop.entries]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .slice(-tail)
  return {
    entries,
    nextCursor: supervisor.nextCursor,
    hasMore: supervisor.hasMore || desktop.hasMore,
  }
}

function emptyPage(cursor: number | null): OperationsLogPage {
  return { entries: [], nextCursor: cursor, hasMore: false }
}

async function collectLogPages(
  read: (query: OperationsLogQuery) => Promise<OperationsLogPage>,
): Promise<OperationsLogEntry[]> {
  const entries: OperationsLogEntry[] = []
  let cursor = 0
  while (true) {
    const page = await read({ ...BROAD_LOG_FILTER, afterSequence: cursor, tail: 10_000 })
    entries.push(...page.entries)
    const nextCursor = page.nextCursor
    if (!page.hasMore) return entries
    if (nextCursor === null || nextCursor <= cursor) {
      throw new Error('日志分页游标未向前推进，诊断包导出已停止。')
    }
    cursor = nextCursor
  }
}

function deduplicateLogs(entries: readonly OperationsLogEntry[]): OperationsLogEntry[] {
  const unique = new Map<string, OperationsLogEntry>()
  for (const entry of entries) {
    unique.set(`${entry.serviceId ?? entry.component ?? 'system'}:${entry.sequence}:${entry.createdAt}`, entry)
  }
  return [...unique.values()]
}

function safeMessage(error: unknown): string {
  if (!(error instanceof Error)) return '无法连接本机监督器。'
  const message = error.message.replace(/[\r\n]+/gu, ' ').slice(0, 500)
  if (/\bENOENT\b/iu.test(message)) return '本机监督器尚未初始化或运行文件缺失。'
  if (/\b(?:EACCES|EPERM)\b/iu.test(message)) return '当前账户无权访问本机监督器。'
  if (/\bECONNREFUSED\b|named pipe|unix socket/iu.test(message)) return '本机监督器尚未运行。'
  return message
}
