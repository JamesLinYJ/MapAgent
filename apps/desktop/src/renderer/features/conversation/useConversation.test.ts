// +-------------------------------------------------------------------------
//
//   地理智能平台 - 对话状态摘要测试
//
//   文件:       useConversation.test.ts
//
//   日期:       2026年08月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import { formatStatusLine } from './useConversation'

describe('conversation status line', () => {
  it('shows model-route unavailability instead of a contradictory ready state', () => {
    expect(formatStatusLine(
      undefined,
      'DeepSeek',
      0,
      undefined,
      'DeepSeek 尚未配置',
    )).toBe('DeepSeek 尚未配置')
  })

  it('keeps the normal run and route summary when the route is executable', () => {
    expect(formatStatusLine(undefined, 'DeepSeek', 0))
      .toBe('准备就绪 · 模型路由 DeepSeek')
  })
})
