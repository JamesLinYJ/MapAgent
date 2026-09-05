// +-------------------------------------------------------------------------
//
//   地理智能平台 - 本机监督 IPC 客户端
//
//   文件:       client.ts
//
//   日期:       2026年07月22日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import net, { type Socket } from 'node:net'
import os from 'node:os'

import {
  OPERATIONS_PROTOCOL_VERSION,
  operationsEventSchema,
  operationsResponseSchema,
  operationsServerHandshakeSchema,
  type OperationsEvent,
  type OperationsLogEntry,
  type OperationsLogFilter,
  type OperationsLogPage,
  type OperationsOperationResult,
  type OperationsRequest,
  type OperationsResponse,
  type OperationsServerHello,
  type OperationsServiceId,
  type OperationsSnapshot,
} from '@geo-agent-platform/shared-types/operations'

import { encodeJsonlFrame, JsonlFrameDecoder } from './jsonl.js'

interface PendingRequest {
  resolve: (response: OperationsResponse) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export interface ConnectOperationsClientOptions {
  endpoint: string
  token: string
  interactive: boolean
  timeoutMs?: number
}

type OperationsClientOperationInput = {
  action: 'start' | 'restart'
  target: OperationsServiceId | 'all'
  operationId?: string
} | {
  action: 'stop'
  target: OperationsServiceId | 'all'
  operationId?: string
  keepInfra?: boolean
}

export interface OperationsLogQueryOptions {
  levels?: OperationsLogEntry['level'][]
  streams?: OperationsLogEntry['stream'][]
  categories?: OperationsLogEntry['category'][]
  events?: string[]
  retentions?: OperationsLogEntry['retention'][]
  correlationId?: string
  search?: string
  includeSupervisor?: boolean
  afterSequence?: number | null
}

export class OperationsClient extends EventEmitter {
  private readonly pending = new Map<string, PendingRequest>()
  private readonly decoder = new JsonlFrameDecoder()
  private closed = false

  private constructor(
    private readonly socket: Socket,
    readonly server: OperationsServerHello,
  ) {
    super()
    socket.on('data', chunk => this.processData(chunk))
    socket.once('close', () => this.handleClose(new Error('监督器连接已关闭。')))
    socket.once('error', error => this.handleClose(new Error(`监督器连接错误：${safeMessage(error)}`)))
  }

  static async connect(options: ConnectOperationsClientOptions): Promise<OperationsClient> {
    const socket = net.createConnection(options.endpoint)
    socket.setNoDelay(true)
    const timeoutMs = options.timeoutMs ?? 10_000
    const decoder = new JsonlFrameDecoder()
    return new Promise<OperationsClient>((resolve, reject) => {
      let settled = false
      const finishError = (error: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.destroy()
        reject(error)
      }
      const timer = setTimeout(() => finishError(new Error('连接监督器超时。')), timeoutMs)
      socket.once('error', error => finishError(new Error(`无法连接监督器：${safeMessage(error)}`)))
      socket.once('connect', () => {
        socket.write(encodeJsonlFrame({
          kind: 'hello',
          protocolVersion: OPERATIONS_PROTOCOL_VERSION,
          token: options.token,
          client: {
            processId: process.pid,
            osUser: localUserName(),
            hostname: os.hostname(),
            interactive: options.interactive,
          },
        }))
      })
      const onData = (chunk: Buffer): void => {
        try {
          for (const frame of decoder.push(chunk)) {
            const parsed = operationsServerHandshakeSchema.safeParse(JSON.parse(frame))
            if (!parsed.success) {
              finishError(new Error('监督器返回了无效握手。'))
              return
            }
            if (parsed.data.kind === 'rejected') {
              finishError(new Error(parsed.data.message))
              return
            }
            settled = true
            clearTimeout(timer)
            socket.off('data', onData)
            resolve(new OperationsClient(socket, parsed.data))
            return
          }
        } catch (error) {
          finishError(new Error(`监督器握手解析失败：${safeMessage(error)}`))
        }
      }
      socket.on('data', onData)
    })
  }

  onEvent(listener: (event: OperationsEvent) => void): () => void {
    this.on('operations-event', listener)
    return () => this.off('operations-event', listener)
  }

  onDisconnected(listener: (error: Error) => void): () => void {
    this.on('disconnected', listener)
    return () => this.off('disconnected', listener)
  }

  async status(): Promise<OperationsSnapshot> {
    const response = await this.send({ kind: 'request', requestId: randomUUID(), action: 'status' })
    if (response.type !== 'snapshot') throw new Error('监督器状态响应类型不正确。')
    return response.snapshot
  }

  async subscribe(input: {
    metrics: boolean
    logs: boolean
    logFilter?: OperationsLogFilter
  }): Promise<void> {
    const response = await this.send({
      kind: 'request',
      requestId: randomUUID(),
      action: 'subscribe',
      metrics: input.metrics,
      logs: input.logs,
      ...(input.logFilter ? { logFilter: input.logFilter } : {}),
    })
    if (response.type !== 'subscribed') throw new Error('监督器订阅响应类型不正确。')
  }

  async logs(
    services: readonly OperationsServiceId[],
    tail: number,
    options: OperationsLogQueryOptions = {},
  ): Promise<OperationsLogPage> {
    const response = await this.send({
      kind: 'request',
      requestId: randomUUID(),
      action: 'logs',
      query: logQuery(services, tail, options),
    })
    if (response.type !== 'logs') throw new Error('监督器日志响应类型不正确。')
    return response.page
  }

  async historyLogs(
    services: readonly OperationsServiceId[],
    tail: number,
    options: OperationsLogQueryOptions = {},
  ): Promise<OperationsLogPage> {
    const response = await this.send({
      kind: 'request',
      requestId: randomUUID(),
      action: 'history_logs',
      query: logQuery(services, tail, options),
    })
    if (response.type !== 'logs') throw new Error('监督器历史日志响应类型不正确。')
    return response.page
  }

  async startDiagnostics(): Promise<OperationsSnapshot['observability']['diagnostics']> {
    const response = await this.send({
      kind: 'request',
      requestId: randomUUID(),
      action: 'diagnostics_start',
    })
    if (response.type !== 'diagnostics') throw new Error('监督器诊断模式响应类型不正确。')
    return response.diagnostics
  }

  async stopDiagnostics(): Promise<OperationsSnapshot['observability']['diagnostics']> {
    const response = await this.send({
      kind: 'request',
      requestId: randomUUID(),
      action: 'diagnostics_stop',
    })
    if (response.type !== 'diagnostics') throw new Error('监督器诊断模式响应类型不正确。')
    return response.diagnostics
  }

  async operate(input: OperationsClientOperationInput): Promise<OperationsOperationResult> {
    const response = await this.send({
      kind: 'request',
      requestId: randomUUID(),
      action: input.action,
      target: input.target,
      operationId: input.operationId ?? randomUUID(),
      ...(input.action === 'stop' && input.keepInfra !== undefined ? { keepInfra: input.keepInfra } : {}),
    }, 5 * 60_000)
    if (response.type !== 'operation' || !response.operation) throw new Error('监督器操作响应类型不正确。')
    return response.operation
  }

  async operationResult(operationId: string): Promise<OperationsOperationResult | null> {
    const response = await this.send({
      kind: 'request',
      requestId: randomUUID(),
      action: 'operation_result',
      operationId,
    })
    if (response.type !== 'operation') throw new Error('监督器操作查询响应类型不正确。')
    return response.operation
  }

  async shutdown(operationId = randomUUID()): Promise<OperationsOperationResult> {
    const response = await this.send({
      kind: 'request',
      requestId: randomUUID(),
      action: 'shutdown',
      operationId,
    }, 5 * 60_000)
    if (response.type !== 'operation' || !response.operation) throw new Error('监督器关闭响应类型不正确。')
    return response.operation
  }

  close(): void {
    if (!this.socket.destroyed) this.socket.end()
    this.handleClose(new Error('客户端已分离。'))
  }

  private async send(
    request: OperationsRequest,
    timeoutMs = 45_000,
  ): Promise<Extract<OperationsResponse, { ok: true }>['payload']> {
    if (this.closed) throw new Error('监督器连接已关闭。')
    const response = await new Promise<OperationsResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.requestId)
        reject(new Error('监督操作等待超时；可使用 operationId 查询结果。'))
      }, timeoutMs)
      timer.unref()
      this.pending.set(request.requestId, { resolve, reject, timer })
      try {
        this.socket.write(encodeJsonlFrame(request))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(request.requestId)
        reject(error instanceof Error ? error : new Error('无法发送监督请求。'))
      }
    })
    if (!response.ok) throw new OperationsRequestError(response.error.code, response.error.message)
    return response.payload
  }

  private processData(chunk: string | Uint8Array): void {
    try {
      for (const frame of this.decoder.push(chunk)) {
        const value: unknown = JSON.parse(frame)
        const response = operationsResponseSchema.safeParse(value)
        if (response.success) {
          const pending = this.pending.get(response.data.requestId)
          if (!pending) continue
          clearTimeout(pending.timer)
          this.pending.delete(response.data.requestId)
          pending.resolve(response.data)
          continue
        }
        const event = operationsEventSchema.safeParse(value)
        if (!event.success) throw new Error('监督器发送了不符合协议的帧。')
        this.emit('operations-event', event.data)
      }
    } catch (error) {
      this.handleClose(new Error(`监督器协议错误：${safeMessage(error)}`))
      this.socket.destroy()
    }
  }

  private handleClose(error: Error): void {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    this.emit('disconnected', error)
  }
}

export class OperationsRequestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'OperationsRequestError'
  }
}

function localUserName(): string {
  try {
    return os.userInfo().username
  } catch {
    return process.env.USERNAME ?? process.env.USER ?? 'unknown'
  }
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message.replace(/[\r\n]+/gu, ' ').slice(0, 500) : '未知错误。'
}

function logQuery(
  services: readonly OperationsServiceId[],
  tail: number,
  options: OperationsLogQueryOptions,
): {
  services: OperationsServiceId[]
  levels: OperationsLogEntry['level'][]
  streams: OperationsLogEntry['stream'][]
  categories: OperationsLogEntry['category'][]
  events: string[]
  retentions: OperationsLogEntry['retention'][]
  correlationId: string
  search: string
  includeSupervisor: boolean
  afterSequence: number | null
  tail: number
} {
  return {
    services: [...services],
    levels: options.levels ?? [],
    streams: options.streams ?? [],
    categories: options.categories ?? [],
    events: options.events ?? [],
    retentions: options.retentions ?? [],
    correlationId: options.correlationId ?? '',
    search: options.search ?? '',
    includeSupervisor: options.includeSupervisor ?? false,
    afterSequence: options.afterSequence ?? null,
    tail,
  }
}
