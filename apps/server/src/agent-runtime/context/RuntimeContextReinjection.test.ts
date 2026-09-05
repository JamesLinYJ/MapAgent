// +-------------------------------------------------------------------------
//
//   地理智能平台 - 模型窗口运行上下文重注入测试
//
//   文件:       RuntimeContextReinjection.test.ts
//
//   日期:       2026年08月30日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { ModelRequest } from '@openai/agents'
import { describe, expect, it } from 'vitest'
import { reinjectRuntimeContext } from './RuntimeContextReinjection.js'

describe('RuntimeContextReinjection', () => {
  it('keeps systemInstructions byte-stable while replacing Thread-specific context', () => {
    const original = modelRequest([
      { type: 'message', role: 'system', content: '历史摘要' },
      { type: 'message', role: 'user', content: '继续分析' },
    ])
    const first = reinjectRuntimeContext(original, 'Thread A 的运行上下文', ['Hook A'])
    const second = reinjectRuntimeContext(first, 'Thread B 的运行上下文', ['Hook B'])

    expect(first.systemInstructions).toBe('固定系统规则')
    expect(second.systemInstructions).toBe('固定系统规则')
    expect(JSON.stringify(second.input)).not.toContain('Thread A')
    expect(JSON.stringify(second.input)).not.toContain('Hook A')
    expect(JSON.stringify(second.input)).toContain('Thread B')
    expect(JSON.stringify(second.input)).toContain('Hook B')
    expect(JSON.stringify(second.input).match(/<runtime-context>/g)).toHaveLength(1)
  })

  it('places dynamic context immediately before the latest user input', () => {
    const request = modelRequest([
      { type: 'message', role: 'system', content: '线程资源' },
      { type: 'message', role: 'user', content: '旧问题' },
      { type: 'message', role: 'assistant', content: '旧回答', status: 'completed' },
      { type: 'message', role: 'user', content: '最新问题' },
    ])

    const injected = reinjectRuntimeContext(request, '本轮运行上下文', [])
    if (typeof injected.input === 'string') throw new Error('测试请求未转换为结构化输入')
    expect(injected.input.map(item => (
      'role' in item && typeof item.content === 'string' ? item.content : item.type
    ))).toEqual([
      '线程资源',
      '旧问题',
      '旧回答',
      '<runtime-context>\n本轮运行上下文\n</runtime-context>',
      '最新问题',
    ])
  })
})

function modelRequest(input: ModelRequest['input']): ModelRequest {
  return {
    input,
    systemInstructions: '固定系统规则',
    modelSettings: {},
    tools: [],
    outputType: 'text',
    handoffs: [],
    tracing: false,
  }
}
