// +-------------------------------------------------------------------------
//
//   地理智能平台 - Electron 主进程系统日志
//
//   文件:       desktopSystemLogger.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { app } from 'electron'
import log from 'electron-log/main'
import { readdir, readFile, stat, unlink } from 'node:fs/promises'
import path from 'node:path'

import {
  createActualUtcRotationNameGenerator,
  RetryingRotatingFileSink,
} from '@geo-agent-platform/operations-supervisor/rotating-log-sink'
import { OperationsLogBuffer } from '@geo-agent-platform/operations-supervisor/log-buffer'
import type {
  OperationsLogEntry,
  OperationsLogPage,
  OperationsLogQuery,
  OperationsSnapshot,
} from '@geo-agent-platform/shared-types/operations'
import { createStream } from 'rotating-file-stream'

import { sanitizeDesktopLogValue } from './desktopLogSanitizer.js'
import {
  desktopFileLogRecord,
  parseDesktopFileLogRecord,
  projectDesktopLogLines,
  serializeDesktopFileLogRecord,
} from './desktopLogRecords.js'

const DESKTOP_LOG_TOTAL_BYTES = 32 * 1024 * 1024
const DESKTOP_LOG_RETENTION_MS = 14 * 24 * 60 * 60_000

export interface DesktopSystemLogger {
  readonly filePath: string
  debug(event: string, details?: Record<string, unknown>): void
  info(event: string, details?: Record<string, unknown>): void
  warn(event: string, details?: Record<string, unknown>): void
  error(event: string, error?: unknown, details?: Record<string, unknown>): void
  read(query: OperationsLogQuery): Promise<OperationsLogPage>
  readHistory(query: OperationsLogQuery): Promise<OperationsLogPage>
  onLog(listener: (entry: OperationsLogEntry) => void): () => void
  persistenceState(): OperationsSnapshot['observability']['persistence']
  close(): void
}

/**
 * Electron 崩溃捕获继续由 electron-log 提供；实时查询只读有界内存，历史文件
 * 仅在用户明确请求时异步读取，避免 Renderer 定时触发同步磁盘扫描。
 */
export function createDesktopSystemLogger(): DesktopSystemLogger {
  const filePath = path.join(app.getPath('logs'), 'desktop-main.log')
  const buffer = new OperationsLogBuffer(10_000, 8 * 1024 * 1024, {
    diagnosticMaxBytes: 8 * 1024 * 1024,
    sequenceOffset: 1_000_000_000,
  })
  const listeners = new Set<(entry: OperationsLogEntry) => void>()
  let persistence: OperationsSnapshot['observability']['persistence'] = {
    state: 'healthy',
    message: '桌面日志持久化已初始化。',
    lastSuccessAt: null,
    lastErrorAt: null,
  }

  const emit = (entry: OperationsLogEntry): void => {
    for (const listener of listeners) listener(entry)
  }
  const markFailure = (error: unknown, retrying: boolean): void => {
    const message = error instanceof Error ? error.message : '未知文件写入错误。'
    persistence = {
      state: retrying ? 'retrying' : 'degraded',
      message: `桌面日志持久化异常：${String(sanitizeDesktopLogValue(message)).slice(0, 300)}`,
      lastSuccessAt: persistence.lastSuccessAt,
      lastErrorAt: new Date().toISOString(),
    }
    emit(buffer.append({
      serviceId: null,
      component: 'desktop',
      processId: process.pid,
      stream: 'supervisor',
      level: 'error',
      message: persistence.message,
      attributes: {
        event: 'storage.desktop_log.failed',
        category: 'storage',
        retention: 'diagnostic',
      },
    }))
  }
  const markHealthy = (): void => {
    persistence = {
      state: 'healthy',
      message: '桌面日志文件可写。',
      lastSuccessAt: new Date().toISOString(),
      lastErrorAt: persistence.lastErrorAt,
    }
  }

  const activeName = path.basename(filePath)
  const rotationName = createActualUtcRotationNameGenerator(activeName, 'desktop-main', '.log')
  const fileSink = new RetryingRotatingFileSink(
    () => {
      const rotating = createStream(rotationName, {
        path: path.dirname(filePath),
        size: '4M',
        interval: '1d',
        intervalBoundary: true,
        intervalUTC: true,
        initialRotation: true,
        history: 'desktop-main.history',
        maxFiles: 16,
        maxSize: '28M',
        compress: false,
      })
      rotating.on('rotated', () => {
        markHealthy()
        void pruneDesktopLogs(path.dirname(filePath), filePath).catch(error => markFailure(error, true))
      })
      return rotating
    },
    () => markHealthy(),
    (error, retrying) => markFailure(error, retrying),
  )
  const persist = (entry: OperationsLogEntry): void => {
    if (entry.retention === 'diagnostic') return
    fileSink.write(`${serializeDesktopFileLogRecord(desktopFileLogRecord(entry))}\n`, 'utf8')
  }

  // electron-log 继续捕获 Electron 生命周期和崩溃；统一轮转流是唯一文件写入者。
  log.transports.file.level = false
  log.transports.console.format = '[{h}:{i}:{s}.{ms}] [{level}] {scope} {text}'
  log.hooks.push(message => ({
    ...message,
    data: message.data.map(value => sanitizeDesktopLogValue(value)),
  }))
  log.hooks.push(message => {
    if (parseDesktopFileLogRecord(message.data[0])) return message
    const level = normalizeElectronLogLevel(message.level)
    const error = message.data.find(value => (
      typeof value === 'object' && value !== null && ('stack' in value || 'message' in value)
    ))
    const entry = buffer.append({
      serviceId: null,
      component: message.scope || 'electron',
      processId: process.pid,
      stream: 'supervisor',
      level,
      message: 'Electron 捕获主进程事件。',
      attributes: {
        event: 'lifecycle.electron.captured',
        category: 'lifecycle',
        retention: level === 'debug' ? 'diagnostic' : 'operational',
        ...(error ? { error } : {}),
      },
      createdAt: message.date,
    })
    emit(entry)
    persist(entry)
    return { ...message, data: [desktopFileLogRecord(entry)] }
  })
  log.initialize({ preload: false, spyRendererConsole: false })
  log.errorHandler.startCatching({ showDialog: false })
  log.eventLogger.startLogging({ level: 'error', scope: 'electron' })
  const scoped = log.scope('desktop')
  void pruneDesktopLogs(path.dirname(filePath), filePath).catch(error => markFailure(error, true))

  const write = (
    level: OperationsLogEntry['level'],
    event: string,
    details: Record<string, unknown> = {},
    error?: unknown,
  ): void => {
    const entry = buffer.append({
      serviceId: null,
      component: 'desktop',
      processId: process.pid,
      stream: 'supervisor',
      level,
      message: desktopEventMessage(event),
      attributes: {
        ...details,
        event: normalizeEventName(event),
        category: desktopEventCategory(event),
        retention: level === 'debug' ? 'diagnostic' : 'operational',
        ...(error === undefined ? {} : { error }),
      },
    })
    emit(entry)
    persist(entry)
    if (entry.retention === 'diagnostic') return
    const record = desktopFileLogRecord(entry)
    if (level === 'error') scoped.error(record)
    else if (level === 'warn') scoped.warn(record)
    else scoped.info(record)
  }

  return {
    filePath,
    debug: (event, details) => write('debug', event, details),
    info: (event, details) => write('info', event, details),
    warn: (event, details) => write('warn', event, details),
    error: (event, error, details) => write('error', event, details, error),
    read: async query => buffer.page(query),
    readHistory: async query => readDesktopHistory(path.dirname(filePath), query),
    onLog: listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    persistenceState: () => ({ ...persistence }),
    close: () => {
      listeners.clear()
      log.eventLogger.stopLogging()
      log.errorHandler.stopCatching()
      fileSink.end()
    },
  }
}

async function readDesktopHistory(directory: string, query: OperationsLogQuery): Promise<OperationsLogPage> {
  const names = (await readdir(directory))
    .filter(name => name === 'desktop-main.log' || /^desktop-main\..+\.log$/u.test(name))
  const files = (await Promise.all(names.map(async name => {
    const filePath = path.join(directory, name)
    const details = await stat(filePath)
    return { filePath, modifiedAt: details.mtimeMs }
  }))).sort((left, right) => left.modifiedAt - right.modifiedAt)
  const lines = (await Promise.all(files.map(async file => (await readFile(file.filePath, 'utf8')).split(/\r?\n/gu))))
    .flat()
    .filter(Boolean)
  const entries = projectDesktopLogLines(lines, query)
  return {
    entries,
    nextCursor: entries.at(-1)?.sequence ?? query.afterSequence,
    hasMore: entries.length === query.tail,
  }
}

async function pruneDesktopLogs(directory: string, activeFile: string): Promise<void> {
  const names = (await readdir(directory))
    .filter(name => /^desktop-main\..+\.log$/u.test(name))
  const files = (await Promise.all(names.map(async name => {
    const filePath = path.join(directory, name)
    const details = await stat(filePath)
    return { filePath, modifiedAt: details.mtimeMs, size: details.size }
  }))).sort((left, right) => left.modifiedAt - right.modifiedAt)
  const cutoff = Date.now() - DESKTOP_LOG_RETENTION_MS
  let total = (await stat(activeFile).catch(() => null))?.size ?? 0
  for (const file of files) {
    if (file.modifiedAt < cutoff) {
      await unlink(file.filePath)
      continue
    }
    total += file.size
  }
  for (const file of files) {
    if (file.modifiedAt < cutoff || total <= DESKTOP_LOG_TOTAL_BYTES) continue
    await unlink(file.filePath)
    total -= file.size
  }
}

function normalizeEventName(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/gu, '_')
  return /^[a-z]/u.test(normalized) ? normalized.slice(0, 120) : `desktop.${normalized || 'event'}`
}

function desktopEventMessage(event: string): string {
  return ({
    desktop_starting: '桌面主进程正在启动。',
    desktop_ready: '桌面主进程已就绪。',
    desktop_stopping: '桌面主进程正在停止。',
    desktop_startup_failed: '桌面主进程启动失败。',
    desktop_identity_close_failed: '桌面身份代理关闭失败。',
    renderer_diagnostic: 'Renderer 报告诊断事件。',
  } as Record<string, string>)[event] ?? '桌面主进程事件。'
}

function desktopEventCategory(event: string): OperationsLogEntry['category'] {
  if (event.startsWith('desktop_')) return 'lifecycle'
  if (event.startsWith('renderer_')) return 'ui'
  if (event.includes('auth') || event.includes('identity')) return 'security'
  return 'system'
}

function normalizeElectronLogLevel(level: string): OperationsLogEntry['level'] {
  if (level === 'error') return 'error'
  if (level === 'warn') return 'warn'
  if (level === 'info') return 'info'
  return 'debug'
}
