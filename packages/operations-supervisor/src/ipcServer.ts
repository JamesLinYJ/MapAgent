// +-------------------------------------------------------------------------
//
//   地理智能平台 - 本机监督控制 IPC 服务
//
//   文件:       ipcServer.ts
//
//   日期:       2026年07月22日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { createHash, timingSafeEqual } from 'node:crypto'
import { rm } from 'node:fs/promises'
import net, { type Socket } from 'node:net'

import {
  OPERATIONS_PROTOCOL_VERSION,
  operationsClientHelloSchema,
  operationsRequestSchema,
  type OperationsEvent,
  type OperationsLogFilter,
  type OperationsLogEntry,
  type OperationsRequest,
  type OperationsResponse,
  type OperationsServerReject,
} from '@geo-agent-platform/shared-types/operations'
import type { Logger } from 'pino'
import { z } from 'zod'

import { encodeJsonlFrame, FrameTooLargeError, JsonlFrameDecoder, OPERATIONS_MAX_FRAME_BYTES } from './jsonl.js'
import { matchesOperationsLogFilter } from './logBuffer.js'
import { OperationsSupervisor, type SupervisorActor } from './supervisor.js'

const requestIdentitySchema = z.object({ requestId: z.string().uuid() }).passthrough()

interface ClientState {
  socket: Socket
  decoder: JsonlFrameDecoder
  actor: SupervisorActor | null
  handshaken: boolean
  metrics: boolean
  logs: boolean
  logFilter: OperationsLogFilter
  queue: Promise<void>
  handshakeTimer: NodeJS.Timeout
  disposeSnapshot: (() => void) | null
  disposeLog: (() => void) | null
  disposeOperation: (() => void) | null
}

export interface OperationsIpcServerOptions {
  endpoint: string
  token: string
  supervisor: OperationsSupervisor
  logger: Logger
  onShutdownRequested: () => void
}

export class OperationsIpcServer {
  private readonly server = net.createServer(socket => this.accept(socket))
  private readonly clients = new Set<ClientState>()

  constructor(private readonly options: OperationsIpcServerOptions) {
    this.server.on('error', error => this.options.logger.error({ error }, '监督 IPC 服务错误'))
  }

  async listen(): Promise<void> {
    if (process.platform !== 'win32') await rm(this.options.endpoint, { force: true })
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.server.off('listening', onListening)
        reject(error)
      }
      const onListening = (): void => {
        this.server.off('error', onError)
        resolve()
      }
      this.server.once('error', onError)
      this.server.once('listening', onListening)
      this.server.listen(this.options.endpoint)
    })
  }

  async close(): Promise<void> {
    for (const state of [...this.clients]) this.disposeClient(state, true)
    if (this.server.listening) {
      await new Promise<void>(resolve => this.server.close(() => resolve()))
    }
    if (process.platform !== 'win32') await rm(this.options.endpoint, { force: true })
  }

  private accept(socket: Socket): void {
    socket.setNoDelay(true)
    const state: ClientState = {
      socket,
      decoder: new JsonlFrameDecoder(),
      actor: null,
      handshaken: false,
      metrics: false,
      logs: false,
      logFilter: defaultLogFilter(),
      queue: Promise.resolve(),
      handshakeTimer: setTimeout(() => {
        this.rejectHandshake(state, 'invalid_handshake', '连接未在期限内完成握手。')
      }, 5_000),
      disposeSnapshot: null,
      disposeLog: null,
      disposeOperation: null,
    }
    state.handshakeTimer.unref()
    this.clients.add(state)
    socket.on('data', chunk => {
      try {
        const frames = state.decoder.push(chunk)
        for (const frame of frames) {
          state.queue = state.queue.then(() => this.processFrame(state, frame)).catch(error => {
            this.options.logger.warn({ error }, '监督 IPC 客户端帧处理失败')
            this.disposeClient(state, true)
          })
        }
      } catch (error) {
        if (error instanceof FrameTooLargeError) {
          this.rejectHandshake(state, 'frame_too_large', error.message)
          return
        }
        this.disposeClient(state, true)
      }
    })
    socket.once('close', () => this.disposeClient(state, false))
    socket.once('error', error => {
      this.options.logger.debug({ error }, '监督 IPC 客户端连接关闭')
      this.disposeClient(state, true)
    })
  }

  private async processFrame(state: ClientState, frame: string): Promise<void> {
    let value: unknown
    try {
      value = JSON.parse(frame)
    } catch {
      if (!state.handshaken) this.rejectHandshake(state, 'invalid_handshake', '握手不是有效 JSON。')
      else this.rejectInvalidRequest(state, null)
      return
    }
    if (!state.handshaken) {
      this.processHandshake(state, value)
      return
    }
    const parsed = operationsRequestSchema.safeParse(value)
    if (!parsed.success) {
      this.rejectInvalidRequest(state, value)
      return
    }
    await this.handleRequest(state, parsed.data)
  }

  private processHandshake(state: ClientState, value: unknown): void {
    const parsed = operationsClientHelloSchema.safeParse(value)
    if (!parsed.success) {
      const version = readProtocolVersion(value)
      this.rejectHandshake(
        state,
        version !== null && version !== OPERATIONS_PROTOCOL_VERSION ? 'incompatible_version' : 'invalid_handshake',
        version !== null && version !== OPERATIONS_PROTOCOL_VERSION
          ? `协议版本不兼容：客户端 ${version}，监督器 ${OPERATIONS_PROTOCOL_VERSION}。`
          : '握手内容不符合监督协议。',
      )
      return
    }
    if (!tokensEqual(parsed.data.token, this.options.token)) {
      this.rejectHandshake(state, 'unauthorized', '监督令牌无效。')
      return
    }
    clearTimeout(state.handshakeTimer)
    state.handshaken = true
    state.actor = {
      osUser: parsed.data.client.osUser,
      hostname: parsed.data.client.hostname,
      processId: parsed.data.client.processId,
    }
    this.write(state, {
      kind: 'welcome',
      protocolVersion: OPERATIONS_PROTOCOL_VERSION,
      daemonId: this.options.supervisor.id,
      workspaceId: this.options.supervisor.workspaceId,
      profile: this.options.supervisor.profile,
    })
    state.disposeSnapshot = this.options.supervisor.onSnapshot(snapshot => {
      if (state.metrics) this.writeEvent(state, { kind: 'event', event: 'snapshot', snapshot })
    })
    state.disposeLog = this.options.supervisor.onLog(entry => {
      if (state.logs && matchesOperationsLogFilter(entry, state.logFilter)) {
        this.writeEvent(state, { kind: 'event', event: 'log', entry })
      }
    })
    state.disposeOperation = this.options.supervisor.onOperation(operation => {
      this.writeEvent(state, { kind: 'event', event: 'operation', operation })
    })
  }

  private async handleRequest(state: ClientState, request: OperationsRequest): Promise<void> {
    if (request.action === 'status') {
      this.respond(state, request.requestId, { type: 'snapshot', snapshot: this.options.supervisor.snapshot() })
      return
    }
    if (request.action === 'subscribe') {
      if (state.metrics !== request.metrics) this.options.supervisor.setMetricsSubscriber(request.metrics)
      state.metrics = request.metrics
      state.logs = request.logs
      state.logFilter = request.logFilter ?? defaultLogFilter()
      this.respond(state, request.requestId, { type: 'subscribed' })
      if (state.metrics) this.writeEvent(state, {
        kind: 'event',
        event: 'snapshot',
        snapshot: this.options.supervisor.snapshot(),
      })
      return
    }
    if (request.action === 'logs' || request.action === 'history_logs') {
      const page = request.action === 'logs'
        ? this.options.supervisor.queryLogs(request.query)
        : await this.options.supervisor.queryHistoryLogs(request.query)
      const entries = fitLogEntries(
        request.requestId,
        page.entries,
        request.query.afterSequence !== null,
      )
      this.respond(state, request.requestId, {
        type: 'logs',
        page: {
          entries,
          nextCursor: entries.at(-1)?.sequence ?? request.query.afterSequence,
          hasMore: page.hasMore || entries.length < page.entries.length,
        },
      })
      return
    }
    if (request.action === 'operation_result') {
      this.respond(state, request.requestId, {
        type: 'operation',
        operation: this.options.supervisor.operationResult(request.operationId),
      })
      return
    }
    if (request.action === 'diagnostics_start' || request.action === 'diagnostics_stop') {
      const diagnostics = request.action === 'diagnostics_start'
        ? this.options.supervisor.startDiagnostics()
        : this.options.supervisor.stopDiagnostics()
      this.respond(state, request.requestId, { type: 'diagnostics', diagnostics })
      return
    }
    const actor = state.actor
    if (!actor) throw new Error('监督连接缺少操作身份。')
    const result = await this.options.supervisor.execute({
      action: request.action,
      target: request.action === 'shutdown' ? 'all' : request.target,
      operationId: request.operationId,
      actor,
      ...('keepInfra' in request && request.keepInfra !== undefined ? { keepInfra: request.keepInfra } : {}),
    })
    const payload = { type: 'operation', operation: result } as const
    if (request.action === 'shutdown') {
      await this.respondFlushed(state, request.requestId, payload)
      this.disposeClient(state, false)
      this.options.onShutdownRequested()
    } else {
      this.respond(state, request.requestId, payload)
    }
  }

  private respond(state: ClientState, requestId: string, payload: Extract<OperationsResponse, { ok: true }>['payload']): void {
    this.write(state, { kind: 'response', requestId, ok: true, payload } satisfies OperationsResponse)
  }

  private async respondFlushed(
    state: ClientState,
    requestId: string,
    payload: Extract<OperationsResponse, { ok: true }>['payload'],
  ): Promise<void> {
    const frame = encodeJsonlFrame({ kind: 'response', requestId, ok: true, payload } satisfies OperationsResponse)
    await new Promise<void>((resolve, reject) => {
      if (state.socket.destroyed) {
        reject(new Error('IPC 客户端在操作确认前断开。'))
        return
      }
      const onError = (error: Error): void => reject(error)
      state.socket.once('error', onError)
      state.socket.end(frame, () => {
        state.socket.off('error', onError)
        resolve()
      })
    })
  }

  private rejectInvalidRequest(state: ClientState, value: unknown): void {
    const identity = requestIdentitySchema.safeParse(value)
    if (!identity.success) {
      this.disposeClient(state, true)
      return
    }
    this.write(state, {
      kind: 'response',
      requestId: identity.data.requestId,
      ok: false,
      error: { code: 'invalid_request', message: '请求不符合监督协议。' },
    } satisfies OperationsResponse)
  }

  private rejectHandshake(state: ClientState, code: OperationsServerReject['code'], message: string): void {
    if (!state.socket.destroyed) {
      try {
        state.socket.end(encodeJsonlFrame({
          kind: 'rejected',
          protocolVersion: OPERATIONS_PROTOCOL_VERSION,
          code,
          message,
        } satisfies OperationsServerReject))
      } catch {
        state.socket.destroy()
      }
    }
    this.disposeClient(state, false)
  }

  private writeEvent(state: ClientState, event: OperationsEvent): void {
    try {
      this.write(state, event)
    } catch (error) {
      this.options.logger.warn({ error }, '监督 IPC 推送帧过大，已断开客户端')
      this.disposeClient(state, true)
    }
  }

  private write(state: ClientState, value: unknown): void {
    if (!state.socket.destroyed) state.socket.write(encodeJsonlFrame(value))
  }

  private disposeClient(state: ClientState, destroy: boolean): void {
    if (!this.clients.delete(state)) return
    clearTimeout(state.handshakeTimer)
    if (state.metrics) this.options.supervisor.setMetricsSubscriber(false)
    state.disposeSnapshot?.()
    state.disposeLog?.()
    state.disposeOperation?.()
    if (destroy && !state.socket.destroyed) state.socket.destroy()
  }
}

function defaultLogFilter(): OperationsLogFilter {
  return {
    services: ['infra', 'worker', 'api'],
    levels: [],
    streams: [],
    categories: [],
    events: [],
    retentions: [],
    correlationId: '',
    search: '',
    includeSupervisor: false,
    afterSequence: null,
  }
}

function tokensEqual(candidate: string, expected: string): boolean {
  const left = createHash('sha256').update(candidate).digest()
  const right = createHash('sha256').update(expected).digest()
  return timingSafeEqual(left, right)
}

function readProtocolVersion(value: unknown): number | null {
  if (!value || typeof value !== 'object' || !('protocolVersion' in value)) return null
  const version = (value as { protocolVersion?: unknown }).protocolVersion
  return typeof version === 'number' && Number.isInteger(version) ? version : null
}

function fitLogEntries(
  requestId: string,
  entries: OperationsLogEntry[],
  preserveOldest: boolean,
): OperationsLogEntry[] {
  const selected: OperationsLogEntry[] = []
  let bytes = 256
  if (preserveOldest) {
    for (const entry of entries) {
      const entryBytes = Buffer.byteLength(JSON.stringify(entry), 'utf8') + 1
      if (bytes + entryBytes >= OPERATIONS_MAX_FRAME_BYTES) break
      selected.push(entry)
      bytes += entryBytes
    }
  } else {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]
      if (!entry) continue
      const entryBytes = Buffer.byteLength(JSON.stringify(entry), 'utf8') + 1
      if (bytes + entryBytes >= OPERATIONS_MAX_FRAME_BYTES) break
      selected.unshift(entry)
      bytes += entryBytes
    }
  }
  while (selected.length > 0) {
    const frame: OperationsResponse = {
      kind: 'response',
      requestId,
      ok: true,
      payload: {
        type: 'logs',
        page: {
          entries: selected,
          nextCursor: selected.at(-1)?.sequence ?? null,
          hasMore: false,
        },
      },
    }
    try {
      encodeJsonlFrame(frame)
      return selected
    } catch (error) {
      if (!(error instanceof FrameTooLargeError)) throw error
      if (preserveOldest) selected.pop()
      else selected.shift()
    }
  }
  return []
}
