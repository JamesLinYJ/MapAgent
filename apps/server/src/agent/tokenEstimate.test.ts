// +-------------------------------------------------------------------------
//
//   地理智能平台 - 多语言 Token 估算测试
//
//   文件:       tokenEstimate.test.ts
//
//   日期:       2026年08月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'
import { estimateTextTokens } from './tokenEstimate.js'

describe('estimateTextTokens', () => {
  it('keeps the inexpensive four-ASCII-characters heuristic for English and JSON', () => {
    expect(estimateTextTokens('a'.repeat(400))).toBe(100)
  })

  it('does not underestimate CJK text by four times', () => {
    expect(estimateTextTokens('杭州降水'.repeat(25))).toBe(100)
  })

  it('counts supplementary Unicode code points conservatively without double-counting surrogates', () => {
    expect(estimateTextTokens('🗺️'.repeat(30))).toBeGreaterThanOrEqual(60)
  })

  it('accumulates multiple input sections before rounding', () => {
    expect(estimateTextTokens('a', 'b', 'c', 'd')).toBe(1)
  })
})
