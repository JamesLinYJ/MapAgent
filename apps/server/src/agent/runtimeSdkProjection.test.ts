// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agents SDK 投影工具测试
//
//   文件:       runtimeSdkProjection.test.ts
//
//   日期:       2026年07月20日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'
import {
  extractReasoningDelta,
  modelSettings,
} from './runtimeSdkProjection.js'

describe('runtimeSdkProjection', () => {
  it('keeps autonomous tool choice so plan mode cannot force unrelated calls', () => {
    expect(modelSettings(true)).toMatchObject({
      toolChoice: 'auto',
      preserveRawUsage: true,
      reasoning: { effort: 'high' },
    })
    expect(modelSettings(false)).toMatchObject({
      toolChoice: 'auto',
      reasoning: { effort: 'none' },
    })
    expect(modelSettings(false, false)).not.toHaveProperty('reasoning')
  })

  it('projects native Responses API reasoning events', () => {
    expect(extractReasoningDelta({
      type: 'response.reasoning_text.delta',
      delta: '正在核验数据时次。',
      sequence_number: 3,
    })).toBe('正在核验数据时次。')
  })
})
