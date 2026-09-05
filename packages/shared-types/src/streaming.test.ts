// +-------------------------------------------------------------------------
//
//   地理智能平台 - ConversationItem 流式协议测试
//
//   文件:       streaming.test.ts
//
//   日期:       2026年08月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'
import {
  conversationItemTextDeltaSchema,
  runItemStreamSnapshotSchema,
  runItemUpsertSchema,
  wsRunPushSchema,
} from './transport.js'

describe('conversation item streaming protocol', () => {
  const delta = {
    updateType: 'text_delta' as const,
    schemaVersion: 1 as const,
    streamId: 'stream_1',
    runId: 'run_1',
    threadId: 'thread_1',
    itemId: 'item_1',
    sequence: 2,
    utf16Offset: 4,
    text: '有雨',
  }

  it('accepts a strict, correlated run.item.delta envelope', () => {
    expect(wsRunPushSchema.parse({
      type: 'run.item.delta',
      id: null,
      payload: { data: delta },
    }).payload.data).toEqual(delta)
  })

  it('rejects empty, negative, or unsequenced deltas', () => {
    const { streamId: _streamId, ...withoutStream } = delta
    expect(conversationItemTextDeltaSchema.safeParse(withoutStream).success).toBe(false)
    expect(conversationItemTextDeltaSchema.safeParse({ ...delta, text: '' }).success).toBe(false)
    expect(conversationItemTextDeltaSchema.safeParse({ ...delta, utf16Offset: -1 }).success).toBe(false)
    expect(conversationItemTextDeltaSchema.safeParse({ ...delta, sequence: 0 }).success).toBe(false)
  })

  it('requires full item pushes to carry the stream cursor wrapper', () => {
    const item = {
      itemId: 'item_1', itemType: 'message' as const, runId: 'run_1', threadId: 'thread_1',
      turnId: null, callId: null, role: 'assistant' as const, body: '杭州', name: null,
      arguments: null, output: null, isError: false, phase: null, status: 'running' as const,
      metadata: {}, timestamp: '2026-08-08T00:00:00.000Z',
    }
    const update = {
      updateType: 'item_upsert' as const,
      schemaVersion: 1 as const,
      streamId: 'stream_1',
      cursor: { sequence: 3, utf16Offset: 2 },
      item,
    }

    expect(wsRunPushSchema.safeParse({
      type: 'run.item', id: null, payload: { data: update },
    }).success).toBe(true)
    expect(wsRunPushSchema.safeParse({
      type: 'run.item', id: null, payload: { data: item },
    }).success).toBe(false)
    expect(runItemUpsertSchema.safeParse({ ...update, cursor: { sequence: -1, utf16Offset: 2 } }).success)
      .toBe(false)
    expect(runItemUpsertSchema.safeParse({ ...update, cursor: { sequence: 3, utf16Offset: 1 } }).success)
      .toBe(false)
    expect(runItemUpsertSchema.safeParse({ ...update, unexpected: true }).success).toBe(false)
  })

  it('requires snapshots to identify one stream and one cursor per item', () => {
    expect(runItemStreamSnapshotSchema.safeParse({
      streamId: 'stream_1',
      cursors: [{ itemId: 'item_1', sequence: 2, utf16Offset: 4 }],
    }).success).toBe(true)
    expect(runItemStreamSnapshotSchema.safeParse({
      cursors: [{ itemId: 'item_1', sequence: 2, utf16Offset: 4 }],
    }).success).toBe(false)
    expect(runItemStreamSnapshotSchema.safeParse({
      streamId: 'stream_1',
      cursors: [{ itemId: 'item_1', sequence: 2, utf16Offset: 4, extra: true }],
    }).success).toBe(false)
    expect(runItemStreamSnapshotSchema.safeParse({
      streamId: 'stream_1',
      cursors: [
        { itemId: 'item_1', sequence: 1, utf16Offset: 2 },
        { itemId: 'item_1', sequence: 2, utf16Offset: 4 },
      ],
    }).success).toBe(false)
  })
})
