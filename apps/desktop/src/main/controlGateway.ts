// +-------------------------------------------------------------------------
//
//   地理智能平台 - Electron WebSocket 控制面网关
//
//   文件:       controlGateway.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { BrowserWindow } from 'electron'
import {
  parseWsControlRequest,
  workspaceBootstrapSnapshotSchema,
  wsCommandContract,
  wsControlCommandSchema,
  wsServerMessageSchema,
  type WsControlCommand,
  type WsServerMessage,
} from '@geo-agent-platform/shared-types'
import { PLATFORM_DESKTOP_APP_ORIGIN } from '@geo-agent-platform/shared-types/product-identity'
import WebSocket from 'ws'

import {
  DESKTOP_CONTROL_FRAME_MAX_BYTES,
  DESKTOP_IPC_CHANNELS,
  desktopAuthProjectionSchema,
  desktopWorkspaceBootstrapSnapshotSchema,
  type DesktopControlRequest,
  type DesktopControlResponse,
  type DesktopEvent,
} from '../contracts/desktopIpc.js'
import type { DesktopAuthorizationContext } from './authGateway.js'
import { encodeDesktopEvent } from './eventTransportEncoder.js'

// WHATWG WebSocket 保留 1001–2999 给协议实现；应用主动关闭只能使用
// 1000 或 3000–4999。协议校验失败使用平台私有关闭码，避免 Electron 抛异常。
const CONTROL_PROTOCOL_ERROR_CLOSE_CODE = 4002
const CONTROL_EVENT_ERROR_CLOSE_CODE = 4009

interface PendingRequest {
  command: WsControlCommand
  resolve: (response: DesktopControlResponse) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface WindowConnection {
  window: BrowserWindow
  authorizationRevision: number | null
  socket: WebSocket | null
  connecting: Promise<WebSocket> | null
  pending: Map<string, PendingRequest>
}

export class DesktopControlGateway {
  private readonly connections = new Map<number, WindowConnection>()
  private readonly unsubscribeAuthorization: () => void

  constructor(
    private readonly apiBaseUrl: string,
    private readonly auth: DesktopControlAuthorization,
  ) {
    this.unsubscribeAuthorization = auth.onAuthorizationChanged(() => {
      for (const connection of this.connections.values()) {
        connection.authorizationRevision = null
        this.closeSocket(connection, 1000, '认证上下文已更新。')
      }
    })
  }

  async handle(
    window: BrowserWindow,
    request: DesktopControlRequest,
  ): Promise<DesktopControlResponse> {
    const connection = this.forWindow(window)
    const command = wsControlCommandSchema.parse(request.command)
    let authorization
    try {
      authorization = this.auth.requireAuthorizationContext()
    } catch {
      return failure(request, 'unauthorized', '请先登录后再使用实时控制功能。')
    }
    try {
      if (connection.authorizationRevision !== authorization.revision) {
        this.closeSocket(connection, 1000, '认证上下文已更新。')
        connection.authorizationRevision = authorization.revision
      }
      const socket = await this.ensureSocket(connection)
      const frame = JSON.stringify(parseWsControlRequest({
        type: command,
        id: request.requestId,
        payload: request.payload,
        meta: { csrfToken: authorization.csrfToken },
      }))
      if (Buffer.byteLength(frame, 'utf8') > DESKTOP_CONTROL_FRAME_MAX_BYTES) {
        throw new Error('控制请求超过 64 KiB 上限。')
      }
      return await new Promise<DesktopControlResponse>((resolve, reject) => {
        const timer = setTimeout(() => {
          connection.pending.delete(request.requestId)
          reject(new Error(`WebSocket 命令超时：${command}`))
        }, 45_000)
        timer.unref()
        connection.pending.set(request.requestId, { command, resolve, reject, timer })
        socket.send(frame)
      })
    } catch (error) {
      return failure(request, 'control_unavailable', safeMessage(error))
    }
  }

  closeForWindow(webContentsId: number): void {
    const connection = this.connections.get(webContentsId)
    if (!connection) return
    this.closeSocket(connection, 1000, '工作区窗口已关闭。')
    this.connections.delete(webContentsId)
  }

  close(): void {
    this.unsubscribeAuthorization()
    for (const connection of this.connections.values()) {
      this.closeSocket(connection, 1000, '桌面应用正在退出。')
    }
    this.connections.clear()
  }

  private forWindow(window: BrowserWindow): WindowConnection {
    const existing = this.connections.get(window.webContents.id)
    if (existing) return existing
    const connection: WindowConnection = {
      window,
      authorizationRevision: null,
      socket: null,
      connecting: null,
      pending: new Map(),
    }
    this.connections.set(window.webContents.id, connection)
    window.once('closed', () => this.closeForWindow(window.webContents.id))
    return connection
  }

  private async ensureSocket(connection: WindowConnection): Promise<WebSocket> {
    if (connection.socket?.readyState === WebSocket.OPEN) return connection.socket
    if (connection.connecting) return connection.connecting
    const wsUrl = new URL('/ws', `${this.apiBaseUrl}/`)
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:'
    const cookie = this.auth.cookieHeader()
    connection.connecting = new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(wsUrl, {
        headers: cookie ? { cookie } : {},
        origin: PLATFORM_DESKTOP_APP_ORIGIN,
      })
      const timer = setTimeout(() => {
        socket.close()
        reject(new Error('连接实时控制服务超时。'))
      }, 12_000)
      socket.onopen = () => {
        clearTimeout(timer)
        connection.socket = socket
        connection.connecting = null
        this.emit(connection.window, 'transport:status', { state: 'connected' })
        resolve(socket)
      }
      socket.onerror = () => {
        clearTimeout(timer)
        connection.connecting = null
        reject(new Error('无法连接实时控制服务。'))
      }
      socket.onmessage = event => this.handleMessage(connection, event.data)
      socket.onclose = event => {
        clearTimeout(timer)
        connection.connecting = null
        if (connection.socket === socket) connection.socket = null
        this.rejectPending(connection, `WebSocket 已断开：${event.reason || event.code}`)
        this.emit(connection.window, 'transport:status', {
          state: 'disconnected',
          reason: event.reason || String(event.code),
        })
      }
    })
    return connection.connecting
  }

  private handleMessage(connection: WindowConnection, raw: unknown): void {
    const text = typeof raw === 'string'
      ? raw
      : Buffer.isBuffer(raw)
        ? raw.toString('utf8')
        : ''
    for (const line of text.split('\n').filter(Boolean)) {
      let message: WsServerMessage
      try {
        message = wsServerMessageSchema.parse(JSON.parse(line))
      } catch {
        this.closeSocket(
          connection,
          CONTROL_PROTOCOL_ERROR_CLOSE_CODE,
          '服务端返回了无效控制帧。',
        )
        return
      }
      if (message.type === 'response') {
        if (!message.id) {
          this.closeSocket(
            connection,
            CONTROL_PROTOCOL_ERROR_CLOSE_CODE,
            '服务端返回了缺少请求标识的控制响应。',
          )
          return
        }
        const pending = connection.pending.get(message.id)
        if (!pending) continue
        clearTimeout(pending.timer)
        connection.pending.delete(message.id)
        try {
          pending.resolve(message.payload.ok
            ? {
                version: 1,
                requestId: message.id,
                ok: true,
                data: projectControlResponseData(pending.command, message.payload.data),
              }
            : {
                version: 1,
                requestId: message.id,
                ok: false,
                error: message.payload.error,
              })
        } catch (error) {
          pending.reject(error instanceof Error ? error : new Error('服务端返回了无效控制响应。'))
          this.closeSocket(
            connection,
            CONTROL_PROTOCOL_ERROR_CLOSE_CODE,
            '服务端返回了无效控制响应。',
          )
        }
        continue
      }
      try {
        this.emit(connection.window, 'transport:push', message)
      } catch (error) {
        this.closeSocket(connection, CONTROL_EVENT_ERROR_CLOSE_CODE, safeMessage(error))
        return
      }
    }
  }

  private emit(
    window: BrowserWindow,
    event: DesktopEvent['event'],
    payload: unknown,
  ): void {
    if (window.isDestroyed()) return
    window.webContents.send(DESKTOP_IPC_CHANNELS.event, encodeDesktopEvent({
      version: 1,
      event,
      payload,
    } satisfies DesktopEvent))
  }

  private closeSocket(connection: WindowConnection, code: number, reason: string): void {
    const socket = connection.socket
    connection.socket = null
    connection.connecting = null
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(code, reason)
    this.rejectPending(connection, reason)
  }

  private rejectPending(connection: WindowConnection, reason: string): void {
    for (const pending of connection.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error(reason))
    }
    connection.pending.clear()
  }
}

export interface DesktopControlAuthorization {
  cookieHeader(): string
  requireAuthorizationContext(): DesktopAuthorizationContext
  onAuthorizationChanged(listener: () => void): () => void
}

function failure(
  request: DesktopControlRequest,
  code: string,
  message: string,
): DesktopControlResponse {
  return { version: request.version, requestId: request.requestId, ok: false, error: { code, message } }
}

function projectControlResponseData(command: WsControlCommand, value: unknown): unknown {
  const validated = wsCommandContract(command).response.parse(value)
  if (command !== 'workspace:bootstrap') return validated
  const snapshot = workspaceBootstrapSnapshotSchema.parse(validated)
  const auth = desktopAuthProjectionSchema.parse({
    user: snapshot.auth.user,
    defaultWorkspace: snapshot.auth.defaultWorkspace,
    memberships: snapshot.auth.memberships,
    platformRoles: snapshot.auth.platformRoles,
    permissions: snapshot.auth.permissions,
    requestProtection: 'main_managed',
  })
  return desktopWorkspaceBootstrapSnapshotSchema.parse({
    ...snapshot,
    auth,
  })
}

function safeMessage(error: unknown): string {
  return error instanceof Error
    ? error.message.replace(/[\r\n]+/gu, ' ').slice(0, 500)
    : '实时控制操作失败。'
}
