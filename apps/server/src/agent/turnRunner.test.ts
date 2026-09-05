// +-------------------------------------------------------------------------
//
//   地理智能平台 - 单轮运行投影测试
//
//   文件:       turnRunner.test.ts
//
//   日期:       2026年06月23日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

// 这些测试约束 ConversationItem 的 UI 时间线语义。timestamp 表示首次出现
// 的位置，流式完成和 transcript 身份回填不得把旧消息移动到工具后面。

import { describe, expect, it } from 'vitest'
import type {
  ConversationItem,
  RunEvent,
} from '../schemas/types.js'
import type {
  AppendConversationItemBody,
  ConversationItemWrite,
  ReplaceConversationItem,
} from '../conversation/itemUpdates.js'
import { InMemoryEventBus } from '../store/eventBus.js'
import { ItemSink } from '../conversation/itemSink.js'
import { RunEventSink, TurnFinalizer } from './turnRunner.js'

describe('ItemSink', () => {
  it('binds every new ConversationItem to the resolved Turn identity', async () => {
    const items: ConversationItem[] = []
    const sink = new ItemSink((update) => {
      if (isItemReplacement(update)) items.push(update.item)
    }, 'run_1', 'thread_1', 'turn_resolved')

    sink.appendUserMessage('问题')
    sink.appendAssistantMessage('直接回答')
    const reasoning = sink.startItem('reasoning')
    sink.completeItem(reasoning.itemId)
    sink.appendResult('success')
    await sink.flush()

    expect(items).not.toHaveLength(0)
    expect(items.every(item => item.turnId === 'turn_resolved')).toBe(true)
  })

  it('publishes start/final items and an ordered text delta without cumulative snapshots', async () => {
    const updates: ConversationItemWrite[] = []
    const sink = new ItemSink(update => updates.push(update), 'run_1', 'thread_1', 'turn_1')
    sink.startItem('message', { itemId: 'item_1', role: 'assistant' })
    sink.deltaItem('item_1', '你')
    sink.deltaItem('item_1', '好')
    sink.completeItem('item_1')
    await sink.flush()

    const items = updates.filter(isItemReplacement).map(update => update.item)
    const deltas = updates.filter(isBodyAppend)
    expect(items).toHaveLength(2)
    expect(items[0].status).toBe('running')
    expect(deltas).toEqual([
      expect.objectContaining({ itemId: 'item_1', text: '你' }),
      expect.objectContaining({ itemId: 'item_1', text: '好' }),
    ])
    expect(items[1].status).toBe('completed')
    expect(items[1].body).toBe('你好')
    expect(new Set(items.map(item => item.timestamp)).size).toBe(1)
  })

  it('keeps 32 KiB streaming transport linear while preserving the exact final text', async () => {
    const updates: ConversationItemWrite[] = []
    const sink = new ItemSink(update => updates.push(update), 'run_1', 'thread_1', 'turn_1')
    const expected = '0123456789abcdef'.repeat(2_048)
    sink.startItem('message', { itemId: 'item_large', role: 'assistant' })
    for (let offset = 0; offset < expected.length; offset += 16) {
      sink.deltaItem('item_large', expected.slice(offset, offset + 16))
    }
    sink.completeItem('item_large')
    await sink.flush()

    const items = updates.filter(isItemReplacement).map(update => update.item)
    const deltas = updates.filter(isBodyAppend)
    expect(deltas).toHaveLength(2_048)
    expect(deltas.map(delta => delta.text).join('')).toBe(expected)
    expect(items.at(-1)?.body).toBe(expected)
    expect(deltas.reduce(
      (total, delta) => total + Buffer.byteLength(delta.text, 'utf8'),
      0,
    )).toBe(Buffer.byteLength(expected, 'utf8'))
  })

  it('splits one oversized Unicode delta at a bounded UTF-8 frame without delaying it', async () => {
    const updates: ConversationItemWrite[] = []
    const sink = new ItemSink(update => updates.push(update), 'run_1', 'thread_1', 'turn_1')
    const expected = '🌧️杭州'.repeat(4_000)
    sink.startItem('message', { itemId: 'item_unicode', role: 'assistant' })
    sink.deltaItem('item_unicode', expected)
    sink.completeItem('item_unicode')
    await sink.flush()

    const deltas = updates.filter(isBodyAppend)
    expect(deltas.length).toBeGreaterThan(1)
    expect(deltas.every(delta => Buffer.byteLength(delta.text, 'utf8') <= 16 * 1024)).toBe(true)
    expect(deltas.map(delta => delta.text).join('')).toBe(expected)
    expect(updates.filter(isItemReplacement).at(-1)?.item.body).toBe(expected)
  })

  it('keeps streamed whitespace exact even when a secondary accumulator disagrees', async () => {
    const updates: ConversationItemWrite[] = []
    const sink = new ItemSink(update => updates.push(update), 'run_1', 'thread_1', 'turn_1')
    sink.startItem('message', { itemId: 'item_whitespace', role: 'assistant' })
    sink.deltaItem('item_whitespace', ' 结论。\n')

    const completed = sink.completeItem('item_whitespace', { body: '结论。' })
    await sink.flush()

    expect(completed.body).toBe(' 结论。\n')
    expect(updates.filter(isItemReplacement).at(-1)?.item.body).toBe(' 结论。\n')
  })

  it('keeps item order stable when metadata is linked after completion', async () => {
    const items: ConversationItem[] = []
    const sink = new ItemSink((update) => {
      if (isItemReplacement(update)) items.push(update.item)
    }, 'run_1', 'thread_1', 'turn_1')

    const assistant = sink.startItem('message', { itemId: 'assistant_1', role: 'assistant' })
    sink.deltaItem(assistant.itemId, '先说明。')
    sink.completeItem(assistant.itemId)
    const tool = sink.startItem('function_call', { itemId: 'tool_1', role: 'assistant', name: 'map_export', callId: 'call_1' })
    sink.completeItem(tool.itemId, { output: '{"ok":true}' })
    sink.completeItem(assistant.itemId, {
      body: '先说明。',
      metadata: { transcriptEntryId: 'entry_1' },
    })
    await sink.flush()

    const latest = new Map(items.map(item => [item.itemId, item]))
    const sorted = [...latest.values()].sort((left, right) => left.timestamp.localeCompare(right.timestamp))
    expect(sorted.map(item => item.itemId)).toEqual(['assistant_1', 'tool_1'])
    expect(sorted[0].metadata.transcriptEntryId).toBe('entry_1')
    expect(sorted[0].timestamp).toBe(items[0].timestamp)
  })

  it('serializes durable writes and exposes the first failure through flush', async () => {
    const order: string[] = []
    let releaseFirst: (() => void) | null = null
    const firstWrite = new Promise<void>(resolve => { releaseFirst = resolve })
    const sink = new ItemSink(async update => {
      const itemId = update.updateType === 'replace_item' ? update.item.itemId : update.itemId
      order.push(`start:${itemId}`)
      if (itemId === 'item_1') await firstWrite
      if (itemId === 'item_2') throw new Error('database write failed')
      order.push(`end:${itemId}`)
    }, 'run_1', 'thread_1', 'turn_1')

    sink.startItem('message', { itemId: 'item_1' })
    sink.startItem('message', { itemId: 'item_2' })
    sink.startItem('message', { itemId: 'item_3' })
    await Promise.resolve()
    expect(order).toEqual(['start:item_1'])
    releaseFirst?.()

    await expect(sink.flush()).rejects.toThrow('database write failed')
    expect(order).toEqual(['start:item_1', 'end:item_1', 'start:item_2'])
  })
})

describe('TurnFinalizer', () => {
  it('marks terminal result items with a resultType for the web run state', async () => {
    const eventBus = new InMemoryEventBus<RunEvent>()
    const itemBus = new InMemoryEventBus<ConversationItem>()
    const items: ConversationItem[] = []
    itemBus.subscribe('run_1', (item) => items.push(item))

    const finalizer = new TurnFinalizer(
      new RunEventSink((event) => eventBus.publish(event.runId, event), 'run_1', 'thread_1'),
      new ItemSink((update) => {
        if (isItemReplacement(update)) itemBus.publish(update.item.runId, update.item)
      }, 'run_1', 'thread_1', 'turn_1'),
      () => undefined,
    )

    await finalizer.complete()

    expect(items).toHaveLength(1)
    expect(items[0].itemType).toBe('result')
    expect(items[0].body).toBeNull()
    expect(items[0].metadata.resultType).toBe('success')
  })
})

function isBodyAppend(update: ConversationItemWrite): update is AppendConversationItemBody {
  return update.updateType === 'append_body'
}

function isItemReplacement(update: ConversationItemWrite): update is ReplaceConversationItem {
  return update.updateType === 'replace_item'
}
