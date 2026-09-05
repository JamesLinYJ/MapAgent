// +-------------------------------------------------------------------------
//
//   地理智能平台 - 结构化日志
//
//   文件:       logger.ts
//
//   日期:       2026年07月07日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import pino from 'pino'

// 日志严重度——模仿 Windows Event Log 的分级。
// trace:  最高细节（只含有界元数据，不含业务正文）
// debug:  诊断级（请求分类与中间状态，不含提示词、模型正文或完整工具参数）
// info:   正常事件（启动、注册与状态变化；成功健康探测不记录）
// warn:   可恢复异常（重试、降级、超时）
// error:  操作失败（工具错误、Worker 失败、校验失败——仅记录分类与关联 ID）
// fatal:  进程级致命（无法启动、数据库断连——仅记录有界进程状态）
const isTestRuntime = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true'
const defaultLevel = isTestRuntime ? 'silent' : process.env.NODE_ENV === 'production' ? 'info' : 'debug'
const LEVEL = process.env.LOG_LEVEL || defaultLevel
const logContextStore = new AsyncLocalStorage<LogContext>()

export const logger = pino({
  level: LEVEL,
  base: { service: 'geo-agent-platform-api' },
  timestamp: pino.stdTimeFunctions.isoTime,
  messageKey: 'message',
  redact: {
    paths: [
      'authorization',
      'authorizationToken',
      'cookie',
      'csrfToken',
      'headers.authorization',
      'headers.cookie',
      'headers.set-cookie',
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers.set-cookie',
      'request.headers.authorization',
      'request.headers.cookie',
      'request.headers.set-cookie',
      'sessionToken',
      '*.apiKey',
      '*.authorization',
      '*.authorizationToken',
      '*.cookie',
      '*.csrfToken',
      '*.password',
      '*.passwordHash',
      '*.secret',
      '*.sessionToken',
      '*.token',
    ],
    censor: '[REDACTED]',
  },
  // 错误序列化：自动包含 stack
  serializers: {
    error: pino.stdSerializers.err,
    err: pino.stdSerializers.err,
  },
  formatters: {
    log(object) {
      return sanitizeLogValue(object) as Record<string, unknown>
    },
  },
  hooks: {
    logMethod(args, method) {
      const context = currentLogContext()
      if (!context || Object.keys(context).length === 0) {
        return method.apply(this, args)
      }
      if (args.length > 0 && isPlainRecord(args[0])) {
        const [first, ...rest] = args
        return method.apply(this, [{ ...context, ...first }, ...rest] as Parameters<typeof method>)
      }
      return method.apply(this, [context, ...args] as Parameters<typeof method>)
    },
  },
})

// traceId —— 12 位短标识，贯穿全链路
export function traceId(): string {
  return randomUUID().slice(0, 12)
}

export function withLogContext<T>(context: LogContext, fn: () => T): T {
  return logContextStore.run({ ...currentLogContext(), ...context }, fn)
}

/** 将请求失败分类附着到当前请求摘要，不再额外写一条重复错误日志。 */
export function annotateHttpRequestFailure(error: unknown): void {
  const context = logContextStore.getStore()
  if (!context) return
  const failure = errorLogPayload(error)
  context.errorType = failure.name ?? 'Error'
  if (failure.code) context.errorCode = failure.code
  if (failure.status !== undefined) context.errorStatus = failure.status
}

export function currentLogContext(): LogContext {
  return logContextStore.getStore() ?? {}
}

export function logHttpRequestSummary(ctx: LogContext & {
  method: string
  route: string
  statusCode: number
  durationMs: number
}): void {
  if ((ctx.route === '/health' || ctx.route === '/health/live' || ctx.route === '/metrics') && ctx.statusCode < 500) {
    return
  }
  const level = ctx.statusCode >= 500
    ? 'error'
    : ctx.statusCode === 429
      ? 'warn'
      : ctx.durationMs >= 2_000
        ? 'info'
        : 'debug'
  const retention = level === 'debug' ? 'diagnostic' : 'operational'
  logger[level]({
    ...ctx,
    _summary: true,
    event: 'request.http.completed',
    category: 'request',
    retention,
    httpMethod: ctx.method,
    httpPath: ctx.route,
  }, 'HTTP 请求已完成。')
}

export function sanitizeLogValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[MaxDepth]'
  if (typeof value === 'string') return sanitizeString(value)
  if (typeof value === 'bigint') return value.toString()
  if (value === null || value === undefined) return value
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) {
    return value.slice(0, 100).map(item => sanitizeLogValue(item, depth + 1))
  }
  if (value instanceof Error) return errorLogPayload(value)
  if (isPlainRecord(value)) {
    const output: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      output[key] = shouldRedactKey(key) ? '[REDACTED]' : sanitizeLogValue(entry, depth + 1)
    }
    return output
  }
  return value
}

// errorLogPayload —— 结构化错误，用在 logger.error({ error: errorLogPayload(err) }, ...)
export function errorLogPayload(error: unknown): { message: string; stack?: string; name?: string; code?: string; status?: number } {
  if (error instanceof Error) {
    const record = error as Error & { code?: unknown; status?: unknown; statusCode?: unknown }
    const status = typeof record.status === 'number'
      ? record.status
      : typeof record.statusCode === 'number'
        ? record.statusCode
        : undefined
    return {
      message: sanitizeString(error.message),
      name: error.name,
      ...(error.stack ? { stack: sanitizeString(error.stack) } : {}),
      ...(typeof record.code === 'string' ? { code: sanitizeString(record.code) } : {}),
      ...(status !== undefined ? { status } : {}),
    }
  }
  return { message: sanitizeString(String(error)) }
}

// === 分级日志辅助函数 ===

interface LogContext {
  traceId?: string
  runId?: string
  threadId?: string
  toolName?: string
  [key: string]: unknown
}

function shouldRedactKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/giu, '').toLowerCase()
  return (
    normalized.includes('authorization') ||
    normalized.includes('cookie') ||
    normalized.includes('csrf') ||
    normalized.includes('password') ||
    normalized.includes('secret') ||
    normalized.includes('sessiontoken') ||
    normalized === 'token' ||
    normalized.endsWith('token') ||
    normalized.endsWith('apikey') ||
    normalized === 'apikey' ||
    SENSITIVE_CONTENT_FIELDS.has(normalized) ||
    normalized.endsWith('prompt') ||
    normalized.endsWith('requestbody') ||
    normalized.endsWith('responsebody') ||
    normalized.endsWith('toolarguments')
  )
}

function sanitizeString(value: string): string {
  return value
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu, '$1 [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/gu, '[REDACTED]')
    .replace(/([?&](?:api[_-]?key|key|token|access[_-]?token|authorization|password|secret)=)[^&#\s'"<>),]+/giu, '$1[REDACTED]')
    .replace(/file:\/\/\/?[^\s'"<>),]+/giu, '[LOCAL_PATH]')
    .replace(/(^|[^A-Za-z])[A-Za-z]:[\\/][^\s'"<>),]+/gu, '$1[LOCAL_PATH]')
    .replace(/(^|[\s("'=])\/(?:Users|home|var|tmp|opt|mnt|srv|workspace|app)\/[^\s'"<>),]+/gu, '$1[LOCAL_PATH]')
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype
}

const SENSITIVE_CONTENT_FIELDS = new Set([
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
