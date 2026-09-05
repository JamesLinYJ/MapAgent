// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面系统日志脱敏
//
//   文件:       desktopLogSanitizer.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import path from 'node:path'

const SECRET_NAME_PATTERN = /(KEY|SECRET|TOKEN|PASSWORD|COOKIE|AUTHORIZATION)/iu
const MAX_DEPTH = 5
const MAX_STRING_LENGTH = 4_000

export function sanitizeDesktopLogValue(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): unknown {
  if (typeof value === 'string') return sanitizeDesktopLogText(value)
  if (value === null || typeof value === 'number' || typeof value === 'boolean' || value === undefined) {
    return value
  }
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'symbol' || typeof value === 'function') return `[${typeof value}]`
  if (depth >= MAX_DEPTH) return '[TRUNCATED]'

  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitizeDesktopLogText(value.message),
      ...(value.stack ? { stack: sanitizeDesktopLogText(value.stack) } : {}),
    }
  }
  if (seen.has(value)) return '[CIRCULAR]'
  seen.add(value)
  if (Array.isArray(value)) {
    const result = value.slice(0, 100).map(item => sanitizeDesktopLogValue(item, depth + 1, seen))
    seen.delete(value)
    return result
  }

  const result: Record<string, unknown> = {}
  for (const [name, item] of Object.entries(value).slice(0, 100)) {
    result[name] = SECRET_NAME_PATTERN.test(name)
      ? '[REDACTED]'
      : sanitizeDesktopLogValue(item, depth + 1, seen)
  }
  seen.delete(value)
  return result
}

export function sanitizeDesktopLogText(value: string): string {
  let sanitized = ''
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (
      codePoint === undefined
      || codePoint === 0x09
      || codePoint === 0x0a
      || codePoint === 0x0d
      || (codePoint >= 0x20 && codePoint !== 0x7f)
    ) {
      sanitized += character
    }
  }
  sanitized = redactDesktopLocalPaths(sanitized)
  sanitized = sanitized
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu, '$1 [REDACTED]')
    .replace(
      /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|cookie|authorization)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/giu,
      '$1[REDACTED]',
    )
    .replace(/(https?:\/\/)([^/@\s]+)@/giu, '$1[REDACTED]@')
  return sanitized.slice(0, MAX_STRING_LENGTH)
}

function redactDesktopLocalPaths(value: string): string {
  const trimmed = value.trim()
  if (isApplicationRoute(trimmed) || /^https?:\/\//iu.test(trimmed)) return value
  if (
    path.win32.isAbsolute(trimmed)
    || path.posix.isAbsolute(trimmed)
    || /^file:\/\//iu.test(trimmed)
  ) {
    return value.replace(trimmed, '[LOCAL_PATH]')
  }
  return value
    .replace(/file:\/\/\/?(?:[A-Za-z]:)?\/?[^\s"'<>),\]}]+/giu, '[LOCAL_PATH]')
    .replace(
      /(^|[^A-Za-z0-9_])(?:[A-Za-z]:[\\/][^\s"'<>|?*:]+|\\\\[^\\/\s"'<>|?*:]+[\\/][^\s"'<>|?*:]+)(?=:\d+(?::\d+)?|$|[\s)"'\]},;])/gu,
      '$1[LOCAL_PATH]',
    )
    .replace(
      /(^|[\s("'=:[{,])(\/(?!\/)(?:[^/\s"'<>),\]}:]+\/)+[^/\s"'<>),\]}:]*)(?=:\d+(?::\d+)?|$|[\s)"'\]},;])/gu,
      (match, prefix: string, candidate: string) => (
        isApplicationRoute(candidate) ? match : `${prefix}[LOCAL_PATH]`
      ),
    )
}

// 固定应用路由不是文件路径；其它未知根路径按本机路径处理，避免把非标准挂载点泄露给 Renderer。
function isApplicationRoute(value: string): boolean {
  return /^\/(?:api(?:\/|$)|health$|ops(?:\/|$))/iu.test(value)
}
