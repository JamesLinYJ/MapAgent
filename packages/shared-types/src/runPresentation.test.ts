import { describe, expect, it } from 'vitest'

import {
  replayRunPresentationRecords,
  type RunPresentationRecord,
} from './runPresentation.js'

describe('Run presentation projection', () => {
  it('replays item updates and immutable event/value records from sequence zero', () => {
    const records = [
      record(1, 'item', item('running')),
      record(2, 'event', event()),
      record(3, 'item', item('completed')),
      record(4, 'value', value()),
      record(5, 'input.queued', { inputId: 'input_1' }),
    ]

    expect(replayRunPresentationRecords(records)).toMatchObject({
      runId: 'run_1',
      sourceSequence: 5,
      items: [{ itemId: 'item_1', status: 'completed' }],
      events: [{ eventId: 'event_1' }],
      values: [{ refId: 'value_1' }],
    })
  })

  it('accepts an identical immutable retry but rejects an ID collision', () => {
    expect(replayRunPresentationRecords([
      record(1, 'event', event()),
      record(2, 'event', event()),
    ])?.events).toHaveLength(1)

    expect(() => replayRunPresentationRecords([
      record(1, 'event', event()),
      record(2, 'event', { ...event(), message: 'different' }),
    ])).toThrow(/稳定 ID/u)
  })

  it('rejects gaps and unknown record kinds instead of silently projecting partial UI state', () => {
    expect(() => replayRunPresentationRecords([
      record(2, 'event', event()),
    ])).toThrow(/sequence 不连续/u)
    expect(() => replayRunPresentationRecords([
      record(1, 'legacy.event', event()),
    ])).toThrow(/未知展示记录类型/u)
  })
})

function record(
  sequence: number,
  recordType: string,
  payload: unknown,
): RunPresentationRecord {
  return {
    recordId: `record_${sequence}`,
    runId: 'run_1',
    threadId: 'thread_1',
    sequence,
    recordType,
    payload,
    createdAt: `2026-08-24T00:00:0${sequence}.000Z`,
  }
}

function item(status: string) {
  return {
    itemId: 'item_1',
    itemType: 'message',
    runId: 'run_1',
    threadId: 'thread_1',
    role: 'assistant',
    body: 'done',
    status,
    timestamp: '2026-08-24T00:00:00.000Z',
  }
}

function event() {
  return {
    eventId: 'event_1',
    runId: 'run_1',
    threadId: 'thread_1',
    type: 'trace.recorded',
    message: 'started',
    timestamp: '2026-08-24T00:00:00.000Z',
    payload: {},
  }
}

function value() {
  return {
    refId: 'value_1',
    kind: 'json',
    label: 'result',
    value: { ok: true },
  }
}
