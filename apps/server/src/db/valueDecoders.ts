// +-------------------------------------------------------------------------
//
//   地理智能平台 - 数据库值解码
//
//   文件:       valueDecoders.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

/** 数据库驱动返回值进入领域模型前的硬边界解码。 */
export function decodeRequiredTimestamp(value: unknown, fieldName: string): string {
  const parsed = value instanceof Date ? value : new Date(String(value ?? ''))
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`数据库字段 '${fieldName}' 包含无效时间戳。`)
  }
  return parsed.toISOString()
}

export function decodeRequiredRecord(value: unknown, fieldName: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`数据库字段 '${fieldName}' 必须是对象。`)
  }
  return value as Record<string, unknown>
}
