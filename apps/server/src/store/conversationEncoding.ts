// +-------------------------------------------------------------------------
//
//   地理智能平台 - 会话编码与词元估算
//
//   文件:       conversationEncoding.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export function encodeHistoryCursor(sequence: number): string {
  return Buffer.from(JSON.stringify({ sequence }), 'utf8').toString('base64url')
}

export class InvalidHistoryCursorError extends Error {
  constructor() {
    super('历史记录分页游标无效。')
    this.name = 'InvalidHistoryCursorError'
  }
}

export function decodeHistoryCursor(cursor: string): number {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (
      !isRecord(parsed)
      || typeof parsed.sequence !== 'number'
      || !Number.isSafeInteger(parsed.sequence)
      || parsed.sequence < 1
    ) {
      throw new InvalidHistoryCursorError()
    }
    return parsed.sequence
  } catch (error) {
    if (error instanceof InvalidHistoryCursorError) throw error
    throw new InvalidHistoryCursorError()
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
