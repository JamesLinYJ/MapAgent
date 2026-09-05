// +-------------------------------------------------------------------------
//
//   地理智能平台 - 指标语义测试
//
//   文件:       metrics.test.ts
//
//   日期:       2026年07月22日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import { available, unavailable } from './metrics.js'

describe('operations metric semantics', () => {
  it('preserves full native process-tree CPU values above one core', () => {
    expect(available(245.7)).toEqual({ value: 245.7 })
  })

  it('never turns a failed or non-finite sample into a fake zero', () => {
    expect(available(Number.NaN)).toEqual({ value: null, unavailableReason: '指标源返回了非有限数值。' })
    expect(unavailable('采集器不可用')).toEqual({ value: null, unavailableReason: '采集器不可用' })
  })
})
