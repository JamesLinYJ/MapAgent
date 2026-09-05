// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面传输错误归一化
//
//   文件:       errors.ts
//
//   日期:       2026年07月02日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { isRecord } from '../shared/utils/guards'

export const API_UNAVAILABLE_MESSAGE = '工作台 API 未连接，请启动 Node API 服务。'

export type TransportKind = 'http' | 'websocket'

export interface TransportErrorOptions {
  transport: TransportKind
  code: string
  status?: number
  cause?: unknown
}

export class PlatformTransportError extends Error {
  readonly transport: TransportKind
  readonly code: string
  readonly status?: number

  constructor(message: string, options: TransportErrorOptions) {
    super(message, { cause: options.cause })
    this.name = 'PlatformTransportError'
    this.transport = options.transport
    this.code = options.code
    this.status = options.status
  }
}

const API_UNAVAILABLE_PATTERNS = [
  'bad gateway',
  'proxy failed',
  'econnrefused',
  'failed to fetch',
  'load failed',
  'networkerror',
  'http 502',
  'http 503',
  '502',
  '503',
] as const

// 代理层和浏览器网络异常不是认证失败；统一翻译成可执行的服务状态提示。
// 这里不吞掉后端业务错误，只有明确 API 不可达时才替换为固定文案。
export function normalizeApiErrorMessage(error: unknown, fallback = API_UNAVAILABLE_MESSAGE): string {
  const message = normalizeBoundaryErrorMessage(error, fallback)
  return isApiUnavailableMessage(message) ? API_UNAVAILABLE_MESSAGE : message
}

/**
 * 把跨进程和 schema 边界抛出的异常投影为可直接展示的单行消息。
 * Zod 的 issues 是结构化事实，界面不应暴露其 JSON 序列化格式。
 */
export function normalizeBoundaryErrorMessage(error: unknown, fallback: string): string {
  const structuredMessage = formatValidationIssues(error)
  if (structuredMessage) return structuredMessage

  const message = extractErrorMessage(error, fallback)
  return formatSerializedValidationIssues(message) ?? message
}

export function formatApiError(prefix: string, detail?: string): string {
  if (detail && isApiUnavailableMessage(detail)) return API_UNAVAILABLE_MESSAGE
  return detail?.trim() ? `${prefix}：${detail.trim()}` : prefix
}

export function isApiUnavailableMessage(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const normalized = value.toLowerCase()
  return API_UNAVAILABLE_PATTERNS.some(pattern => normalized.includes(pattern))
}

function extractErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message
  if (typeof error === 'string' && error.trim()) return error
  if (isRecord(error)) {
    const detail = error.detail ?? error.error ?? error.message
    if (typeof detail === 'string' && detail.trim()) return detail
  }
  return fallback
}

function formatSerializedValidationIssues(message: string): string | null {
  const trimmed = message.trim()
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return null
  try {
    return formatValidationIssues(JSON.parse(trimmed))
  } catch {
    return null
  }
}

function formatValidationIssues(value: unknown): string | null {
  const issues = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.issues)
      ? value.issues
      : null
  if (!issues) return null

  const messages = issues
    .slice(0, 5)
    .map((issue) => {
      if (!isRecord(issue) || typeof issue.message !== 'string' || !issue.message.trim()) return null
      const path = Array.isArray(issue.path)
        ? issue.path.filter(part => typeof part === 'string' || typeof part === 'number').join('.')
        : ''
      return path ? `${path}：${issue.message.trim()}` : issue.message.trim()
    })
    .filter((message): message is string => Boolean(message))

  return messages.length > 0 ? messages.join('；') : null
}

