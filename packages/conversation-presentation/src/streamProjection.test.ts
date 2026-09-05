// +-------------------------------------------------------------------------
//
//   地理智能平台 - 跨端运行实时流一致性投影测试
//
//   文件:       streamProjection.test.ts
//
//   日期:       2026年08月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type {
  ConversationItem,
  ConversationItemTextDelta,
  RunItemStreamSnapshot,
  RunItemUpsert,
} from '@geo-agent-platform/shared-types'
import { describe, expect, it } from 'vitest'

import { RunStreamProjection } from './streamProjection.js'

describe('RunStreamProjection cursor authority', () => {
  it('does not let an older snapshot from the same stream roll text back', () => {
    const projection = new RunStreamProjection()
    projection.beginSnapshot()
    projection.acceptSnapshot(
      [item({ body: '杭州', status: 'running' })],
      stream('stream_1', [{ itemId: 'item_1', sequence: 2, utf16Offset: 2 }]),
    )

    projection.beginSnapshot()
    const accepted = projection.acceptSnapshot(
      [item({ body: '杭', status: 'running' })],
      stream('stream_1', [{ itemId: 'item_1', sequence: 1, utf16Offset: 1 }]),
    )

    expect(accepted.consistent).toBe(true)
    expect(accepted.items).toContainEqual(expect.objectContaining({ body: '杭州' }))
  })

  it('rejects a same-sequence snapshot whose content conflicts with local state', () => {
    const projection = new RunStreamProjection()
    projection.beginSnapshot()
    projection.acceptSnapshot(
      [item({ body: '杭州', status: 'running' })],
      stream('stream_1', [{ itemId: 'item_1', sequence: 2, utf16Offset: 2 }]),
    )

    projection.beginSnapshot()
    const accepted = projection.acceptSnapshot(
      [item({ body: '上海', status: 'running' })],
      stream('stream_1', [{ itemId: 'item_1', sequence: 2, utf16Offset: 2 }]),
    )

    expect(accepted.consistent).toBe(false)
    expect(accepted.items[0]?.body).toBe('杭州')
  })

  it('treats a different stream snapshot as an authoritative reset', () => {
    const projection = new RunStreamProjection()
    projection.beginSnapshot()
    projection.acceptSnapshot(
      [item({ body: '旧进程文本', status: 'running' })],
      stream('stream_old', [{ itemId: 'item_1', sequence: 3, utf16Offset: 5 }]),
    )

    projection.beginSnapshot()
    const accepted = projection.acceptSnapshot([], stream('stream_new', []))

    expect(accepted).toEqual({ items: [], consistent: true })
  })

  it('preserves unchanged item identity across an authoritative reconnect snapshot', () => {
    const projection = new RunStreamProjection()
    const original = item({ body: '已完成的历史回答', status: 'completed' })
    projection.beginSnapshot()
    projection.acceptSnapshot(
      [original],
      stream('stream_old', [{ itemId: 'item_1', sequence: 4, utf16Offset: 8 }]),
    )
    const before = projection.toArray()

    projection.beginSnapshot()
    const accepted = projection.acceptSnapshot(
      [{ ...original, metadata: { ...original.metadata } }],
      stream('stream_new', [{ itemId: 'item_1', sequence: 0, utf16Offset: 8 }]),
    )

    expect(accepted.consistent).toBe(true)
    expect(accepted.items[0]).toBe(before[0])
    expect(accepted.items[0]).toBe(original)
  })

  it('uses JavaScript UTF-16 offsets for astral Unicode text', () => {
    const projection = seededProjection()

    expect(projection.acceptDelta(delta({ sequence: 1, utf16Offset: 0, text: '🌧️' })))
      .toBe('applied')
    expect(projection.acceptDelta(delta({ sequence: 2, utf16Offset: 3, text: '杭州' })))
      .toBe('applied')
    expect(projection.toArray()[0]?.body).toBe('🌧️杭州')
  })

  it('lets a self-contained full upsert heal a gap and rejects older deltas afterward', () => {
    const projection = seededProjection()

    expect(projection.acceptDelta(delta({ sequence: 2, utf16Offset: 1, text: '丢帧后文本' })))
      .toBe('sequence_gap')
    expect(projection.acceptItem(upsert(item({ body: '最终回答', status: 'completed' }), 3)))
      .toBe('applied')
    expect(projection.acceptDelta(delta({ sequence: 2, utf16Offset: 1, text: '迟到' })))
      .toBe('duplicate')
    expect(projection.acceptDelta(delta({ sequence: 4, utf16Offset: 4, text: '错误续写' })))
      .toBe('terminal_item')
    expect(projection.acceptItem(upsert(item({ body: '重新运行', status: 'running' }), 4)))
      .toBe('state_regression')
    expect(projection.toArray()[0]).toMatchObject({ body: '最终回答', status: 'completed' })
  })

  it('treats conflicting updates at the current sequence as protocol corruption', () => {
    const projection = seededProjection()
    expect(projection.acceptDelta(delta({ sequence: 1, utf16Offset: 0, text: '杭州' })))
      .toBe('applied')

    expect(projection.acceptDelta(delta({ sequence: 1, utf16Offset: 0, text: '上海' })))
      .toBe('cursor_conflict')
    expect(projection.acceptItem(upsert(item({ body: '上海', status: 'running' }), 1)))
      .toBe('cursor_conflict')
    expect(projection.toArray()[0]?.body).toBe('杭州')
  })

  it('exits buffering after a failed snapshot and preserves queued exact updates', () => {
    const projection = seededProjection()
    projection.beginSnapshot()
    expect(projection.acceptDelta(delta({ sequence: 1, utf16Offset: 0, text: '杭州' })))
      .toBe('queued')

    const aborted = projection.abortSnapshot()

    expect(aborted).toEqual({
      consistent: true,
      items: [expect.objectContaining({ body: '杭州' })],
    })
    expect(projection.acceptDelta(delta({ sequence: 2, utf16Offset: 2, text: '有雨' })))
      .toBe('applied')
  })
})

function seededProjection(): RunStreamProjection {
  const projection = new RunStreamProjection()
  projection.beginSnapshot()
  projection.acceptSnapshot(
    [item({ status: 'running' })],
    stream('stream_1', [{ itemId: 'item_1', sequence: 0, utf16Offset: 0 }]),
  )
  return projection
}

function item(overrides: Partial<ConversationItem> = {}): ConversationItem {
  return {
    itemId: 'item_1', itemType: 'message', runId: 'run_1', threadId: 'thread_1',
    turnId: null, callId: null, role: 'assistant', body: '', name: null,
    arguments: null, output: null, isError: false, phase: null, status: 'running',
    metadata: {}, timestamp: '2026-08-08T00:00:00.000Z', ...overrides,
  }
}

function delta(
  overrides: Pick<ConversationItemTextDelta, 'sequence' | 'utf16Offset' | 'text'>,
): ConversationItemTextDelta {
  return {
    updateType: 'text_delta', schemaVersion: 1, streamId: 'stream_1',
    runId: 'run_1', threadId: 'thread_1', itemId: 'item_1', ...overrides,
  }
}

function upsert(itemValue: ConversationItem, sequence: number): RunItemUpsert {
  return {
    updateType: 'item_upsert', schemaVersion: 1, streamId: 'stream_1',
    cursor: { sequence, utf16Offset: (itemValue.body ?? '').length },
    item: itemValue,
  }
}

function stream(
  streamId: string,
  cursors: RunItemStreamSnapshot['cursors'],
): RunItemStreamSnapshot {
  return { streamId, cursors }
}
