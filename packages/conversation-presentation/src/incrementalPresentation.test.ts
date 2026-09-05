// +-------------------------------------------------------------------------
//
//   地理智能平台 - 对话增量展示投影测试
//
//   文件:       incrementalPresentation.test.ts
//
//   日期:       2026年08月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { ConversationItem } from '@geo-agent-platform/shared-types'
import { describe, expect, it, vi } from 'vitest'

import { ConversationPresentationIndex } from './presentation.js'
import { ConversationTimelineProjectionStore } from './projection.js'

describe('ConversationPresentationIndex', () => {
  it('只重算变化的消息并保留历史条目身份', () => {
    const first = item('item_1', '旧回答')
    const streaming = item('item_2', '杭', 'running')
    const projection = new ConversationPresentationIndex([first, streaming])
    const before = projection.getSnapshot()
    const beforeStats = projection.getStats()

    projection.replaceItems([first, { ...streaming, body: '杭州' }])

    const after = projection.getSnapshot()
    const afterStats = projection.getStats()
    expect(after[0]).toBe(before[0])
    expect(after[1]).not.toBe(before[1])
    expect(after[1]?.body).toBe('杭州')
    expect(afterStats.entryUpdates - beforeStats.entryUpdates).toBe(1)
    expect(afterStats.materializations - beforeStats.materializations).toBe(1)
  })

  it('快照重新解析后不重建未变的展示条目', () => {
    const first = item('item_1', '历史回答')
    const second = item('item_2', '工具结果')
    const projection = new ConversationPresentationIndex([first, second])
    const before = projection.getSnapshot()
    const beforeStats = projection.getStats()

    projection.replaceItems([
      { ...first, metadata: { ...first.metadata } },
      { ...second, metadata: { ...second.metadata } },
    ])

    expect(projection.getSnapshot()).toBe(before)
    expect(projection.getSnapshot()[0]).toBe(before[0])
    expect(projection.getSnapshot()[1]).toBe(before[1])
    expect(projection.getStats()).toEqual(beforeStats)
  })

  it('工具结果只更新同 callId 展示条目', () => {
    const preamble = item('item_message', '正在查询')
    const call = toolItem('item_call', 'function_call', 'call_1')
    const projection = new ConversationPresentationIndex([preamble, call])
    const before = projection.getSnapshot()

    projection.replaceItems([
      preamble,
      call,
      {
        ...toolItem('item_output', 'function_call_output', 'call_1'),
        output: JSON.stringify({ summary: '查询完成' }),
      },
    ])

    const after = projection.getSnapshot()
    expect(after).toHaveLength(2)
    expect(after[0]).toBe(before[0])
    expect(after[1]).not.toBe(before[1])
    expect(after[1]?.body).toBe('查询完成')
  })
})

describe('ConversationTimelineProjectionStore', () => {
  it('在 React render 之外替换来源并且没有变化时不发布', () => {
    const canonical = { ...item('canonical', '历史'), timestamp: '2026-08-31T00:00:00.000Z' }
    const live = { ...item('live', '实时', 'running'), timestamp: '2026-08-31T00:00:01.000Z' }
    const projection = new ConversationTimelineProjectionStore([canonical], [live])
    const listener = vi.fn()
    projection.subscribe(listener)
    const before = projection.getSnapshot()

    projection.replaceSources([canonical], [live])
    expect(projection.getSnapshot()).toBe(before)
    expect(listener).not.toHaveBeenCalled()

    projection.replaceSources(
      [{ ...canonical, metadata: { ...canonical.metadata } }],
      [{ ...live, metadata: { ...live.metadata } }],
    )
    expect(projection.getSnapshot()).toBe(before)
    expect(projection.getSnapshot()[0]).toBe(canonical)
    expect(projection.getSnapshot()[1]).toBe(live)
    expect(listener).not.toHaveBeenCalled()

    projection.replaceSources([canonical], [{ ...live, body: '实时文本' }])
    expect(projection.getSnapshot()).not.toBe(before)
    expect(projection.getSnapshot().map(current => current.body)).toEqual(['历史', '实时文本'])
    expect(listener).toHaveBeenCalledOnce()
  })
})

function item(
  itemId: string,
  body: string,
  status: ConversationItem['status'] = 'completed',
): ConversationItem {
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
    status,
    metadata: {},
    timestamp: `2026-08-31T00:00:0${itemId.length}.000Z`,
  }
}

function toolItem(
  itemId: string,
  itemType: 'function_call' | 'function_call_output',
  callId: string,
): ConversationItem {
  return {
    ...item(itemId, ''),
    itemType,
    callId,
    name: 'query_weather',
    arguments: itemType === 'function_call' ? '{}' : null,
    output: itemType === 'function_call_output' ? '' : null,
  }
}
