// +-------------------------------------------------------------------------
//
//   地理智能平台 - 本机 Agent 终端时间线投影测试
//
//   文件:       localAgentTimeline.test.ts
//
//   日期:       2026年09月03日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5
// --------------------------------------------------------------------------

import type { ConversationItem } from '@geo-agent-platform/shared-types'
import { describe, expect, it } from 'vitest'

import { LocalAgentTimelineProjection } from './localAgentTimeline.js'

describe('LocalAgentTimelineProjection', () => {
  it('reflows only the changed entry across a long streaming history', () => {
    const items = Array.from({ length: 200 }, (_, index) => message(`item_${index}`, `历史消息 ${index}`))
    const timeline = new LocalAgentTimelineProjection(items)
    timeline.getLines(88, new Set())
    const before = timeline.getStats()

    timeline.replaceItems([
      ...items.slice(0, -1),
      { ...items.at(-1)!, body: '正在流式增长的最后一条消息' },
    ], [])
    timeline.getLines(88, new Set())

    expect(timeline.getStats().entryLayouts - before.entryLayouts).toBe(1)
    expect(timeline.getStats().presentationUpdates - before.presentationUpdates).toBe(1)
  })

  it('keeps successful tools collapsed until the user expands them', () => {
    const call = tool('function_call', 'call_1')
    const output = { ...tool('function_call_output', 'call_1'), output: '{"summary":"查询完成"}' }
    const timeline = new LocalAgentTimelineProjection([call, output])

    expect(timeline.getLines(80, new Set()).map(line => line.text).join('\n'))
      .not.toContain('输出')
    expect(timeline.getLines(80, new Set(['tool:call_1'])).map(line => line.text).join('\n'))
      .toContain('输出  查询完成')
  })
})

function message(itemId: string, body: string): ConversationItem {
  return {
    itemId,
    itemType: 'message',
    runId: 'run_1',
    threadId: 'thread_1',
    turnId: null,
    callId: null,
    role: 'assistant',
    body,
    name: null,
    arguments: null,
    output: null,
    isError: false,
    phase: null,
    status: 'completed',
    metadata: {},
    timestamp: `2026-09-03T00:00:${itemId.padStart(2, '0')}.000Z`,
  }
}

function tool(itemType: 'function_call' | 'function_call_output', callId: string): ConversationItem {
  return {
    ...message(`${itemType}_${callId}`, ''),
    itemType,
    callId,
    name: 'query_weather',
    arguments: itemType === 'function_call' ? '{"location":"杭州"}' : null,
    output: itemType === 'function_call_output' ? '' : null,
  }
}
