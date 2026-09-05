// +-------------------------------------------------------------------------
//
//   地理智能平台 - 增量对话投影索引测试
//
//   文件:       projection.test.ts
//
//   日期:       2026年08月04日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6
// --------------------------------------------------------------------------

import type { ConversationItem, ConversationItemTextDelta } from '@geo-agent-platform/shared-types'
import { describe, expect, it } from 'vitest'

import { ConversationProjectionIndex } from './projection.js'

describe('ConversationProjectionIndex', () => {
  it('upserts live transcript items over canonical items without duplicating them', () => {
    const canonical = makeItem({
      itemId: 'canonical-1',
      body: '旧内容',
      metadata: { transcriptEntryId: 'entry-1', transcriptSeq: 1 },
    })
    const live = makeItem({
      itemId: 'live-1',
      body: '流式内容',
      metadata: { transcriptEntryId: 'entry-1', transcriptSeq: 1 },
    })
    const projection = new ConversationProjectionIndex([canonical])

    projection.upsert(live, 'live')

    expect(projection.toArray()).toEqual([live])
    expect(projection.getIndexSnapshot().transcriptEntryIndex.get('entry-1')).toBe('live-1')
  })

  it('keeps same-source assistant preambles and moves them before late tool calls', () => {
    const tool = makeItem({
      itemId: 'tool-1',
      itemType: 'function_call',
      callId: 'call-1',
      name: 'query_public_weather',
      timestamp: '2026-08-04T00:00:01.000Z',
    })
    const preamble = makeItem({
      itemId: 'preamble-1',
      role: 'assistant',
      body: '我先查询天气。',
      metadata: { assistantContentForCallId: 'call-1' },
      timestamp: '2026-08-04T00:00:02.000Z',
    })
    const projection = new ConversationProjectionIndex()

    projection.upsert(tool, 'live')
    projection.upsert(preamble, 'live')

    expect(projection.toArray().map(item => item.itemId)).toEqual(['preamble-1', 'tool-1'])
  })

  it('keeps the binary-search index sorted after projecting a preamble before its tool', () => {
    const tool = makeItem({
      itemId: 'tool-1',
      itemType: 'function_call',
      callId: 'call-1',
      name: 'query_public_weather',
      timestamp: '2026-08-04T00:00:01.000Z',
    })
    const preamble = makeItem({
      itemId: 'preamble-1',
      role: 'assistant',
      body: '我先查询天气。',
      metadata: { assistantContentForCallId: 'call-1' },
      timestamp: '2026-08-04T00:00:02.000Z',
    })
    const laterInsertion = makeItem({
      itemId: 'result-1',
      itemType: 'result',
      body: '查询已开始。',
      timestamp: '2026-08-04T00:00:01.500Z',
    })
    const projection = new ConversationProjectionIndex()

    projection.upsert(tool, 'live')
    projection.upsert(preamble, 'live')
    expect(projection.toArray().map(item => item.itemId)).toEqual(['preamble-1', 'tool-1'])

    projection.upsert(laterInsertion, 'live')

    expect(projection.getIndexSnapshot().orderedIds).toEqual(['tool-1', 'result-1', 'preamble-1'])
    expect(projection.toArray().map(item => item.itemId)).toEqual(['preamble-1', 'tool-1', 'result-1'])
  })

  it('hides all canonical items sharing an overlaid transcript entry', () => {
    const canonicalPreamble = makeItem({
      itemId: 'canonical-preamble',
      body: '先查询。',
      metadata: { transcriptEntryId: 'entry-1', assistantContentForCallId: 'call-1' },
    })
    const canonicalTool = makeItem({
      itemId: 'canonical-tool',
      itemType: 'function_call',
      callId: 'call-1',
      name: 'query_public_weather',
      metadata: { transcriptEntryId: 'entry-1' },
    })
    const live = makeItem({
      itemId: 'live-tool',
      body: '实时工具',
      metadata: { transcriptEntryId: 'entry-1' },
    })
    const projection = new ConversationProjectionIndex([canonicalPreamble, canonicalTool])

    projection.upsert(live, 'live')

    expect(projection.toArray().map(item => item.itemId)).toEqual(['live-tool'])
  })

  it('replaces a source incrementally and preserves a live overlay', () => {
    const canonical = makeItem({ itemId: 'canonical-1', body: '历史消息' })
    const live = makeItem({ itemId: 'live-1', body: '实时消息' })
    const projection = new ConversationProjectionIndex([canonical])
    projection.upsert(live, 'live')

    projection.replaceSource('canonical', [])

    expect(projection.toArray()).toEqual([live])
  })

  it('reuses unchanged parsed items and the materialized snapshot', () => {
    const canonical = makeItem({
      itemId: 'canonical-1',
      body: '历史消息',
      metadata: { nested: { second: 2, first: 1 } },
    })
    const projection = new ConversationProjectionIndex([canonical])
    const before = projection.toArray()
    const beforeStats = projection.getStats()

    projection.replaceSource('canonical', [{
      ...canonical,
      metadata: { nested: { first: 1, second: 2 } },
    }])

    expect(projection.toArray()).toBe(before)
    expect(projection.toArray()[0]).toBe(canonical)
    expect(projection.getStats().upserts).toBe(beforeStats.upserts)
  })

  it('restores the canonical item when its live overlay is removed', () => {
    const canonical = makeItem({
      itemId: 'canonical-1',
      body: '历史消息',
      metadata: { transcriptEntryId: 'entry-1' },
    })
    const live = makeItem({
      itemId: 'live-1',
      body: '实时消息',
      metadata: { transcriptEntryId: 'entry-1' },
    })
    const projection = new ConversationProjectionIndex([canonical])
    projection.upsert(live, 'live')

    projection.replaceSource('live', [])

    expect(projection.toArray()).toEqual([canonical])
  })

  it('restores same-id canonical items even without transcript metadata', () => {
    const canonical = makeItem({ itemId: 'same-id', body: '历史消息' })
    const live = makeItem({ itemId: 'same-id', body: '实时消息' })
    const projection = new ConversationProjectionIndex([canonical])
    projection.upsert(live, 'live')

    projection.replaceSource('live', [])

    expect(projection.toArray()).toEqual([canonical])
  })

  it.each([100, 1_000, 5_000])('indexes %s streamed items without per-item materialization', count => {
    const projection = new ConversationProjectionIndex()
    for (let index = 0; index < count; index += 1) {
      projection.upsert(makeItem({
        itemId: `item-${index.toString().padStart(5, '0')}`,
        body: `消息 ${index}`,
        timestamp: new Date(1_700_000_000_000 + index).toISOString(),
      }), 'live')
    }

    const beforeMaterialize = projection.getStats()
    expect(beforeMaterialize.materializations).toBe(0)
    expect(projection.toArray()).toHaveLength(count)
    expect(projection.getStats().materializations).toBe(1)
    expect(projection.getStats().comparisons).toBeLessThan(count * 16)
  })

  it('appends contiguous text deltas in place without removing or re-sorting the item', () => {
    const projection = new ConversationProjectionIndex([
      makeItem({ itemId: 'streamed', runId: 'run-1', body: '', status: 'running' }),
    ], 'live')
    const before = projection.getStats()

    expect(projection.appendTextDelta(delta({ sequence: 1, utf16Offset: 0, text: '杭州' }))).toBe('applied')
    expect(projection.appendTextDelta(delta({ sequence: 2, utf16Offset: 2, text: '有雨' }))).toBe('applied')

    expect(projection.toArray()[0]?.body).toBe('杭州有雨')
    expect(projection.getStats().removals).toBe(before.removals)
    expect(projection.getIndexSnapshot().orderedIds).toEqual(['streamed'])
  })

  it('deduplicates replayed deltas and reports sequence, offset, and content gaps explicitly', () => {
    const projection = new ConversationProjectionIndex([
      makeItem({ itemId: 'streamed', runId: 'run-1', body: '杭州', status: 'running' }),
    ], 'live')

    expect(projection.appendTextDelta(delta({ sequence: 7, utf16Offset: 0, text: '杭州' }))).toBe('duplicate')
    expect(projection.appendTextDelta(delta({ sequence: 8, utf16Offset: 2, text: '有雨' }))).toBe('applied')
    expect(projection.appendTextDelta(delta({ sequence: 10, utf16Offset: 4, text: '。' }))).toBe('sequence_gap')
    expect(projection.appendTextDelta(delta({ sequence: 9, utf16Offset: 8, text: '。' }))).toBe('offset_gap')
    expect(projection.appendTextDelta(delta({ sequence: 7, utf16Offset: 0, text: '上海' }))).toBe('content_conflict')
    expect(projection.toArray()[0]?.body).toBe('杭州有雨')
  })

  it('appends only body and never invents an output-field stream', () => {
    const projection = new ConversationProjectionIndex([
      makeItem({
        itemId: 'streamed', runId: 'run-1', itemType: 'function_call_output',
        body: '', output: 'durable-output', status: 'running',
      }),
    ], 'live')

    expect(projection.appendTextDelta(delta({ sequence: 1, utf16Offset: 0, text: '正文' })))
      .toBe('applied')
    expect(projection.toArray()[0]).toMatchObject({ body: '正文', output: 'durable-output' })
  })
})

function delta(
  overrides: Pick<ConversationItemTextDelta, 'sequence' | 'utf16Offset' | 'text'>,
): ConversationItemTextDelta {
  return {
    updateType: 'text_delta',
    schemaVersion: 1,
    streamId: 'stream-1',
    runId: 'run-1',
    threadId: 'thread-1',
    itemId: 'streamed',
    ...overrides,
  }
}

function makeItem(overrides: Partial<ConversationItem>): ConversationItem {
  return {
    itemId: 'item-1',
    itemType: 'message',
    runId: 'run-1',
    threadId: 'thread-1',
    turnId: 'turn-1',
    callId: null,
    role: 'assistant',
    body: null,
    name: null,
    arguments: null,
    output: null,
    isError: false,
    phase: null,
    status: 'completed',
    metadata: {},
    timestamp: '2026-08-04T00:00:00.000Z',
    ...overrides,
  }
}
