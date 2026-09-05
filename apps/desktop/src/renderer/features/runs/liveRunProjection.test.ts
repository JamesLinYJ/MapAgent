// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运行实时流一致性投影测试
//
//   文件:       liveRunProjection.test.ts
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
import { RunStreamProjection } from '@geo-agent-platform/conversation-presentation'
import { describe, expect, it } from 'vitest'

describe('RunStreamProjection', () => {
  it('replays subscription pushes on top of an earlier snapshot without losing text', () => {
    const projection = new RunStreamProjection()
    projection.beginSnapshot()
    projection.acceptItem(upsert(item({ body: '', status: 'running' }), 0))
    projection.acceptDelta(delta({ sequence: 1, utf16Offset: 0, text: '杭州' }))

    const accepted = projection.acceptSnapshot([], streamSnapshot([]))

    expect(accepted.consistent).toBe(true)
    expect(accepted.items).toContainEqual(expect.objectContaining({ body: '杭州' }))
  })

  it('deduplicates pushes already represented by the snapshot', () => {
    const projection = new RunStreamProjection()
    projection.beginSnapshot()
    projection.acceptItem(upsert(item({ body: '', status: 'running' }), 0))
    projection.acceptDelta(delta({ sequence: 1, utf16Offset: 0, text: '杭州' }))

    const snapshotItem = item({ body: '杭州', status: 'running' })
    const accepted = projection.acceptSnapshot([snapshotItem], streamSnapshot([
      { itemId: snapshotItem.itemId, sequence: 1, utf16Offset: 2 },
    ]))

    expect(accepted.consistent).toBe(true)
    expect(accepted.items).toHaveLength(1)
    expect(accepted.items[0]?.body).toBe('杭州')
  })

  it('marks an offset gap inconsistent so the caller can request an authoritative snapshot', () => {
    const projection = new RunStreamProjection()
    projection.beginSnapshot()
    projection.acceptDelta(delta({ sequence: 3, utf16Offset: 4, text: '有雨' }))

    const snapshotItem = item({ body: '杭', status: 'running' })
    const accepted = projection.acceptSnapshot([snapshotItem], streamSnapshot([
      { itemId: snapshotItem.itemId, sequence: 1, utf16Offset: 1 },
    ]))

    expect(accepted.consistent).toBe(false)
    expect(accepted.items[0]?.body).toBe('杭')
  })

  it('does not let a delayed running start overwrite a terminal item', () => {
    const projection = new RunStreamProjection()
    projection.beginSnapshot()
    projection.acceptItem(upsert(item({ body: '', status: 'running' }), 0))

    const snapshotItem = item({ body: '最终回答', status: 'completed' })
    const accepted = projection.acceptSnapshot([snapshotItem], streamSnapshot([
      { itemId: snapshotItem.itemId, sequence: 2, utf16Offset: 4 },
    ]))

    expect(accepted.items[0]).toMatchObject({ body: '最终回答', status: 'completed' })
  })
})

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
    runId: 'run_1', threadId: 'thread_1',
    itemId: 'item_1', ...overrides,
  }
}

function upsert(itemValue: ConversationItem, sequence: number): RunItemUpsert {
  return {
    updateType: 'item_upsert',
    schemaVersion: 1,
    streamId: 'stream_1',
    cursor: { sequence, utf16Offset: (itemValue.body ?? '').length },
    item: itemValue,
  }
}

function streamSnapshot(cursors: RunItemStreamSnapshot['cursors']): RunItemStreamSnapshot {
  return { streamId: 'stream_1', cursors }
}
