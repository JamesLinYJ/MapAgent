// +-------------------------------------------------------------------------
//
//   地理智能平台 - 监督日志内存缓冲
//
//   文件:       logBuffer.ts
//
//   日期:       2026年07月22日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type {
  OperationsLogCategory,
  OperationsLogEntry,
  OperationsLogFilter,
  OperationsLogPage,
  OperationsLogQuery,
  OperationsLogRetention,
  OperationsServiceId,
} from '@geo-agent-platform/shared-types/operations'
import stripAnsi from 'strip-ansi'

const MAX_LINE_BYTES = 32 * 1024
const MAX_ATTRIBUTES_BYTES = 4 * 1024
const NORMAL_RETENTION_MS = 10 * 60_000
const DIAGNOSTIC_RETENTION_MS = 30 * 60_000
const DIAGNOSTIC_MAX_BYTES = 32 * 1024 * 1024
const STRUCTURED_ATTRIBUTE_KEYS = new Set([
  'toolName',
  'workflowStepId',
  'automationId',
  'automationRunId',
  'taskId',
  'phase',
  'status',
  'statusCode',
  'httpMethod',
  'httpPath',
  'provider',
  'model',
  'modelProvider',
  'modelName',
  'wsCommand',
  'purpose',
  'attempt',
  'failureSource',
  'failureCode',
  'transport',
  'durationMs',
  'timeToResponseStartedMs',
  'timeToFirstTextDeltaMs',
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'cacheHitInputTokens',
  'cacheMissInputTokens',
])
const STRUCTURED_ATTRIBUTE_ALIASES = [
  ['toolName', 'tool_name'],
  ['durationMs', 'duration_ms'],
  ['statusCode', 'status_code'],
  ['failureCode', 'failure_code'],
  ['provider', 'providerId'],
] as const

export class OperationsLogBuffer {
  private readonly entries: Array<{ entry: OperationsLogEntry; ingestedAt: number }> = []
  private byteSize = 0
  private sequence: number
  private diagnosticMode = false

  constructor(
    private readonly maxEntries = 10_000,
    private readonly normalMaxBytes = 8 * 1024 * 1024,
    private readonly options: {
      diagnosticMaxBytes?: number
      normalRetentionMs?: number
      diagnosticRetentionMs?: number
      now?: () => number
      sequenceOffset?: number
    } = {},
  ) {
    this.sequence = options.sequenceOffset ?? 0
  }

  append(input: {
    serviceId: OperationsServiceId | null
    stream: OperationsLogEntry['stream']
    message: string
    level?: OperationsLogEntry['level']
    component?: string | null
    processId?: number | null
    attributes?: Readonly<Record<string, unknown>>
    createdAt?: Date
  }): OperationsLogEntry {
    const sanitized = sanitizeSensitiveText(sanitizeLogLine(input.message))
    const structured = parseStructuredLog(sanitized)
    const serviceId = input.serviceId ?? normalizeServiceId(structured?.raw.serviceId)
    const stream = normalizeLogStream(structured?.raw.stream) ?? input.stream
    const prefixed = parseComponentPrefix(structured?.message ?? sanitized, serviceId)
    const message = truncateUtf8(this.sanitizeText(prefixed.message), MAX_LINE_BYTES)
    const raw = {
      ...(structured?.raw ?? {}),
      ...(input.attributes ?? {}),
    }
    const attributes = boundedAttributes({
      ...projectStructuredAttributes(structured?.raw ?? {}, value => this.sanitizeText(value)),
      ...projectStructuredAttributes(input.attributes ?? {}, value => this.sanitizeText(value)),
    })
    const level = input.level
      ?? (structured?.level && structured.level !== 'unknown'
      ? structured.level
      : inferLevel(message, stream))
    const event = structuredEvent(raw)
      ?? inferEvent(serviceId, stream, message)
    const category = structuredCategory(raw)
      ?? inferCategory(event, message)
    const retention = structuredRetention(raw)
      ?? inferRetention(level)
    const correlation = projectCorrelation(raw, value => this.sanitizeText(value))
    const entry: OperationsLogEntry = {
      sequence: ++this.sequence,
      serviceId,
      component: normalizeComponent(input.component)
        ?? structured?.component
        ?? prefixed.component,
      processId: normalizeProcessId(input.processId)
        ?? structured?.processId
        ?? null,
      stream,
      level,
      event,
      category,
      retention,
      correlation,
      message,
      errorStack: projectErrorStack(raw, value => this.sanitizeText(value)),
      attributes,
      createdAt: (input.createdAt ?? structured?.createdAt ?? new Date()).toISOString(),
    }
    this.entries.push({ entry, ingestedAt: this.now() })
    this.byteSize += entryByteSize(entry)
    this.prune()
    return entry
  }

  setDiagnosticMode(enabled: boolean): void {
    this.diagnosticMode = enabled
    this.prune()
  }

  stats(): {
    retainedEntries: number
    retainedBytes: number
    maxBytes: number
    oldestCreatedAt: string | null
  } {
    this.prune()
    return {
      retainedEntries: this.entries.length,
      retainedBytes: this.byteSize,
      maxBytes: this.currentMaxBytes(),
      oldestCreatedAt: this.entries[0]?.entry.createdAt ?? null,
    }
  }

  tail(services: readonly OperationsServiceId[], count: number): OperationsLogEntry[] {
    return this.query({
      services: [...services],
      levels: [],
      streams: [],
      categories: [],
      events: [],
      retentions: [],
      correlationId: '',
      search: '',
      includeSupervisor: false,
      afterSequence: null,
      tail: count,
    })
  }

  query(query: OperationsLogQuery): OperationsLogEntry[] {
    if (query.tail === 0) return []
    this.prune()
    return this.entries
      .map(value => value.entry)
      .filter(entry => matchesOperationsLogFilter(entry, query))
      .slice(-query.tail)
  }

  page(query: OperationsLogQuery): OperationsLogPage {
    this.prune()
    if (query.tail === 0) {
      return { entries: [], nextCursor: query.afterSequence, hasMore: false }
    }
    const matching = this.entries
      .map(value => value.entry)
      .filter(entry => matchesOperationsLogFilter(entry, query))
    // 首次查询返回最新窗口；带游标的续接查询从游标之后按顺序取第一页，
    // 这样即使积压超过单帧预算也不会跳过中间事件。
    const entries = query.afterSequence === null
      ? matching.slice(-query.tail)
      : matching.slice(0, query.tail)
    return {
      entries,
      nextCursor: entries.at(-1)?.sequence ?? query.afterSequence,
      hasMore: matching.length > entries.length,
    }
  }

  private sanitizeText(value: string): string {
    return sanitizeSensitiveText(value)
  }

  private prune(): void {
    const threshold = this.now() - this.currentRetentionMs()
    while (
      this.entries.length > 0
      && (
        this.entries.length > this.maxEntries
        || this.byteSize > this.currentMaxBytes()
        || (this.entries[0]?.ingestedAt ?? Number.POSITIVE_INFINITY) < threshold
      )
    ) {
      const removed = this.entries.shift()
      if (!removed) break
      this.byteSize -= entryByteSize(removed.entry)
    }
  }

  private currentMaxBytes(): number {
    return this.diagnosticMode
      ? this.options.diagnosticMaxBytes ?? Math.max(this.normalMaxBytes, DIAGNOSTIC_MAX_BYTES)
      : this.normalMaxBytes
  }

  private currentRetentionMs(): number {
    return this.diagnosticMode
      ? this.options.diagnosticRetentionMs ?? DIAGNOSTIC_RETENTION_MS
      : this.options.normalRetentionMs ?? NORMAL_RETENTION_MS
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }
}

export function matchesOperationsLogFilter(
  entry: OperationsLogEntry,
  filter: OperationsLogFilter,
): boolean {
  if (entry.serviceId === null) {
    if (!filter.includeSupervisor) return false
  } else if (!filter.services.includes(entry.serviceId)) {
    return false
  }
  if (filter.levels.length > 0 && !filter.levels.includes(entry.level)) return false
  if (filter.streams.length > 0 && !filter.streams.includes(entry.stream)) return false
  if (filter.categories.length > 0 && !filter.categories.includes(entry.category)) return false
  if (filter.events.length > 0 && !filter.events.includes(entry.event)) return false
  if (filter.retentions.length > 0 && !filter.retentions.includes(entry.retention)) return false
  if (filter.correlationId && !Object.values(entry.correlation).includes(filter.correlationId)) return false
  if (filter.afterSequence !== null && entry.sequence <= filter.afterSequence) return false
  if (filter.search && !searchableLogText(entry).includes(filter.search.toLocaleLowerCase('zh-CN'))) return false
  return true
}

export class LineDecoder {
  private readonly decoder = new TextDecoder('utf-8', { fatal: false })
  private pending = ''

  push(chunk: Uint8Array): string[] {
    this.pending += this.decoder.decode(chunk, { stream: true })
    const lines = this.pending.split('\n')
    this.pending = lines.pop() ?? ''
    return lines
  }

  finish(): string[] {
    this.pending += this.decoder.decode()
    if (!this.pending) return []
    const value = this.pending
    this.pending = ''
    return [value]
  }
}

function inferLevel(message: string, stream: OperationsLogEntry['stream']): OperationsLogEntry['level'] {
  if (/\b(error|fatal|exception|失败|错误)\b/iu.test(message)) return 'error'
  if (/\b(warn|warning|警告)\b/iu.test(message)) return 'warn'
  if (/\b(debug|trace|调试)\b/iu.test(message)) return 'debug'
  if (/\b(info|ready|started|healthy|完成|就绪|启动)\b/iu.test(message)) return 'info'
  if (stream === 'stderr') return 'warn'
  return 'unknown'
}

function sanitizeLogLine(value: string): string {
  return stripAnsi(value.replace(/\r$/u, ''))
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu, '')
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  let end = Math.min(value.length, maxBytes)
  while (end > 0 && Buffer.byteLength(value.slice(0, end), 'utf8') > maxBytes - 3) end -= 1
  return `${value.slice(0, end)}…`
}

interface StructuredLogProjection {
  message: string
  level: OperationsLogEntry['level']
  component: string | null
  processId: number | null
  createdAt: Date | undefined
  raw: Record<string, unknown>
}

function parseStructuredLog(value: string): StructuredLogProjection | null {
  if (!value.startsWith('{') || !value.endsWith('}')) return null
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    const rawMessage = typeof record.msg === 'string'
      ? record.msg
      : typeof record.message === 'string'
        ? record.message
        : null
    if (!rawMessage) return null
    return {
      message: rawMessage,
      level: structuredLevel(record.level),
      component: normalizeComponent(record.component)
        ?? normalizeComponent(record.service)
        ?? normalizeComponent(record.name)
        ?? normalizeComponent(record.logger),
      processId: normalizeProcessId(record.pid),
      createdAt: structuredTimestamp(record.time ?? record.timestamp),
      raw: record,
    }
  } catch {
    return null
  }
}

function structuredLevel(value: unknown): OperationsLogEntry['level'] {
  if (typeof value === 'number') {
    if (value >= 50) return 'error'
    if (value >= 40) return 'warn'
    if (value >= 30) return 'info'
    return 'debug'
  }
  if (typeof value === 'string') {
    const normalized = value.toLowerCase()
    if (normalized === 'fatal' || normalized === 'error') return 'error'
    if (normalized === 'warn' || normalized === 'warning') return 'warn'
    if (normalized === 'info') return 'info'
    if (normalized === 'debug' || normalized === 'trace') return 'debug'
  }
  return 'unknown'
}

function structuredTimestamp(value: unknown): Date | undefined {
  const date = typeof value === 'number'
    ? new Date(value)
    : typeof value === 'string'
      ? new Date(value)
      : null
  return date && Number.isFinite(date.getTime()) ? date : undefined
}

function parseComponentPrefix(
  value: string,
  serviceId: OperationsServiceId | null,
): { message: string; component: string | null } {
  const matched = /^\[([a-zA-Z0-9_-]{1,80})\]\s*/u.exec(value)
  if (!matched?.[1]) return { message: value, component: null }
  return {
    message: value.slice(matched[0].length),
    component: matched[1] === serviceId ? null : matched[1],
  }
}

function normalizeComponent(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().slice(0, 80)
  return normalized ? normalized : null
}

function normalizeProcessId(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : null
}

function normalizeServiceId(value: unknown): OperationsServiceId | null {
  return value === 'infra' || value === 'worker' || value === 'api' ? value : null
}

function normalizeLogStream(value: unknown): OperationsLogEntry['stream'] | null {
  return value === 'stdout' || value === 'stderr' || value === 'supervisor' ? value : null
}

function searchableLogText(entry: OperationsLogEntry): string {
  return [
    entry.serviceId ?? 'supervisor',
    entry.component ?? '',
    entry.stream,
    entry.level,
    entry.event,
    entry.category,
    entry.retention,
    JSON.stringify(entry.correlation),
    entry.message,
    JSON.stringify(entry.attributes),
  ].join(' ').toLocaleLowerCase('zh-CN')
}

function projectStructuredAttributes(
  record: Readonly<Record<string, unknown>>,
  sanitize: (value: string) => string,
): Record<string, string | number | boolean | null> {
  const attributes: Record<string, string | number | boolean | null> = {}
  for (const key of STRUCTURED_ATTRIBUTE_KEYS) {
    const value = normalizeAttributeValue(record[key], sanitize)
    if (value !== undefined) attributes[key] = value
  }
  for (const [target, source] of STRUCTURED_ATTRIBUTE_ALIASES) {
    const value = normalizeAttributeValue(record[source], sanitize)
    if (value !== undefined && attributes[target] === undefined) attributes[target] = value
  }
  const error = isRecord(record.error) ? record.error : isRecord(record.err) ? record.err : null
  if (error) {
    const fields = {
      errorName: error.name,
      errorMessage: error.message,
      errorCode: error.code,
      errorStatus: error.status ?? error.statusCode,
    }
    for (const [key, rawValue] of Object.entries(fields)) {
      const value = normalizeAttributeValue(rawValue, sanitize)
      if (value !== undefined) attributes[key] = value
    }
  }
  return attributes
}

function boundedAttributes(
  source: Readonly<Record<string, string | number | boolean | null>>,
): Record<string, string | number | boolean | null> {
  const result: Record<string, string | number | boolean | null> = {}
  for (const [key, value] of Object.entries(source)) {
    const candidate = { ...result, [key]: value }
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > MAX_ATTRIBUTES_BYTES) break
    result[key] = value
  }
  return result
}

function normalizeAttributeValue(
  value: unknown,
  sanitize: (value: string) => string,
): string | number | boolean | null | undefined {
  if (value === null) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return undefined
  return sanitize(value).slice(0, 1_000)
}

function sanitizeSensitiveText(value: string): string {
  return sanitizeLogLine(value)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu, '$1 [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/gu, '[REDACTED]')
    .replace(
      /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|cookie|authorization)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/giu,
      '$1[REDACTED]',
    )
    .replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/@\s]+)@/gu, '$1[REDACTED]@')
    .replace(/(^|[^A-Za-z])[A-Za-z]:[\\/][^\s'"<>),]+/gu, '$1[LOCAL_PATH]')
    .replace(/(^|[\s("'=])\/(?:Users|home|var|tmp|opt|mnt|srv|workspace|app)\/[^\s'"<>),]+/gu, '$1[LOCAL_PATH]')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function entryByteSize(entry: OperationsLogEntry): number {
  return Buffer.byteLength(entry.message, 'utf8')
    + (entry.errorStack ? Buffer.byteLength(entry.errorStack, 'utf8') : 0)
    + Buffer.byteLength(JSON.stringify(entry.correlation), 'utf8')
    + (Object.keys(entry.attributes).length > 0
      ? Buffer.byteLength(JSON.stringify(entry.attributes), 'utf8')
      : 0)
}

function structuredEvent(record: Readonly<Record<string, unknown>>): string | null {
  const value = record.event
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  return /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u.test(normalized)
    ? normalized.slice(0, 120)
    : null
}

function structuredCategory(record: Readonly<Record<string, unknown>>): OperationsLogCategory | null {
  const value = record.category
  return typeof value === 'string' && LOG_CATEGORIES.has(value as OperationsLogCategory)
    ? value as OperationsLogCategory
    : null
}

function structuredRetention(record: Readonly<Record<string, unknown>>): OperationsLogRetention | null {
  return record.retention === 'operational' || record.retention === 'diagnostic'
    ? record.retention
    : null
}

function inferEvent(
  serviceId: OperationsServiceId | null,
  stream: OperationsLogEntry['stream'],
  message: string,
): string {
  if (/health|健康/iu.test(message)) return 'health.probe.output'
  if (serviceId === null || stream === 'supervisor') return 'supervisor.output'
  return 'process.output'
}

function inferCategory(event: string, message: string): OperationsLogCategory {
  const prefix = event.split('.')[0]
  if (prefix && LOG_CATEGORIES.has(prefix as OperationsLogCategory)) return prefix as OperationsLogCategory
  if (/health|健康/iu.test(message)) return 'health'
  return 'system'
}

function inferRetention(level: OperationsLogEntry['level']): OperationsLogRetention {
  return level === 'debug' || level === 'unknown' ? 'diagnostic' : 'operational'
}

function projectCorrelation(
  record: Readonly<Record<string, unknown>>,
  sanitize: (value: string) => string,
): OperationsLogEntry['correlation'] {
  const aliases: ReadonlyArray<readonly [keyof OperationsLogEntry['correlation'], string, string]> = [
    ['traceId', 'traceId', 'trace_id'],
    ['runId', 'runId', 'run_id'],
    ['threadId', 'threadId', 'thread_id'],
    ['requestId', 'requestId', 'request_id'],
    ['responseId', 'responseId', 'response_id'],
  ]
  const correlation: OperationsLogEntry['correlation'] = {}
  for (const [target, camel, snake] of aliases) {
    const value = record[camel] ?? record[snake]
    if (typeof value === 'string' && value.trim()) correlation[target] = sanitize(value.trim()).slice(0, 160)
  }
  const wsRequestId = record.wsRequestId
  if (!correlation.requestId && typeof wsRequestId === 'string' && wsRequestId.trim()) {
    correlation.requestId = sanitize(wsRequestId.trim()).slice(0, 160)
  }
  return correlation
}

function projectErrorStack(
  record: Readonly<Record<string, unknown>>,
  sanitize: (value: string) => string,
): string | null {
  const error = isRecord(record.error) ? record.error : isRecord(record.err) ? record.err : null
  const stack = error?.stack ?? record.errorStack
  return typeof stack === 'string' && stack.trim()
    ? truncateUtf8(sanitize(stack), 8_000)
    : null
}

const LOG_CATEGORIES = new Set<OperationsLogCategory>([
  'lifecycle',
  'health',
  'request',
  'agent',
  'model',
  'tool',
  'storage',
  'security',
  'ui',
  'system',
])
