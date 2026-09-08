// +-------------------------------------------------------------------------
//
//   地理智能平台 - WebSocket 控制面
//
//   文件:       handler.ts
//
//   日期:       2026年06月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import type { Server, IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import { StoreNotFoundError, StoreVersionConflictError } from '../store/storeErrors.js'
import { AuthorizationError } from '../security/authorizationService.js'
import { makeId } from '../utils/ids.js'
import {
  ClientMessageValidationError,
  failure,
  parseMessage,
  parseMessageEnvelope,
  push,
  success,
  type ClientMsg,
} from './protocol.js'
import { clearRunDeliveries, installWsDeliveryGuard, sendProtectedWs, sendWs } from './subscriptions.js'
import { createWsDeliveryAuthorizer, wsAuthNotExpired } from './deliveryAuthorization.js'
import type { SecurityServices } from '../security/routes.js'
import { WsMessageRateLimiter } from '../security/rateLimiter.js'
import type { AuthContext } from '../security/types.js'
import type { WsDependencies } from './dependencies.js'
import type { RegisteredWsCommand } from './commandRegistry.js'
import { createDefaultCommandRegistry } from './defaultCommandRegistry.js'
import { ControlMutationOverloadedError } from './ControlMutationScheduler.js'
import { formatError } from './payload.js'
import { errorLogPayload, logger, traceId, withLogContext } from '../observability/logger.js'
import { wsConnectionsActive, wsMessagesTotal } from '../observability/metrics.js'

export function createWsHandler(server: Server, dependencies: WsDependencies) {
  const runtime = dependencies.runtime
  const runTasks = dependencies.runTasks
  const files = dependencies.runtimeFiles
  const commandRegistry = createDefaultCommandRegistry()
  const wss = new WebSocketServer({ noServer: true })
  const wsRateLimiter = new WsMessageRateLimiter()

  server.on('upgrade', (request, socket, head) => {
    if (!isWsPath(request)) return
    const onSocketError = (error: Error) => {
      logger.warn({ error: errorLogPayload(error) }, 'ws upgrade socket failed')
      if (!socket.destroyed) socket.destroy()
    }
    socket.once('error', onSocketError)
    void handleWsUpgrade(request, socket, head, wss, dependencies)
      .catch(error => {
        logger.error({ error: errorLogPayload(error) }, 'ws upgrade failed')
        if (!socket.destroyed) rejectUpgrade(socket, 503, 'Service Unavailable')
      })
      .finally(() => socket.removeListener('error', onSocketError))
  })

  wss.on('error', error => {
    logger.error({ error: errorLogPayload(error) }, 'ws server transport failed')
  })

  wss.on('connection', (ws, _request, authContext?: AuthContext) => {
    const connectionId = makeId('ws_conn')
    const connectionAbort = new AbortController()
    const subscriptions = new Map<string, () => void>()
    const keepalive = setInterval(() => sendProtectedWs(ws, null, push('keepalive', {})), 30_000)
    let releaseDeliveryGuard = () => {}
    wsConnectionsActive.inc()
    logger.info({ wsConnectionId: connectionId, userId: authContext?.userId ?? null }, 'ws connected')

    let cleaned = false
    const cleanup = (reason: 'close' | 'error', error?: Error) => {
      if (cleaned) return
      cleaned = true
      clearInterval(keepalive)
      releaseDeliveryGuard()
      subscriptions.forEach(unsubscribe => unsubscribe())
      subscriptions.clear()
      clearRunDeliveries(ws)
      // 先由调度器整批移除排队写命令，再广播连接信号；否则多个共享同一
      // AbortSignal 的监听器逐个触发时，后续命令可能在清理中途被 drain 启动。
      commandRegistry.cancelConnection(connectionId)
      connectionAbort.abort(new Error('WebSocket 连接已断开。'))
      wsRateLimiter.releaseConnection(connectionId)
      wsConnectionsActive.dec()
      if (error) {
        logger.warn({
          error: errorLogPayload(error),
          wsConnectionId: connectionId,
          userId: authContext?.userId ?? null,
        }, 'ws connection transport failed')
      } else {
        logger.info({ wsConnectionId: connectionId, userId: authContext?.userId ?? null }, 'ws disconnected')
      }
      if (reason === 'error' && ws.readyState !== WebSocket.CLOSED) ws.terminate()
    }

    releaseDeliveryGuard = installWsDeliveryGuard(
      ws,
      createWsDeliveryAuthorizer(authContext, dependencies.security, dependencies.store),
      () => wsAuthNotExpired(authContext),
      () => {
        logger.info({
          event: 'security.ws.delivery.denied',
          category: 'security',
          retention: 'operational',
          wsConnectionId: connectionId,
          userId: authContext?.userId ?? null,
        }, '实时推送授权已失效，关闭连接并清理订阅。')
        cleanup('close')
      },
    )

    const handleData = async (data: RawData) => {
      for (const line of data.toString().split('\n').filter(Boolean)) {
        await withLogContext({
          traceId: traceId(),
          wsConnectionId: connectionId,
          userId: authContext?.userId ?? null,
        }, async () => {
          if (!dependencies.admission.isAccepting()) {
            try {
              const envelope = parseMessageEnvelope(line)
              wsMessagesTotal.inc({ type: envelope.type, direction: 'inbound' })
              sendWs(ws, failure(
                envelope.id,
                'service_unavailable',
                '服务正在关闭，已停止接收新命令。请稍后重试。',
              ))
              wsMessagesTotal.inc({ type: envelope.type, direction: 'outbound' })
            } catch (error) {
              sendWs(ws, failure(null, 'invalid_request', formatError(error)))
              wsMessagesTotal.inc({ type: 'invalid', direction: 'outbound' })
            }
            return
          }
          let msg: ClientMsg
          try {
            msg = parseMessage(line)
          } catch (error) {
            logger.warn({ error: errorLogPayload(error) }, 'ws invalid message')
            wsMessagesTotal.inc({ type: 'invalid', direction: 'inbound' })
            sendWs(ws, failure(
              error instanceof ClientMessageValidationError ? error.requestId : null,
              'invalid_request',
              formatError(error),
            ))
            wsMessagesTotal.inc({ type: 'invalid', direction: 'outbound' })
            return
          }
          await withLogContext({ wsCommand: msg.type, wsRequestId: msg.id }, async () => {
            wsMessagesTotal.inc({ type: msg.type, direction: 'inbound' })
            if (!wsRateLimiter.consume(connectionId, msg.type)) {
              logger.warn({ command: msg.type }, 'ws rate limited')
              sendWs(ws, failure(msg.id, 'command_failed', '请求过于频繁，请稍后重试。'))
              wsMessagesTotal.inc({ type: msg.type, direction: 'outbound' })
              return
            }
            let responseDelivery: ((message: string) => void) | null = null
            const deliverResponse = (message: string) => {
              if (responseDelivery) responseDelivery(message)
              else sendWs(ws, message)
            }
            try {
              const registeredCommand = commandRegistry.get(msg.type)
              if (!registeredCommand) throw new Error(`WS 命令 '${msg.type}' 尚未注册。`)
              assertRegisteredCommandCsrf(msg, authContext, registeredCommand)
              const result = await commandRegistry.execute(msg, {
                dependencies,
                runtime,
                runTasks,
                files,
                ws,
                subscriptions,
                auth: authContext ?? null,
                connectionId,
                connectionSignal: connectionAbort.signal,
                setResponseDelivery: deliver => {
                  if (responseDelivery) throw new Error('WS 响应交付器不能重复注册。')
                  responseDelivery = deliver
                },
              })
              deliverResponse(success(msg.id, result))
              wsMessagesTotal.inc({ type: msg.type, direction: 'outbound' })
            } catch (error) {
              const code = error instanceof StoreNotFoundError ? 'not_found'
                : error instanceof AuthorizationError ? 'forbidden'
                : error instanceof ControlMutationOverloadedError ? 'overloaded'
                : error instanceof StoreVersionConflictError ? 'version_conflict'
                : 'command_failed'
              const failureContext = {
                error: errorLogPayload(error),
                failureCode: code,
                wsCommand: msg.type,
                wsRequestId: msg.id,
              }
              if (error instanceof AuthorizationError) {
                logger.info({
                  ...failureContext,
                  event: 'security.authorization.denied',
                  category: 'security',
                  retention: 'operational',
                }, 'WebSocket 命令被权限策略拒绝。')
              } else {
                logger.warn({
                  ...failureContext,
                  event: 'request.ws.failed',
                  category: 'request',
                  retention: 'operational',
                }, 'WebSocket 命令执行失败。')
              }
              deliverResponse(failure(msg.id, code, formatError(error)))
              wsMessagesTotal.inc({ type: msg.type, direction: 'outbound' })
            }
          })
        })
      }
    }

    ws.on('message', data => {
      void handleData(data).catch(error => {
        logger.error({
          error: errorLogPayload(error),
          wsConnectionId: connectionId,
          userId: authContext?.userId ?? null,
        }, 'ws message boundary failed')
        sendWs(ws, failure(null, 'internal_error', 'WebSocket 消息处理失败。'))
      })
    })

    ws.once('error', error => {
      cleanup('error', error)
    })
    ws.once('close', () => cleanup('close'))
  })

  return wss
}

async function handleWsUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  wss: WebSocketServer,
  dependencies: WsDependencies,
): Promise<void> {
  if (!dependencies.admission.isAccepting()) {
    rejectUpgrade(socket, 503, 'Service Unavailable')
    return
  }
  const auth = await authenticateWsRequest(request, socket, dependencies.security)
  if (!auth || socket.destroyed) return
  wss.handleUpgrade(request, socket, head, ws => {
    wss.emit('connection', ws, request, auth)
  })
}

function assertRegisteredCommandCsrf(
  msg: ClientMsg,
  auth: AuthContext | undefined,
  command: RegisteredWsCommand,
): void {
  if (!command.csrf || !auth) return
  if (msg.meta?.csrfToken !== auth.csrfToken) throw new Error('CSRF 校验失败。')
}

function isWsPath(request: IncomingMessage): boolean {
  const rawPath = (request.url ?? '').split('?', 1)[0]
  return rawPath === '/ws'
}

async function authenticateWsRequest(
  request: IncomingMessage,
  socket: Duplex,
  security: SecurityServices,
): Promise<AuthContext | null> {
  const origin = request.headers.origin
  if (!security.auth.isTrustedOrigin(origin)) {
    rejectUpgrade(socket, 403, 'Forbidden origin')
    return null
  }
  const headers = toHeaders(request)
  const auth = await security.auth.authenticateHeaders(headers)
    ?? (isLoopbackAddress(request.socket.remoteAddress)
      ? await security.auth.authenticateLocalAgentHeaders(headers)
      : null)
  if (!auth) {
    rejectUpgrade(socket, 401, 'Unauthorized')
    return null
  }
  return auth
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false
  const normalized = address.trim().toLowerCase()
  if (normalized === '::1') return true
  const ipv4 = normalized.startsWith('::ffff:') ? normalized.slice('::ffff:'.length) : normalized
  return /^127(?:\.\d{1,3}){3}$/u.test(ipv4)
}

function toHeaders(request: IncomingMessage): Headers {
  const headers = new Headers()
  for (const [key, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item)
    } else if (typeof value === 'string') {
      headers.set(key, value)
    }
  }
  return headers
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  socket.destroy()
}
