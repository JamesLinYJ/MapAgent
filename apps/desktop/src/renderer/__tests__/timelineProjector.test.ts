// +-------------------------------------------------------------------------
//
//   地理智能平台 - 时间线投影器测试
//
//   文件:       timelineProjector.test.ts
//
//   日期:       2026年07月07日
//   作者:       JamesLinYJ
//   协助:       Claude Code:Opus 4.8
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'
import type { ConversationItem } from '@geo-agent-platform/shared-types'
import { projectTimeline } from '../features/conversation/timelineProjector'

function item(overrides: Partial<ConversationItem>): ConversationItem {
  return {
    itemId: 'item_test',
    itemType: 'message',
    role: 'user',
    runId: 'run_test',
    threadId: null,
    turnId: null,
    callId: null,
    timestamp: new Date().toISOString(),
    body: null,
    name: null,
    arguments: null,
    output: null,
    isError: false,
    phase: null,
    status: null,
    metadata: {},
    ...overrides,
  }
}

describe('projectTimeline', () => {
  it('returns empty array when both inputs are empty', () => {
    expect(projectTimeline([], [])).toEqual([])
  })

  it('returns canonical items when there is no live overlay', () => {
    const canonical = [
      item({ itemId: 'a', itemType: 'message', role: 'user', body: 'hello' }),
      item({ itemId: 'b', itemType: 'message', role: 'assistant', body: 'hi' }),
    ]
    const result = projectTimeline(canonical, [])
    expect(result).toHaveLength(2)
  })

  it('deduplicates canonical items when live overlay has matching transcriptEntryId', () => {
    const canonical = [
      item({
        itemId: 'old', itemType: 'message', role: 'assistant', body: 'stale text',
        metadata: { transcriptEntryId: 'entry_1' },
      }),
    ]
    const live = [
      item({
        itemId: 'old', itemType: 'message', role: 'assistant', body: 'fresh text',
        metadata: { transcriptEntryId: 'entry_1' },
      }),
    ]
    const result = projectTimeline(canonical, live)
    expect(result).toHaveLength(1)
    expect(result.at(0)?.body).toBe('fresh text')
  })

  it('sorts by timestamp, then transcriptSeq, then itemType rank, then itemId', () => {
    const base = new Date('2026-07-07T10:00:00Z').toISOString()
    const later = new Date('2026-07-07T10:01:00Z').toISOString()

    const items = [
      item({ itemId: 'z', itemType: 'message', role: 'user', timestamp: base }),
      item({ itemId: 'a', itemType: 'message', role: 'user', timestamp: later }),
      item({ itemId: 'm', itemType: 'reasoning', timestamp: base }),
    ]

    const result = projectTimeline(items, [])
    // a (later time) > m (reasoning rank 20) > z (user rank 10)
    expect(result.at(0)?.itemId).toBe('z')   // base time, user rank=10
    expect(result.at(1)?.itemId).toBe('m')   // base time, reasoning rank=20
    expect(result.at(2)?.itemId).toBe('a')   // later time
  })

  it('sorts by transcriptSeq when timestamps are equal', () => {
    const ts = new Date('2026-07-07T10:00:00Z').toISOString()
    const items = [
      item({ itemId: 'b', itemType: 'message', role: 'user', timestamp: ts, metadata: { transcriptSeq: 2 } }),
      item({ itemId: 'a', itemType: 'message', role: 'user', timestamp: ts, metadata: { transcriptSeq: 1 } }),
    ]
    const result = projectTimeline(items, [])
    expect(result.at(0)?.itemId).toBe('a')
    expect(result.at(1)?.itemId).toBe('b')
  })

  it('keeps canonical items without transcriptEntryId even when overlay exists', () => {
    const canonical = [
      item({ itemId: 'a', itemType: 'message', role: 'user', body: 'keep me' }),
    ]
    const live = [
      item({
        itemId: 'b', itemType: 'message', role: 'assistant', body: 'streaming',
        metadata: { transcriptEntryId: 'entry_2' },
      }),
    ]
    const result = projectTimeline(canonical, live)
    expect(result).toHaveLength(2)
    expect(result.some(r => r.body === 'keep me')).toBe(true)
    expect(result.some(r => r.body === 'streaming')).toBe(true)
  })

  it('preserves earlier thread messages when an approved run snapshot is hydrated', () => {
    const canonical = [
      item({
        itemId: 'transcript:old-user',
        itemType: 'message',
        role: 'user',
        runId: 'run_old',
        threadId: 'thread_1',
        body: '审批前的历史问题',
        metadata: { transcriptEntryId: 'old-user', transcriptSeq: 1 },
      }),
      item({
        itemId: 'transcript:old-answer',
        itemType: 'message',
        role: 'assistant',
        runId: 'run_old',
        threadId: 'thread_1',
        body: '审批前的历史回答',
        metadata: { transcriptEntryId: 'old-answer', transcriptSeq: 2 },
      }),
    ]
    const approvedRunSnapshot = [
      item({
        itemId: 'run-current-answer',
        itemType: 'message',
        role: 'assistant',
        runId: 'run_current',
        threadId: 'thread_1',
        body: '批准后继续执行的回答',
        metadata: { transcriptEntryId: 'current-answer', transcriptSeq: 3 },
      }),
    ]

    expect(projectTimeline(canonical, approvedRunSnapshot).map(entry => entry.body)).toEqual([
      '审批前的历史问题',
      '审批前的历史回答',
      '批准后继续执行的回答',
    ])
  })

  it('uses itemId as final tiebreaker when all other keys are equal', () => {
    const ts = new Date('2026-07-07T10:00:00Z').toISOString()
    const items = [
      item({ itemId: 'bbb', itemType: 'message', role: 'user', timestamp: ts }),
      item({ itemId: 'aaa', itemType: 'message', role: 'user', timestamp: ts }),
    ]
    const result = projectTimeline(items, [])
    expect(result.at(0)?.itemId).toBe('aaa')
    expect(result.at(1)?.itemId).toBe('bbb')
  })
})
