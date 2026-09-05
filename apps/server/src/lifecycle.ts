// +-------------------------------------------------------------------------
//
//   地理智能平台 - 服务生命周期管理
//
//   文件:       lifecycle.ts
//
//   日期:       2026年07月02日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import type { Server } from 'node:http'
import type { WebSocketServer } from 'ws'
import type { Database } from './db/connection.js'
import type { ApplicationInstanceLock } from './db/applicationInstanceLock.js'
import { errorLogPayload, logger } from './observability/logger.js'

interface LifecycleOptions {
  server: Server
  wsServer: WebSocketServer
  store: { closeConversationStore(): Promise<void> }
  db: Database
  instanceLock: ApplicationInstanceLock
  onShutdownStart: () => void
  beforeDrain?: () => Promise<void>
  timeoutMs?: number
}

// 生命周期管理器是进程关闭的唯一协调点。
//
// 这里不尝试伪装多进程 runtime 写入安全；单进程在收到信号后只做有界排空，
// 超时则显式失败退出，避免半关闭状态继续接收新的 Agent 任务。
export function installLifecycleManager(options: LifecycleOptions): void {
  installStandaloneLifecycleManager({
    component: 'main-api',
    onShutdownStart: options.onShutdownStart,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    drain: () => drainApplicationLifecycle(options),
  })
}

interface StandaloneLifecycleOptions {
  component: string
  drain: () => Promise<void>
  onShutdownStart?: () => void
  timeoutMs?: number
}

/** 为静态服务等独立进程提供同一套有界关闭语义。 */
function installStandaloneLifecycleManager(options: StandaloneLifecycleOptions): void {
  let shuttingDown = false
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return
    shuttingDown = true
    options.onShutdownStart?.()
    const timeoutMs = options.timeoutMs ?? 10_000
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`服务关闭超时：${timeoutMs}ms`)), timeoutMs).unref()
    })

    try {
      await Promise.race([options.drain(), timeout])
      process.exit(0)
    } catch (error) {
      logger.error({ error: errorLogPayload(error), signal, component: options.component }, 'shutdown failed')
      process.exit(1)
    }
  }

  process.once('SIGINT', signal => { void shutdown(signal) })
  process.once('SIGTERM', signal => { void shutdown(signal) })
}

export async function drainApplicationLifecycle(options: LifecycleOptions): Promise<void> {
  // 先同步启动所有传输边界关闭，确保排空阶段不会再接收新任务。
  const httpClosed = new Promise<void>((resolve, reject) => {
    options.server.close(error => error ? reject(error) : resolve())
  })
  for (const socket of options.wsServer.clients) {
    socket.close(1001, 'server shutting down')
  }
  const wsClosed = new Promise<void>(resolve => options.wsServer.close(() => resolve()))
  await options.beforeDrain?.()
  await Promise.all([httpClosed, wsClosed])
  await options.store.closeConversationStore()
  await options.instanceLock.release()
  await options.db.close()
}
