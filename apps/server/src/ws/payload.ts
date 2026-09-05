// +-------------------------------------------------------------------------
//
//   地理智能平台 - WebSocket Payload 校验
//
//   文件:       payload.ts
//
//   日期:       2026年07月06日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

// 模块职责
//
// WebSocket payload 已经过协议层 JSON 解析，但命令字段仍来自客户端边界。
// 这里保留轻量、明确的字段校验；不把内部已类型安全的数据流重复套 Zod。

export function requiredString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} 不能为空`)
  return value.trim()
}

export function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function requiredRunProvider(value: string | null): string {
  if (!value) throw new Error('运行缺少 modelProvider，不能恢复')
  return value
}

export function optionalPositiveInteger(value: unknown, key: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`${key} 必须为正整数`)
  }
  return value
}

export function optionalNonNegativeInteger(value: unknown, key: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${key} 必须为非负整数`)
  }
  return value
}

export function requiredRecord(payload: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = payload[key]
  if (!isRecord(value)) throw new Error(`${key} 必须为 object`)
  return value
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
