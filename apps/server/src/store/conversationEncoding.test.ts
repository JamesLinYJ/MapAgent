// +-------------------------------------------------------------------------
//
//   地理智能平台 - 会话编码测试
//
//   文件:       conversationEncoding.test.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'
import {
  decodeHistoryCursor,
  encodeHistoryCursor,
  InvalidHistoryCursorError,
} from './conversationEncoding.js'

describe('conversationEncoding', () => {
  it('round-trips safe history cursors', () => {
    expect(decodeHistoryCursor(encodeHistoryCursor(42))).toBe(42)
  })

  it('rejects malformed and unsafe history cursors with a typed error', () => {
    const unsafeCursor = Buffer.from(
      JSON.stringify({ sequence: Number.MAX_SAFE_INTEGER + 1 }),
      'utf8',
    ).toString('base64url')

    expect(() => decodeHistoryCursor('not-json')).toThrow(InvalidHistoryCursorError)
    expect(() => decodeHistoryCursor(unsafeCursor)).toThrow(InvalidHistoryCursorError)
  })
})
