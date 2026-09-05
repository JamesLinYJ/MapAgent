// +-------------------------------------------------------------------------
//
//   地理智能平台 - 本机 Agent WebSocket 客户端
//
//   文件:       localAgentClient.ts
//
//   日期:       2026年07月27日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'

import {
  parseWsControlRequest,
  wsCommandContract,
  wsControlResponseEnvelopeSchema,
  wsServerMessageEnvelopeSchema,
  wsServerPushSchema,
  wsServerPushTypeSchema,
  type WsControlCommand,
  type WsServerPush,
} from '@geo-agent-platform/shared-types/transport'
import {
  PLATFORM_TECHNICAL_ID,
  PRODUCT_CODENAME,
} from '@geo-agent-platform/shared-types/product-identity'
import WebSocket from 'ws'
import { z } from 'zod'

const MAX_FRAME_BYTES = 64 * 1024
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 45_000
export type LocalAgentPush = WsServerPush

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export interface LocalAgentClientOptions {
  appBaseUrl: string
  origin: string
  headers: Headers
  csrfToken: string
  timeoutMs?: number
}

/**
 * 只实现平台已注册的 WS 命令。它不持有根密钥、模型密钥或任意命令
 * 能力；Cookie 仅保存在当前进程内存中。
 */
export class LocalAgentClient {
  private readonly events = new EventEmitter()
  private readonly pending = new Map<string, PendingRequest>()
  private readonly timeoutMs: number
  private receiveBuffer = ''
  private intentionallyClosed = false

  private constructor(
    private readonly socket: WebSocket,
    private readonly csrfToken: string,
    timeoutMs: number,
  ) {
    this.timeoutMs = timeoutMs
    socket.on('message', data => this.receive(data.toString()))
    socket.on('error', error => this.disconnect(error))
    socket.on('close', (code, reason) => {
      if (this.intentionallyClosed) return
      const detail = reason.toString().trim()
      this.disconnect(new Error(`Agent 控制连接已中断（${code}${detail ? `：${detail}` : ''}）。`))
    })
  }

  static async connect(options: LocalAgentClientOptions): Promise<LocalAgentClient> {
    const endpoint = localAgentWsUrl(options.appBaseUrl)
    const cookie = options.headers.get('cookie')
    if (!cookie) throw new Error('本机 Agent 会话缺少 Better Auth Cookie。')
    const socket = new WebSocket(endpoint, {
      origin: options.origin,
      headers: {
        cookie,
        'user-agent': `${PLATFORM_TECHNICAL_ID}-local-agent/1`,
      },
      maxPayload: MAX_RESPONSE_BYTES,
      perMessageDeflate: false,
      handshakeTimeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    })
    await waitForOpen(socket, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    return new LocalAgentClient(socket, options.csrfToken, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  }

  send<T>(
    type: WsControlCommand,
    payload: Record<string, unknown>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    if (this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Agent 控制连接尚未建立。'))
    }
    const id = `local_agent_${randomUUID()}`
    const request = parseWsControlRequest({
      type,
      id,
      payload,
      meta: { csrfToken: this.csrfToken },
    })
    const frame = `${JSON.stringify(request)}\n`
    if (Buffer.byteLength(frame, 'utf8') > MAX_FRAME_BYTES) {
      return Promise.reject(new Error('Agent 控制请求超过 64 KiB 协议上限。'))
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Agent 控制命令 ${type} 超时。`))
      }, this.timeoutMs)
      timer.unref()
      this.pending.set(id, {
        resolve: value => {
          const protocol = wsCommandContract(type).response.safeParse(value)
          if (!protocol.success) {
            reject(new Error(`Agent 控制命令 ${type} 的响应不符合共享协议。`))
            return
          }
          const parsed = schema.safeParse(protocol.data)
          if (!parsed.success) {
            reject(new Error(`Agent 控制命令 ${type} 的响应不符合协议。`))
            return
          }
          resolve(parsed.data)
        },
        reject,
        timer,
      })
      this.socket.send(frame, error => {
        if (!error) return
        const pending = this.pending.get(id)
        if (!pending) return
        clearTimeout(pending.timer)
        this.pending.delete(id)
        pending.reject(new Error(`Agent 控制命令 ${type} 发送失败。`, { cause: error }))
      })
    })
  }

  onPush(listener: (message: LocalAgentPush) => void): () => void {
    this.events.on('push', listener)
    return () => this.events.off('push', listener)
  }

  onDisconnected(listener: (error: Error) => void): () => void {
    this.events.on('disconnected', listener)
    return () => this.events.off('disconnected', listener)
  }

  close(): void {
    if (this.intentionallyClosed) return
    this.intentionallyClosed = true
    const error = new Error('本机 Agent 客户端已关闭。')
    this.rejectPending(error)
    this.events.removeAllListeners()
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close(1000, 'local Agent detached')
    }
  }

  private receive(chunk: string): void {
    this.receiveBuffer += chunk
    if (Buffer.byteLength(this.receiveBuffer, 'utf8') > MAX_RESPONSE_BYTES) {
      this.socket.close(1009, 'frame too large')
      this.disconnect(new Error('Agent 控制响应超过 8 MiB 安全上限。'))
      return
    }
    let newline = this.receiveBuffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.receiveBuffer.slice(0, newline).trim()
      this.receiveBuffer = this.receiveBuffer.slice(newline + 1)
      if (line) this.receiveLine(line)
      newline = this.receiveBuffer.indexOf('\n')
    }
  }

  private receiveLine(line: string): void {
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      this.disconnect(new Error('Agent 控制响应不是合法 JSON。'))
      return
    }
    const parsed = wsServerMessageEnvelopeSchema.safeParse(raw)
    if (!parsed.success) {
      this.disconnect(new Error('Agent 控制响应 envelope 不符合协议。'))
      return
    }
    const message = parsed.data
    if (message.type === 'response') {
      const response = wsControlResponseEnvelopeSchema.safeParse(message)
      if (!response.success || !response.data.id) {
        this.disconnect(new Error('Agent 控制响应 envelope 不符合共享协议。'))
        return
      }
      const pending = this.pending.get(response.data.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(response.data.id)
      const payload = response.data.payload
      if (payload.ok === true) {
        pending.resolve(payload.data)
        return
      }
      pending.reject(new Error(payload.error.message.trim() || 'Agent 控制命令失败。'))
      return
    }
    if (!wsServerPushTypeSchema.safeParse(message.type).success) return
    const push = wsServerPushSchema.safeParse(message)
    if (!push.success) {
      this.disconnect(new Error(`Agent 控制 push '${message.type}' 不符合协议。`))
      return
    }
    this.events.emit('push', push.data)
  }

  private disconnect(error: Error): void {
    if (this.intentionallyClosed) return
    this.intentionallyClosed = true
    this.rejectPending(error)
    this.events.emit('disconnected', error)
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.terminate()
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}

export function localAgentWsUrl(appBaseUrl: string): string {
  const url = new URL(appBaseUrl)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('APP_BASE_URL 必须使用 http 或 https。')
  }
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = '/ws'
  url.search = ''
  url.hash = ''
  return url.toString()
}

function waitForOpen(socket: WebSocket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      socket.terminate()
      reject(new Error(`连接 ${PRODUCT_CODENAME} Agent 控制面超时。`))
    }, timeoutMs)
    timer.unref()
    const onOpen = (): void => {
      cleanup()
      resolve()
    }
    const onError = (error: Error): void => {
      cleanup()
      reject(new Error(`无法连接 ${PRODUCT_CODENAME} Agent 控制面。`, { cause: error }))
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      socket.off('open', onOpen)
      socket.off('error', onError)
    }
    socket.once('open', onOpen)
    socket.once('error', onError)
  })
}
