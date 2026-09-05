// +-------------------------------------------------------------------------
//
//   地理智能平台 - Supervisor 结构化轮转日志
//
//   文件:       systemLogger.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { readFile, readdir, rename, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { Writable } from 'node:stream'
import { finished } from 'node:stream/promises'

import type {
  OperationsLogPage,
  OperationsLogQuery,
  OperationsSnapshot,
} from '@geo-agent-platform/shared-types/operations'
import pino, { type Logger } from 'pino'
import { createStream } from 'rotating-file-stream'

import type { OperationsPaths } from './paths.js'
import { OperationsLogBuffer } from './logBuffer.js'
import {
  createActualUtcRotationNameGenerator,
  RetryingRotatingFileSink,
  rotatedLogFileName,
} from './rotatingLogSink.js'

export {
  createActualUtcRotationNameGenerator,
  RetryingRotatingFileSink,
  rotatedLogFileName,
} from './rotatingLogSink.js'

const TOTAL_LOG_BYTES = 224 * 1024 * 1024
const RETENTION_MS = 14 * 24 * 60 * 60_000

export interface SupervisorLogger {
  logger: Logger
  persistenceState(): OperationsSnapshot['observability']['persistence']
  readHistory(query: OperationsLogQuery): Promise<OperationsLogPage>
  close(): Promise<void>
}

/**
 * 运行日志按大小和 UTC 日界轮转。诊断事件不会调用这个 transport，因此
 * 开启详细诊断只扩大内存飞行记录器，不会增加硬盘写入。
 */
export function createSupervisorLogger(
  paths: OperationsPaths,
  level = process.env.LOG_LEVEL ?? 'info',
  options: {
    includeStdout?: boolean
    now?: () => Date
  } = {},
): SupervisorLogger {
  const activeName = path.basename(paths.systemLogFile)
  const prefix = activeName.replace(/\.jsonl$/u, '')
  const now = options.now ?? (() => new Date())
  const rotationName = createActualUtcRotationNameGenerator(activeName, prefix, '.jsonl', now)
  let persistence: OperationsSnapshot['observability']['persistence'] = {
    state: 'healthy',
    message: '日志持久化已初始化。',
    lastSuccessAt: null,
    lastErrorAt: null,
  }
  const markHealthy = (message: string): void => {
    persistence = {
      state: 'healthy',
      message,
      lastSuccessAt: new Date().toISOString(),
      lastErrorAt: persistence.lastErrorAt,
    }
  }
  const markFailure = (error: Error, retrying: boolean): void => {
    persistence = {
      state: retrying ? 'retrying' : 'degraded',
      message: `日志持久化异常：${safeMessage(error)}`,
      lastSuccessAt: persistence.lastSuccessAt,
      lastErrorAt: new Date().toISOString(),
    }
  }

  let pruneQueue = Promise.resolve()
  const schedulePrune = (): Promise<void> => {
    pruneQueue = pruneQueue
      .then(() => pruneKnownLogFiles(paths.operationsRoot, prefix, paths.systemLogFile))
      .catch(error => {
        markFailure(toError(error), true)
      })
    return pruneQueue
  }
  const initialPrune = schedulePrune()
  const createPersistentSink = (): RetryingRotatingFileSink => new RetryingRotatingFileSink(
    () => {
      const rotating = createStream(rotationName, {
        path: paths.operationsRoot,
        size: '8M',
        compress: false,
      })
      rotating.on('rotated', () => {
        markHealthy('日志轮转完成。')
        void schedulePrune()
      })
      return rotating
    },
    message => markHealthy(message),
    (error, retrying) => markFailure(error, retrying),
  )
  const stream = new UtcDailyRotatingSink({
    activeFile: paths.systemLogFile,
    prefix,
    now,
    ready: initialPrune,
    createSink: createPersistentSink,
    onRotated: () => {
      markHealthy('日志 UTC 日界轮转完成。')
      void schedulePrune()
    },
    onFailure: error => {
      markFailure(error, true)
    },
  })

  const destinations: Array<{ level: string; stream: NodeJS.WritableStream }> = [
    { level: persistentLogLevel(level), stream },
  ]
  if (options.includeStdout !== false) destinations.unshift({ level, stream: process.stdout })
  const logger = pino({
    level,
    base: {
      component: 'supervisor',
      supervisorPid: process.pid,
      workspaceId: paths.workspaceId,
    },
    redact: {
      paths: [
        '*.authorization',
        '*.cookie',
        '*.password',
        '*.secret',
        '*.token',
        'authorization',
        'cookie',
        'password',
        'secret',
        'token',
      ],
      censor: '[REDACTED]',
    },
    formatters: {
      log: value => sanitizePersistentRecord(value),
    },
  }, pino.multistream(destinations))

  return {
    logger,
    persistenceState: () => ({ ...persistence }),
    readHistory: query => readHistoricalLogPage(paths, prefix, query),
    close: async () => {
      stream.end()
      await finished(stream)
      await pruneQueue
    },
  }
}

interface UtcDailyRotatingSinkOptions {
  activeFile: string
  prefix: string
  now: () => Date
  ready: Promise<void>
  createSink: () => RetryingRotatingFileSink
  onRotated: () => void
  onFailure: (error: Error) => void
}

/**
 * `rotating-file-stream` 负责成熟的大小轮转；UTC 日界由这一层显式拥有。
 * 上游 3.2.9 会在非 UTC 系统时区把 UTC 字段作为本地时间构造日界，造成
 * 到点后持续即时轮转。这里按文件最后写入日判断，并在下一次写入前完成
 * 关闭、重命名和重开，避免修改进程全局时区或用定时等待掩盖竞态。
 */
class UtcDailyRotatingSink extends Writable {
  private activeDay: string | null = null
  private sink: RetryingRotatingFileSink | null = null
  private closing = false

  constructor(private readonly options: UtcDailyRotatingSinkOptions) {
    super()
  }

  override _write(
    chunk: Buffer,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    void this.writeChunk(chunk, encoding).then(() => callback(), callback)
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.closing = true
    void this.closeSink().then(() => callback(), callback)
  }

  private async writeChunk(chunk: Buffer, encoding: BufferEncoding): Promise<void> {
    const sink = await this.ensureCurrentDaySink()
    await new Promise<void>((resolve, reject) => {
      sink.write(chunk, encoding, error => error ? reject(error) : resolve())
    })
  }

  private async ensureCurrentDaySink(): Promise<RetryingRotatingFileSink> {
    if (this.closing) throw new Error('日志写入流已关闭。')
    const currentDay = utcDayKey(this.options.now())
    if (!this.sink) {
      await this.options.ready
      const persistedDay = await activeFileUtcDay(this.options.activeFile)
      if (persistedDay && persistedDay !== currentDay) await this.rotateActiveFile()
      this.sink = this.options.createSink()
      this.activeDay = currentDay
      return this.sink
    }
    if (this.activeDay === currentDay) return this.sink

    await this.closeSink()
    await this.rotateActiveFile()
    this.sink = this.options.createSink()
    this.activeDay = currentDay
    return this.sink
  }

  private async closeSink(): Promise<void> {
    const sink = this.sink
    this.sink = null
    if (!sink) return
    sink.end()
    await finished(sink)
  }

  private async rotateActiveFile(): Promise<void> {
    try {
      const rotated = await rotateActiveLogFile(
        this.options.activeFile,
        this.options.prefix,
        this.options.now(),
      )
      if (rotated) this.options.onRotated()
    } catch (error) {
      const normalized = toError(error)
      this.options.onFailure(normalized)
      throw normalized
    }
  }
}

function utcDayKey(time: Date): string {
  return time.toISOString().slice(0, 10)
}

async function activeFileUtcDay(filePath: string): Promise<string | null> {
  try {
    return utcDayKey((await stat(filePath)).mtime)
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

async function rotateActiveLogFile(
  activeFile: string,
  prefix: string,
  rotationTime: Date,
): Promise<string | null> {
  let details
  try {
    details = await stat(activeFile)
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
  if (details.size === 0) return null

  for (let index = 1; index < 1_000; index += 1) {
    const destination = path.join(
      path.dirname(activeFile),
      rotatedLogFileName(prefix, rotationTime, index),
    )
    try {
      await stat(destination)
    } catch (error) {
      if (!isMissing(error)) throw error
      try {
        await rename(activeFile, destination)
        return destination
      } catch (renameError) {
        if (isDestinationOccupied(renameError)) continue
        throw renameError
      }
      continue
    }
  }
  throw new Error('日志轮转目标文件数量超过上限。')
}

async function readHistoricalLogPage(
  paths: OperationsPaths,
  prefix: string,
  query: OperationsLogQuery,
): Promise<OperationsLogPage> {
  const names = (await readdir(paths.operationsRoot))
    .filter(name => name === path.basename(paths.systemLogFile)
      || (name.startsWith(`${prefix}.`) && name.endsWith('.jsonl')))
  const files = (await Promise.all(names.map(async name => {
    const filePath = path.join(paths.operationsRoot, name)
    const details = await stat(filePath)
    return { filePath, modifiedAt: details.mtimeMs, size: details.size }
  }))).sort((left, right) => right.modifiedAt - left.modifiedAt)
  const selected: typeof files = []
  let selectedBytes = 0
  for (const file of files) {
    if (selectedBytes + file.size > 32 * 1024 * 1024 && selected.length > 0) break
    selected.push(file)
    selectedBytes += file.size
  }
  const buffer = new OperationsLogBuffer(10_001, 32 * 1024 * 1024, {
    normalRetentionMs: Number.MAX_SAFE_INTEGER,
    sequenceOffset: 2_000_000_000,
  })
  for (const file of selected.reverse()) {
    const content = await readFile(file.filePath, 'utf8')
    for (const line of content.split(/\r?\n/gu)) {
      if (line) buffer.append({ serviceId: null, stream: 'supervisor', message: line })
    }
  }
  const page = buffer.page(query)
  return { ...page, hasMore: page.hasMore || selected.length < files.length }
}

async function pruneKnownLogFiles(
  directory: string,
  prefix: string,
  activeFile: string,
): Promise<void> {
  const names = await readdir(directory)
  const candidates = (await Promise.all(names
    .filter(name => (
      (name.startsWith(`${prefix}.`) && name.endsWith('.jsonl'))
      || /^supervisor-launch\.(?:stdout|stderr)\..+\.log$/u.test(name)
    ))
    .map(async name => {
      const filePath = path.join(directory, name)
      const details = await stat(filePath)
      return { filePath, modifiedAt: details.mtimeMs, size: details.size }
    })))
    .filter(candidate => path.resolve(candidate.filePath) !== path.resolve(activeFile))
    .sort((left, right) => left.modifiedAt - right.modifiedAt)

  const cutoff = Date.now() - RETENTION_MS
  let total = (await stat(activeFile).catch(() => null))?.size ?? 0
  for (const candidate of candidates) {
    if (candidate.modifiedAt < cutoff) {
      await unlink(candidate.filePath)
      continue
    }
    total += candidate.size
  }
  for (const candidate of candidates) {
    if (candidate.modifiedAt < cutoff || total <= TOTAL_LOG_BYTES) continue
    await unlink(candidate.filePath).catch(error => {
      if (!isMissing(error)) throw error
    })
    total -= candidate.size
  }
}

function safeMessage(error: Error): string {
  return sanitizePersistentText(error.message, 300)
}

function persistentLogLevel(level: string): string {
  if (level === 'silent' || level === 'fatal' || level === 'error' || level === 'warn') return level
  return 'info'
}

function sanitizePersistentRecord(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return sanitizePersistentValue(value, new WeakSet<object>(), 0) as Record<string, unknown>
}

function sanitizePersistentValue(
  value: unknown,
  ancestors: WeakSet<object>,
  depth: number,
): unknown {
  if (typeof value === 'string') return sanitizePersistentText(value, 2_000)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (value instanceof Error) {
    const code = 'code' in value && typeof value.code === 'string' ? value.code : undefined
    return {
      name: value.name,
      message: sanitizePersistentText(value.message, 2_000),
      ...(code ? { code } : {}),
      ...(value.stack ? { stack: sanitizePersistentText(value.stack, 8_000) } : {}),
    }
  }
  if (typeof value !== 'object' || depth >= 5) return '[TRUNCATED]'
  if (ancestors.has(value)) return '[CIRCULAR]'
  ancestors.add(value)
  const result = Array.isArray(value)
    ? value.slice(0, 20).map(item => sanitizePersistentValue(item, ancestors, depth + 1))
    : Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, item]) => [
      key,
      isSensitiveLogField(key)
        ? '[REDACTED]'
        : sanitizePersistentValue(item, ancestors, depth + 1),
    ]))
  ancestors.delete(value)
  return result
}

function sanitizePersistentText(value: string, maxLength: number): string {
  return value
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu, '$1 [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/gu, '[REDACTED]')
    .replace(
      /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|cookie|authorization)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/giu,
      '$1[REDACTED]',
    )
    .replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/@\s]+)@/gu, '$1[REDACTED]@')
    .replace(/(^|[^A-Za-z])[A-Za-z]:[\\/][^\s'"<>),]+/gu, '$1[LOCAL_PATH]')
    .replace(/(^|[\s("'=])\/(?:Users|home|var|tmp|opt|mnt|srv|workspace|app)\/[^\s'"<>),]+/gu, '$1[LOCAL_PATH]')
    .slice(0, maxLength)
}

function isSensitiveLogField(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/giu, '').toLowerCase()
  return SENSITIVE_LOG_FIELDS.has(normalized)
    || normalized.endsWith('prompt')
    || normalized.endsWith('requestbody')
    || normalized.endsWith('responsebody')
    || normalized.endsWith('toolarguments')
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error('未知文件写入错误。')
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function isDestinationOccupied(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}

const SENSITIVE_LOG_FIELDS = new Set([
  'authorization',
  'cookie',
  'setcookie',
  'password',
  'secret',
  'token',
  'apikey',
  'accesstoken',
  'refreshtoken',
  'csrftoken',
  'prompt',
  'messages',
  'input',
  'output',
  'body',
  'arguments',
  'params',
  'parameters',
  'headers',
])
