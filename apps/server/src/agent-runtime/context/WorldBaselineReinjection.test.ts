// +-------------------------------------------------------------------------
//
//   地理智能平台 - GeoWorld 基线重注入测试
//
//   文件:       WorldBaselineReinjection.test.ts
//
//   日期:       2026年08月24日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { ModelRequest } from '@openai/agents'
import { describe, expect, it } from 'vitest'
import { stepContext } from '../approvals/approvalTestFixtures.js'
import {
  assertGeoWorldBaselineBound,
  reinjectGeoWorldBaseline,
} from './WorldBaselineReinjection.js'

describe('WorldBaselineReinjection', () => {
  it('inserts one exact baseline immediately before the latest real user input', () => {
    const context = stepContext()
    const request = modelRequest([
      { type: 'message', role: 'system', content: '系统约束' },
      { type: 'message', role: 'system', content: '<run-history-summary>旧摘要</run-history-summary>' },
      { type: 'message', role: 'user', content: '继续绘图' },
    ])

    const injected = reinjectGeoWorldBaseline(request, context)
    if (typeof injected.input === 'string') throw new Error('测试请求未转换为结构化输入')
    expect(injected.input.map(item => ('role' in item ? item.role : item.type)))
      .toEqual(['system', 'system', 'system', 'user'])
    expect(JSON.stringify(injected.input[2])).toContain('state-digest=\\"sha256:world\\"')
    assertGeoWorldBaselineBound(injected, context)
  })

  it('replaces a stale baseline instead of accumulating one after rollover', () => {
    const firstContext = stepContext()
    const first = reinjectGeoWorldBaseline(modelRequest('第一次输入'), firstContext)
    const nextContext = {
      ...firstContext,
      worldRevision: 2,
      world: {
        ...firstContext.world,
        revision: 2,
        stateDigest: 'sha256:world-2',
        layerIds: ['layer_2'],
      },
    }
    const next = reinjectGeoWorldBaseline(first, nextContext)

    expect(JSON.stringify(next.input)).not.toContain('state-digest=\\"sha256:world\\"')
    expect(JSON.stringify(next.input)).toContain('state-digest=\\"sha256:world-2\\"')
    assertGeoWorldBaselineBound(next, nextContext)
  })

  it('rejects a recovered model request whose persisted baseline is missing', () => {
    expect(() => assertGeoWorldBaselineBound(modelRequest('恢复输入'), stepContext()))
      .toThrow('缺少 GeoWorld revision 1 基线')
  })
})

function modelRequest(input: ModelRequest['input']): ModelRequest {
  return {
    input,
    modelSettings: {},
    tools: [],
    outputType: 'text',
    handoffs: [],
    tracing: false,
  }
}
