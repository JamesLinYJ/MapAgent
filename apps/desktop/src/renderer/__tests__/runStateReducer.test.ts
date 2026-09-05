// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运行状态归约测试
//
//   文件:       runStateReducer.test.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'
import {
  analysisRunSchema,
  conversationItemSchema,
  runEventSchema,
  type AnalysisRun,
} from '@geo-agent-platform/shared-types'

import { runReducer, type RunState } from '../features/runs/useRunState'

describe('runReducer', () => {
  it('切换同一 thread 的新 run 时清空上一 run 的流式投影', () => {
    const previous = makeRun('run_previous', 'thread_1')
    const next = makeRun('run_next', 'thread_1')
    const event = runEventSchema.parse({
      eventId: 'event_previous',
      runId: previous.id,
      threadId: previous.threadId,
      type: 'step.started',
      message: '旧事件',
      timestamp: previous.createdAt,
    })
    const item = conversationItemSchema.parse({
      itemId: 'item_previous',
      itemType: 'message',
      runId: previous.id,
      threadId: previous.threadId,
      role: 'assistant',
      body: '旧消息',
      timestamp: previous.createdAt,
    })
    const state: RunState = {
      run: previous,
      projectionGeneration: 1,
      expectedRunId: previous.id,
      agentState: previous.state,
      events: [event],
      items: [item],
      artifacts: [],
      isSubmitting: false,
      seenEventIds: new Set([event.eventId]),
      placeResolution: { status: 'resolved', selected: { latitude: 30, longitude: 120 } },
    }

    const result = runReducer(state, {
      type: 'SET_RUN',
      runId: next.id,
      generation: 2,
      run: next,
      agentState: next.state,
      artifacts: [],
    })

    expect(result.run?.id).toBe('run_next')
    expect(result.items).toEqual([])
    expect(result.events).toEqual([])
    expect(result.seenEventIds.size).toBe(0)
    expect(result.placeResolution).toBeNull()
  })

  it('同一 run 的增量快照保留已经到达的流式内容', () => {
    const run = makeRun('run_1', 'thread_1')
    const state: RunState = {
      run,
      projectionGeneration: 1,
      expectedRunId: run.id,
      agentState: run.state,
      events: [],
      items: [],
      artifacts: [],
      isSubmitting: true,
      seenEventIds: new Set(),
    }

    const result = runReducer(state, {
      type: 'SET_RUN',
      runId: run.id,
      generation: 1,
      run: { ...run, status: 'completed' },
      agentState: run.state,
      artifacts: [],
    })

    expect(result.isSubmitting).toBe(false)
    expect(result.items).toBe(state.items)
    expect(result.events).toBe(state.events)
  })

  it('终止事件立即结束运行且迟到的活动快照不能让终态倒退', () => {
    const run = makeRun('run_1', 'thread_1')
    const state: RunState = {
      run,
      projectionGeneration: 1,
      expectedRunId: run.id,
      agentState: run.state,
      events: [],
      items: [],
      artifacts: [],
      isSubmitting: true,
      seenEventIds: new Set(),
    }
    const completed = runEventSchema.parse({
      eventId: 'event_completed',
      runId: run.id,
      threadId: run.threadId,
      type: 'run.completed',
      message: '运行完成',
      timestamp: '2026-07-10T00:00:01.000Z',
    })

    const afterEvent = runReducer(state, {
      type: 'APPEND_EVENT', runId: run.id, generation: 1, event: completed,
    })

    expect(afterEvent.run?.status).toBe('completed')
    expect(afterEvent.isSubmitting).toBe(false)

    const afterLateSnapshot = runReducer(afterEvent, {
      type: 'SET_RUN',
      runId: run.id,
      generation: 1,
      run: { ...run, updatedAt: '2026-07-10T00:00:00.500Z' },
      agentState: run.state,
      artifacts: [],
    })

    expect(afterLateSnapshot.run?.status).toBe('completed')
    expect(afterLateSnapshot.isSubmitting).toBe(false)
  })

  it('失败事件按照统一生命周期语义区分失败与取消', () => {
    const run = makeRun('run_1', 'thread_1')
    const state: RunState = {
      run,
      projectionGeneration: 1,
      expectedRunId: run.id,
      agentState: run.state,
      events: [],
      items: [],
      artifacts: [],
      isSubmitting: true,
      seenEventIds: new Set(),
    }
    const cancelled = runEventSchema.parse({
      eventId: 'event_cancelled',
      runId: run.id,
      threadId: run.threadId,
      type: 'run.failed',
      message: '运行已中断',
      timestamp: '2026-07-10T00:00:01.000Z',
      payload: { cancelled: true },
    })

    const result = runReducer(state, {
      type: 'APPEND_EVENT', runId: run.id, generation: 1, event: cancelled,
    })

    expect(result.run?.status).toBe('cancelled')
    expect(result.isSubmitting).toBe(false)
  })

  it('快照事件账本不会删除已到达的实时事件', () => {
    const run = makeRun('run_1', 'thread_1')
    const event = runEventSchema.parse({
      eventId: 'event_ledger',
      runId: run.id,
      threadId: run.threadId,
      type: 'step.completed',
      message: '已持久化事件',
      timestamp: '2026-07-10T00:00:01.000Z',
    })
    const state: RunState = {
      run,
      projectionGeneration: 1,
      expectedRunId: run.id,
      agentState: run.state,
      events: [],
      items: [],
      artifacts: [],
      isSubmitting: true,
      seenEventIds: new Set(),
    }

    const afterOldSnapshot = runReducer(state, {
      type: 'SET_EVENTS', runId: run.id, generation: 1, events: [],
    })
    const afterPush = runReducer(afterOldSnapshot, {
      type: 'APPEND_EVENT', runId: run.id, generation: 1, event,
    })
    const afterNewSnapshot = runReducer(afterPush, {
      type: 'SET_EVENTS', runId: run.id, generation: 1, events: [event],
    })

    expect(afterNewSnapshot.events.map(current => current.eventId)).toEqual([event.eventId])
    expect(afterNewSnapshot.seenEventIds.has(event.eventId)).toBe(true)
  })

  it('快速切换 A/B 后拒绝迟到 A 的快照与事件投影', () => {
    const previous = makeRun('run_a', 'thread_1')
    const next = makeRun('run_b', 'thread_1')
    const state: RunState = {
      run: previous,
      projectionGeneration: 1,
      expectedRunId: previous.id,
      agentState: previous.state,
      events: [],
      items: [],
      artifacts: [],
      isSubmitting: true,
      seenEventIds: new Set(),
    }
    const oldEvent = runEventSchema.parse({
      eventId: 'event_a', runId: previous.id, threadId: previous.threadId,
      type: 'step.completed', message: 'A 迟到事件', timestamp: previous.createdAt,
    })
    const nextEvent = runEventSchema.parse({
      eventId: 'event_b', runId: next.id, threadId: next.threadId,
      type: 'step.completed', message: 'B 当前事件', timestamp: next.createdAt,
    })
    const oldItem = conversationItemSchema.parse({
      itemId: 'item_a', itemType: 'message', runId: previous.id,
      threadId: previous.threadId, role: 'assistant', body: 'A 迟到文本',
      timestamp: previous.createdAt,
    })

    const afterSwitch = runReducer(state, {
      type: 'SET_RUN', runId: next.id, generation: 2,
      run: next, agentState: next.state, artifacts: [],
    })
    const afterLateEvent = runReducer(afterSwitch, {
      type: 'APPEND_EVENT', runId: previous.id, generation: 1, event: oldEvent,
    })
    const afterCurrentEvents = runReducer(afterLateEvent, {
      type: 'SET_EVENTS', runId: next.id, generation: 2, events: [oldEvent, nextEvent],
    })
    const afterLateRun = runReducer(afterCurrentEvents, {
      type: 'SET_RUN', runId: previous.id, generation: 1,
      run: previous, agentState: previous.state, artifacts: [],
    })
    const afterLateItems = runReducer(afterLateRun, {
      type: 'SET_PROJECTED_ITEMS', runId: previous.id, generation: 1, items: [oldItem],
    })

    expect(afterLateEvent).toBe(afterSwitch)
    expect(afterCurrentEvents.run?.id).toBe(next.id)
    expect(afterCurrentEvents.events).toEqual([nextEvent])
    expect(afterLateRun).toBe(afterCurrentEvents)
    expect(afterLateItems).toBe(afterCurrentEvents)
    expect(afterLateItems.items).toEqual([])
  })
})

function makeRun(runId: string, threadId: string): AnalysisRun {
  const now = '2026-07-10T00:00:00.000Z'
  return analysisRunSchema.parse({
    id: runId,
    threadId,
    sessionId: 'session_1',
    visibility: 'workspace',
    userQuery: '测试',
    status: 'running',
    createdAt: now,
    updatedAt: now,
    state: {
      sessionId: 'session_1',
      threadId,
      userQuery: '测试',
    },
  })
}
